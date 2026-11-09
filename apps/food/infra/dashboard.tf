# The dashboard (docs/design/food-dashboard.md, phase 4a):
#
#   https://food.<env>.lab.michaelteplov.com  (CloudFront)
#     default  -> S3 bucket (the site, private, origin access control)
#     /api/*   -> food.mcp.<env>... (API Gateway) -> dashboard Lambda (read only)
#
# Login: Cognito managed login, the dashboard's own client (food:read only).

locals {
  site_domain    = "food.${var.environment}.${var.parent_zone}"
  site_url       = "https://${local.site_domain}"
  site_dir       = "${path.module}/../web/dist"
  dashboard_name = "${local.name}-dashboard"
  login_base_url = "https://${data.aws_cognito_user_pool.main.domain}.auth.${var.region}.amazoncognito.com"

  content_types = {
    html        = "text/html; charset=utf-8"
    js          = "text/javascript; charset=utf-8"
    css         = "text/css; charset=utf-8"
    png         = "image/png"
    webmanifest = "application/manifest+json"
  }
}

data "aws_cognito_user_pool" "main" {
  user_pool_id = local.user_pool_id
}

# --- Cognito: the dashboard's own client, read-only ------------------------------

# Separate from claude.ai's client, and limited to food:read: a token taken
# from the browser can read but never write (ADR 0001). The MCP Lambda doesn't
# accept this client, and the dashboard Lambda accepts only this one.
resource "aws_cognito_user_pool_client" "dashboard" {
  name         = local.dashboard_name
  user_pool_id = local.user_pool_id

  generate_secret                      = false # a browser can't keep a secret
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["${local.resource_uri}/food:read"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["${local.site_url}/"]
  logout_urls                          = ["${local.site_url}/"]

  explicit_auth_flows           = ["ALLOW_USER_SRP_AUTH"]
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

resource "aws_cognito_managed_login_branding" "dashboard" {
  user_pool_id                = local.user_pool_id
  client_id                   = aws_cognito_user_pool_client.dashboard.id
  use_cognito_provided_values = true
}

# --- The API: its own Lambda, read-only role ---------------------------------------

data "archive_file" "dashboard" {
  type             = "zip"
  source_dir       = "${path.module}/../dist/dashboard"
  output_path      = "${path.module}/../build/dashboard.zip"
  output_file_mode = "0644"
}

resource "aws_iam_role" "dashboard" {
  name                 = local.dashboard_name
  path                 = "/mcp/"
  assume_role_policy   = data.aws_iam_policy_document.assume_lambda.json
  permissions_boundary = local.boundary_arn
}

# Reads only: no Put/Update/Delete, so nothing on this path can change data.
data "aws_iam_policy_document" "dashboard" {
  statement {
    sid       = "ReadTable"
    actions   = ["dynamodb:GetItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.food.arn]
  }
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.dashboard.arn}:*"]
  }
}

resource "aws_iam_role_policy" "dashboard" {
  name   = "runtime"
  role   = aws_iam_role.dashboard.id
  policy = data.aws_iam_policy_document.dashboard.json
}

resource "aws_cloudwatch_log_group" "dashboard" {
  name              = "/aws/lambda/${local.dashboard_name}"
  retention_in_days = 14
}

resource "aws_lambda_function" "dashboard" {
  function_name    = local.dashboard_name
  role             = aws_iam_role.dashboard.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.dashboard.output_path
  source_code_hash = data.archive_file.dashboard.output_base64sha256
  memory_size      = 512
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME          = aws_dynamodb_table.food.name
      USER_POOL_ID        = local.user_pool_id
      DASHBOARD_CLIENT_ID = aws_cognito_user_pool_client.dashboard.id
      RESOURCE            = local.resource_uri
      DEFAULT_TIME_ZONE   = "Europe/Paris"
      NODE_OPTIONS        = "--enable-source-maps"
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.dashboard.name
  }

  depends_on = [aws_iam_role_policy.dashboard]
}

