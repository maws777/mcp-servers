# Food tracker MCP server (docs/design/food-v1.md):
#   food.mcp.<env>.lab.michaelteplov.com -> API Gateway HTTP API -> Lambda -> DynamoDB
# plus its Cognito resource server and the claude.ai client.

locals {
  name         = "mcp-food-${var.environment}"
  domain       = "food.mcp.${var.environment}.${var.parent_zone}"
  resource_uri = "https://${local.domain}/mcp" # Cognito resource server identifier = MCP URL (spike 1)
  boundary_arn = "arn:aws:iam::${var.account_id}:policy/platform/mcp-workload-boundary"
  user_pool_id = one(data.aws_cognito_user_pools.main.ids)

  tags = {
    project      = "mcp-servers"
    "managed-by" = "terraform"
    environment  = var.environment
    app          = "food"
  }
}

data "aws_cognito_user_pools" "main" {
  name = var.user_pool_name
}

data "aws_route53_zone" "parent" {
  provider = aws.network
  name     = var.parent_zone
}

# --- Data ----------------------------------------------------------------------

# One table, every item of a user under PK = USER#<sub> (design section 4).
resource "aws_dynamodb_table" "food" {
  name         = local.name
  billing_mode = "PAY_PER_REQUEST" # pay per read/write, nothing when idle
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

  # Idempotency records carry expires_at; DynamoDB deletes them after it,
  # for free, within a day or two.
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  # Restore to any second of the last 35 days (a bad deploy, a wrong delete).
  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = true

  lifecycle {
    prevent_destroy = true
  }
}

# --- OAuth -------------------------------------------------------------------------

resource "aws_cognito_resource_server" "food" {
  user_pool_id = local.user_pool_id
  identifier   = local.resource_uri
  name         = local.name

  scope {
    scope_name        = "food:read"
    scope_description = "Read food entries and summaries"
  }
  scope {
    scope_name        = "food:write"
    scope_description = "Log, change and delete food entries"
  }
}

# claude.ai's client: pre-registered, public, PKCE, refresh token rotation.
# Same settings as spike 1, which were tested end to end.
resource "aws_cognito_user_pool_client" "claude" {
  name         = "${local.name}-claude"
  user_pool_id = local.user_pool_id

  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = aws_cognito_resource_server.food.scope_identifiers
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["https://claude.ai/api/mcp/auth_callback"]

  explicit_auth_flows           = ["ALLOW_USER_SRP_AUTH"] # REFRESH_TOKEN_AUTH is refused with rotation
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  refresh_token_rotation {
    feature                    = "ENABLED"
    retry_grace_period_seconds = 10
  }

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 30
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_cognito_managed_login_branding" "claude" {
  user_pool_id                = local.user_pool_id
  client_id                   = aws_cognito_user_pool_client.claude.id
  use_cognito_provided_values = true
}

# --- Lambda ------------------------------------------------------------------------

# The bundle and its source map (readable stack traces in the logs).
data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../dist"
  output_path = "${path.module}/../build/lambda.zip"
}

data "aws_iam_policy_document" "assume_lambda" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name                 = local.name
  path                 = "/mcp/"
  assume_role_policy   = data.aws_iam_policy_document.assume_lambda.json
  permissions_boundary = local.boundary_arn
}

# Exactly what the code does: item reads and writes on this table (the
# transactions are authorized item by item), its own logs. No Scan, no table
# management, nothing on any other table.
data "aws_iam_policy_document" "lambda" {
  statement {
    sid = "Table"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:ConditionCheckItem",
    ]
    resources = [aws_dynamodb_table.food.arn]
  }
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda.arn}:*"]
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "runtime"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = 14
}

resource "aws_lambda_function" "food" {
  function_name    = local.name
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 512 # Lambda gives CPU in proportion to memory: faster cold starts
  timeout          = 15

  environment {
    variables = {
      TABLE_NAME        = aws_dynamodb_table.food.name
      USER_POOL_ID      = local.user_pool_id
      CLIENT_IDS        = aws_cognito_user_pool_client.claude.id
      RESOURCE          = local.resource_uri
      DEFAULT_TIME_ZONE = "Europe/Paris"
      NODE_OPTIONS      = "--enable-source-maps"
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.lambda.name
  }

  depends_on = [aws_iam_role_policy.lambda]
}

# --- HTTPS endpoint ----------------------------------------------------------------

resource "aws_apigatewayv2_api" "food" {
  name          = local.name
  protocol_type = "HTTP"

  # Only the custom domain answers. The default execute-api URL would be a
  # second address for the same server, which tokens (aud = custom domain)
  # don't match anyway.
  disable_execute_api_endpoint = true
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.food.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.food.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "routes" {
  for_each = toset([
    "ANY /mcp",
    "GET /.well-known/oauth-protected-resource",
    "GET /.well-known/oauth-protected-resource/{proxy+}",
  ])
  api_id    = aws_apigatewayv2_api.food.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.food.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.food.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.food.execution_arn}/*/*"
}

# --- Custom domain -----------------------------------------------------------------

# TLS certificate for the domain, free (ACM). Regional API: certificate in
# the same region. Validated by a DNS record proving we control the name.
resource "aws_acm_certificate" "food" {
  domain_name       = local.domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  provider = aws.network
  for_each = {
    for o in aws_acm_certificate.food.domain_validation_options : o.domain_name => o
  }

  zone_id = data.aws_route53_zone.parent.zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  records = [each.value.resource_record_value]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "food" {
  certificate_arn         = aws_acm_certificate.food.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

resource "aws_apigatewayv2_domain_name" "food" {
  domain_name = local.domain

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.food.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "food" {
  api_id      = aws_apigatewayv2_api.food.id
  domain_name = aws_apigatewayv2_domain_name.food.id
  stage       = aws_apigatewayv2_stage.default.id
}

# food.mcp.<env>.lab... -> API Gateway's regional endpoint. Alias records
# (IPv4 and IPv6) are free to query and follow the endpoint's IPs.
resource "aws_route53_record" "food" {
  provider = aws.network
  for_each = toset(["A", "AAAA"])

  zone_id = data.aws_route53_zone.parent.zone_id
  name    = local.domain
  type    = each.value

  alias {
    name                   = aws_apigatewayv2_domain_name.food.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.food.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}
