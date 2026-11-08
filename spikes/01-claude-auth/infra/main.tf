# Spike 1 infrastructure: everything here is destroyed once the spike is done.
# The user pool itself lives in infra/staging/shared and stays.

locals {
  name            = "mcp-food-auth-spike" # mcp-* prefix: the CI roles are scoped to it (landing-zone ADR 0012/0013)
  boundary_arn    = "arn:aws:iam::${var.account_id}:policy/platform/mcp-workload-boundary"
  user_pool_id    = one(data.aws_cognito_user_pools.main.ids)
  claude_redirect = "https://claude.ai/api/mcp/auth_callback"

  # The MCP server's canonical URI (RFC 8707): what clients send as
  # `resource`, and therefore what the resource server identifier must be.
  resource_uri = "${aws_apigatewayv2_api.mcp.api_endpoint}/mcp"
  read_scope   = "${local.resource_uri}/food:read"
  write_scope  = "${local.resource_uri}/food:write"
}

data "aws_cognito_user_pools" "main" {
  name = var.user_pool_name
}

data "aws_cognito_user_pool" "main" {
  user_pool_id = local.user_pool_id
}

# --- OAuth: what the app is, and who may ask for tokens to it ---------------

# A resource server is Cognito's name for "an API that accepts this pool's
# tokens". Its identifier prefixes every scope it defines.
#
# The identifier is the MCP server's own URL, not a short name. MCP clients
# must send `resource=<server URL>` (RFC 8707), and Cognito supports this
# "resource binding": it only grants scopes whose resource server identifier
# equals the requested resource, otherwise it answers invalid_request
# (verified 2026-11-08 with identifier "mcp-food"). Side effect: the scopes
# are long ("https://.../mcp/food:read"), and another app in the same pool,
# having another URL, can't get them.
resource "aws_cognito_resource_server" "food" {
  user_pool_id = local.user_pool_id
  identifier   = local.resource_uri
  name         = "mcp-food"

  scope {
    scope_name        = "food:read"
    scope_description = "Read food entries and summaries"
  }
  scope {
    scope_name        = "food:write"
    scope_description = "Log, change and delete food entries"
  }
}

# The app client claude.ai uses. "Pre-registered": Cognito can't register
# clients on the fly (no dynamic registration, no client ID metadata
# documents), so I create it here and paste its client ID into claude.ai.
#
# Public client: no secret. claude.ai is a third party, and a secret given to
# it would protect nothing that PKCE doesn't already protect. PKCE (the client
# proves at the token step that it's the same party that started the login)
# is what stops a stolen authorization code from being redeemed by someone
# else. When a login starts with a code_challenge (MCP clients must send
# one), Cognito refuses the token request without the matching verifier.
resource "aws_cognito_user_pool_client" "claude" {
  name         = "${local.name}-claude"
  user_pool_id = local.user_pool_id

  generate_secret = false

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"] # authorization code flow only (no implicit)
  allowed_oauth_scopes                 = aws_cognito_resource_server.food.scope_identifiers
  supported_identity_providers         = ["COGNITO"]

  # Cognito only redirects back to exactly this URL, so a login can't be
  # hijacked into sending the code somewhere else.
  callback_urls = [local.claude_redirect]

  # Direct sign-in APIs this client may use, outside the OAuth endpoints.
  # Only SRP: the password protocol where the password itself never leaves
  # the browser (it proves knowledge of it). No plain USER_PASSWORD_AUTH. MFA
  # is enforced by the pool on every flow. ALLOW_REFRESH_TOKEN_AUTH is not
  # allowed with refresh token rotation (Cognito refuses the client):
  # refreshes go through /oauth2/token, which rotates.
  explicit_auth_flows = ["ALLOW_USER_SRP_AUTH"]

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  # Each refresh returns a new refresh token and invalidates the old one, so
  # a leaked refresh token stops working once the real client uses it. The
  # MCP spec requires it for public clients (Essentials tier feature).
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

# Managed login (v2) pages need a style per client; Cognito's defaults are fine.
resource "aws_cognito_managed_login_branding" "claude" {
  user_pool_id                = local.user_pool_id
  client_id                   = aws_cognito_user_pool_client.claude.id
  use_cognito_provided_values = true
}

# --- The Lambda -------------------------------------------------------------

data "archive_file" "lambda" {
  type        = "zip"
  source_file = "${path.module}/../dist/index.js"
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

# The Lambda's execution role: under /mcp/ and carrying the platform boundary,
# exactly what the CI apply role will require (ADR 0013), so this stack can
# move to CI unchanged.
resource "aws_iam_role" "lambda" {
  name                 = local.name
  path                 = "/mcp/"
  assume_role_policy   = data.aws_iam_policy_document.assume_lambda.json
  permissions_boundary = local.boundary_arn
}

# Only permission it needs: write its own logs. (No DynamoDB yet.)
data "aws_iam_policy_document" "lambda" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda.arn}:*"]
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "logs"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

# Created by Terraform (not by Lambda on first run) so it has a retention:
# otherwise logs are kept forever and slowly cost money.
resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = 14
}

resource "aws_lambda_function" "mcp" {
  function_name    = local.name
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"] # Graviton: ~20% cheaper per ms
  handler          = "index.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 256
  timeout          = 10

  environment {
    variables = {
      USER_POOL_ID   = local.user_pool_id
      CLIENT_IDS     = aws_cognito_user_pool_client.claude.id
      READ_SCOPE     = local.read_scope
      WRITE_SCOPE    = local.write_scope
      AS_MODE        = var.as_metadata_mode
      LOGIN_BASE_URL = "https://${data.aws_cognito_user_pool.main.domain}.auth.${var.region}.amazoncognito.com"
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.lambda.name
  }

  depends_on = [aws_iam_role_policy.lambda]
}

# --- API Gateway HTTP API: the public HTTPS endpoint ------------------------

resource "aws_apigatewayv2_api" "mcp" {
  name          = local.name
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.mcp.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.mcp.invoke_arn
  payload_format_version = "2.0"
}

# Explicit routes only: any other path gets API Gateway's own 404 and never
# invokes (or bills) the Lambda.
resource "aws_apigatewayv2_route" "routes" {
  for_each = toset([
    "ANY /mcp",
    "GET /.well-known/oauth-protected-resource",
    "GET /.well-known/oauth-protected-resource/{proxy+}",
    "GET /.well-known/oauth-authorization-server", # plan B only (variables.tf: as_metadata_mode)
  ])
  api_id    = aws_apigatewayv2_api.mcp.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.mcp.id
  name        = "$default"
  auto_deploy = true

  # The rate limit: beyond this, API Gateway answers 429 itself, before the
  # Lambda runs. Low on purpose: one user.
  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }
}

# Lets API Gateway (this API only) invoke the function.
resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.mcp.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.mcp.execution_arn}/*/*"
}