# Same HTTP API as the MCP server (same domain, same throttling), its own
# integration: only GET /api/... reaches this function.
resource "aws_apigatewayv2_integration" "dashboard" {
  api_id                 = aws_apigatewayv2_api.food.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.dashboard.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "dashboard" {
  api_id    = aws_apigatewayv2_api.food.id
  route_key = "GET /api/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.dashboard.id}"
}

resource "aws_lambda_permission" "dashboard_apigw" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.dashboard.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.food.execution_arn}/*/*"
}

# --- The site bucket: private, only CloudFront reads it ---------------------------

# Named mcp-<app>-<env>-site-<account id>: the CI role's app bucket pattern
# (mcp-*-<env>-*, landing-zone PR #21), which can't match the state bucket.
resource "aws_s3_bucket" "site" {
  bucket = "${local.name}-site-${var.account_id}"
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    object_ownership = "BucketOwnerEnforced" # ACLs off: access only by policy
  }
}

# Origin access control: CloudFront signs its requests to S3, and the bucket
# policy allows only this distribution. Never public.
resource "aws_cloudfront_origin_access_control" "site" {
  name                              = local.name
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "site_bucket" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket     = aws_s3_bucket.site.id
  policy     = data.aws_iam_policy_document.site_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.site]
}

# --- Certificate (us-east-1, CloudFront's requirement) ------------------------------

resource "aws_acm_certificate" "site" {
  provider          = aws.us_east_1
  domain_name       = local.site_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "site_cert_validation" {
  provider = aws.network
  for_each = {
    for o in aws_acm_certificate.site.domain_validation_options : o.domain_name => o
  }

  zone_id = data.aws_route53_zone.parent.zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  records = [each.value.resource_record_value]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "site" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.site.arn
  validation_record_fqdns = [for r in aws_route53_record.site_cert_validation : r.fqdn]
}

# --- CloudFront --------------------------------------------------------------------

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized" # follows each file's Cache-Control (set on the objects below)
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

# Everything the browser sent, except Host: API Gateway's custom domain
# needs its own host name to find the API.
data "aws_cloudfront_origin_request_policy" "all_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# Security headers on every response (as tested in spike 2). The CSP is the
# main defence against XSS (ADR 0001): scripts and styles only from this
# origin, no inline, no eval; network calls only to this origin and the
# Cognito login domain; the page can't be framed.
resource "aws_cloudfront_response_headers_policy" "site" {
  name = local.name

  security_headers_config {
    content_security_policy {
      override = true
      content_security_policy = join("; ", [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "manifest-src 'self'",
        "connect-src 'self' ${local.login_base_url}",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ])
    }
    strict_transport_security {
      override                   = true
      access_control_max_age_sec = 31536000
      include_subdomains         = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      override     = true
      frame_option = "DENY"
    }
    referrer_policy {
      override        = true
      referrer_policy = "no-referrer"
    }
  }
}

# Free tier: CloudFront's always-free allowance (1 TB, 10 M requests a month).
resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  comment             = "${local.name} dashboard"
  aliases             = [local.site_domain]
  default_root_object = "index.html"
  price_class         = "PriceClass_100" # Europe + North America edges only
  http_version        = "http2and3"

  origin {
    origin_id                = "site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  # The same API Gateway custom domain claude.ai uses, so the page calls
  # /api on its own origin: no CORS, a tighter CSP.
  origin {
    origin_id   = "api"
    domain_name = local.domain
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id           = "site"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site.id
  }

  ordered_cache_behavior {
    path_pattern               = "/api/*"
    target_origin_id           = "api"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_except_host.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.site.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# food.<env>.lab... -> the distribution (IPv4 and IPv6). Z2FDTNDATAQYW2 is
# CloudFront's fixed hosted zone ID for alias records.
resource "aws_route53_record" "site" {
  provider = aws.network
  for_each = toset(["A", "AAAA"])

  zone_id = data.aws_route53_zone.parent.zone_id
  name    = local.site_domain
  type    = each.value

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}

# --- The site files ------------------------------------------------------------------

# Hashed assets never change under the same name: cache them a year.
# Everything else (index.html, manifest, icons) is revalidated on each open,
# so a deploy shows up at the next launch without invalidations.
resource "aws_s3_object" "site" {
  for_each = fileset(local.site_dir, "**")

  bucket        = aws_s3_bucket.site.id
  key           = each.value
  source        = "${local.site_dir}/${each.value}"
  etag          = filemd5("${local.site_dir}/${each.value}")
  content_type  = local.content_types[reverse(split(".", each.value))[0]]
  cache_control = startswith(each.value, "assets/") ? "public, max-age=31536000, immutable" : "no-cache"
}

# Runtime config, written here because Terraform knows these values. Nothing
# secret: a public client's ID and the login domain.
resource "aws_s3_object" "config" {
  bucket        = aws_s3_bucket.site.id
  key           = "config.json"
  content_type  = "application/json"
  cache_control = "no-cache"
  content = jsonencode({
    loginBaseUrl = local.login_base_url
    clientId     = aws_cognito_user_pool_client.dashboard.id
    scope        = "${local.resource_uri}/food:read"
    resource     = local.resource_uri
    redirectUri  = "${local.site_url}/"
  })
}
