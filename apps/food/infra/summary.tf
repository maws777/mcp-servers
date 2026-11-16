# AI summaries (docs/design/food-dashboard.md, phase 4b):
#
#   dashboard Lambda --async invoke--> summary Lambda --> Bedrock (DeepSeek V3.2, Stockholm)
#   23:30 Europe/Paris schedule -----^       |
#                                            +--> summaries table (its own, written only here)
#
# The summary Lambda is the only component that shows meal descriptions to a
# model, so it's the one that can't change the journal: it reads the food
# table and writes only the summaries table.

locals {
  summary_name = "${local.name}-summary"

  # The model, called on demand in its own region (landing-zone ADR 0015):
  # DeepSeek V3.2 in Stockholm while Claude Haiku 5.5's quota is 0 in this
  # account. Changing it means changing these two values, and the workload
  # boundary must list the model (landing-zone modules/workload-ci).
  model_id     = "deepseek.v3.2"
  model_region = "eu-north-1"
}

# --- Data ----------------------------------------------------------------------

# Summaries, diary notes, daily quotas, the list of users to summarize at
# night. Rebuildable from the journal except the notes, so no point-in-time
# recovery; deletion protection still on.
resource "aws_dynamodb_table" "summaries" {
  name         = "${local.name}-summaries"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }

  # Quota counters carry expires_at; DynamoDB deletes them after it.
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  deletion_protection_enabled = true
}

# --- The summary Lambda ----------------------------------------------------------

data "archive_file" "summary" {
  type             = "zip"
  source_dir       = "${path.module}/../dist/summary"
  output_path      = "${path.module}/../build/summary.zip"
  output_file_mode = "0644"
}

resource "aws_iam_role" "summary" {
  name                 = local.summary_name
  path                 = "/mcp/"
  assume_role_policy   = data.aws_iam_policy_document.assume_lambda.json
  permissions_boundary = local.boundary_arn
}

data "aws_iam_policy_document" "summary" {
  # The journal: read only.
  statement {
    sid       = "ReadJournal"
    actions   = ["dynamodb:GetItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.food.arn]
  }
  # Its own table: no Delete, no Scan.
  statement {
    sid       = "Summaries"
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.summaries.arn]
  }
  # One model, in one region. Converse is authorized as bedrock:InvokeModel.
  # No streaming: the answer is a few lines.
  statement {
    sid       = "Model"
    actions   = ["bedrock:InvokeModel"]
    resources = ["arn:aws:bedrock:${local.model_region}::foundation-model/${local.model_id}"]
  }
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.summary.arn}:*"]
  }
}

resource "aws_iam_role_policy" "summary" {
  name   = "runtime"
  role   = aws_iam_role.summary.id
  policy = data.aws_iam_policy_document.summary.json
}

resource "aws_cloudwatch_log_group" "summary" {
  name              = "/aws/lambda/${local.summary_name}"
  retention_in_days = 14
}

resource "aws_lambda_function" "summary" {
  function_name    = local.summary_name
  role             = aws_iam_role.summary.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.summary.output_path
  source_code_hash = data.archive_file.summary.output_base64sha256
  memory_size      = 512
  timeout          = 120 # the nightly run summarizes users one after the other

  environment {
    variables = {
      TABLE_NAME         = aws_dynamodb_table.food.name
      SUMMARY_TABLE_NAME = aws_dynamodb_table.summaries.name
      MODEL_ID           = local.model_id
      MODEL_REGION       = local.model_region
      SUMMARIES_PER_DAY  = "20"
      DEFAULT_TIME_ZONE  = "Europe/Paris"
      NODE_OPTIONS       = "--enable-source-maps"
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.summary.name
  }

  depends_on = [aws_iam_role_policy.summary]
}

# Async invocations: one try, no retries. A failed summary isn't worth paying
# for twice; the next app open asks again.
resource "aws_lambda_function_event_invoke_config" "summary" {
  function_name                = aws_lambda_function.summary.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 300
}

# --- The nightly "close the day" run ---------------------------------------------

data "aws_iam_policy_document" "assume_scheduler" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    # Only schedules in this account (confused deputy).
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_iam_role" "close_day" {
  name                 = "${local.name}-close-day"
  path                 = "/mcp/"
  assume_role_policy   = data.aws_iam_policy_document.assume_scheduler.json
  permissions_boundary = local.boundary_arn
}

resource "aws_iam_role_policy" "close_day" {
  name = "invoke-summary"
  role = aws_iam_role.close_day.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.summary.arn
    }]
  })
}

resource "aws_scheduler_schedule" "close_day" {
  name        = "${local.name}-close-day"
  description = "Final summary and diary note of the day, for each user."
  state       = var.summary_schedule_enabled ? "ENABLED" : "DISABLED"

  schedule_expression          = "cron(30 23 * * ? *)"
  schedule_expression_timezone = "Europe/Paris" # follows summer/winter time

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.summary.arn
    role_arn = aws_iam_role.close_day.arn
    input    = jsonencode({ mode = "close-day" })

    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}

# --- The dashboard may read summaries and ask for a new one ------------------------

# Only these two, on top of its read-only journal access (dashboard.tf). It
# still can't call the model or write anything.
data "aws_iam_policy_document" "dashboard_summary" {
  statement {
    sid       = "ReadSummary"
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.summaries.arn]
  }
  statement {
    sid       = "RequestSummary"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.summary.arn]
  }
}

resource "aws_iam_role_policy" "dashboard_summary" {
  name   = "summaries"
  role   = aws_iam_role.dashboard.id
  policy = data.aws_iam_policy_document.dashboard_summary.json
}
