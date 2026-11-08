# Spike 2 infrastructure: a static PWA on S3 + CloudFront, and a read-only
# Cognito client for it. Destroyed once the spike is answered.

locals {
  name           = "mcp-pwa-spike"
  user_pool_id   = one(data.aws_cognito_user_pools.main.ids)
  login_base_url = "https://${data.aws_cognito_user_pool.main.domain}.auth.${var.region}.amazoncognito.com"
  site_url       = "https://${aws_cloudfront_distribution.site.domain_name}"
  read_scope     = "${var.mcp_url}/food:read"
  site_dir       = "${path.module}/../site"

  content_types = {
    html        = "text/html; charset=utf-8"
    js          = "text/javascript; charset=utf-8"
    css         = "text/css; charset=utf-8"
    png         = "image/png"
    webmanifest = "application/manifest+json"
  }
}

data "aws_cognito_user_pools" "main" {
  name = var.user_pool_name
}

data "aws_cognito_user_pool" "main" {
  user_pool_id = local.user_pool_id
}

# --- The bucket: private, only CloudFront can read it ----------------------

resource "aws_s3_bucket" "site" {
  bucket        = "${local.name}-${var.account_id}" # bucket names are global: the account ID makes it unique
  force_destroy = true                              # spike: let destroy empty it
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
    object_ownership = "BucketOwnerEnforced" # ACLs disabled: access is only by policy
  }
}

# Origin access control: CloudFront signs its requests to S3 (SigV4), and the
# bucket policy below allows only that one distribution. The bucket is never
# public; the site is reachable only through CloudFront, with its headers.
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

# --- CloudFront --------------------------------------------------------------

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled" # spike: every reload gets the latest files
}

# Security headers on every response. The CSP is the main defence against
# XSS for the real dashboard: scripts only from this origin (no inline, no
# eval), network calls only to this origin and the Cognito login domain,
# and the page can't be framed (clickjacking).
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

# Free tier: CloudFront's always-free allowance (1 TB, 10 M requests a month)
# covers this many times over. The default *.cloudfront.net certificate means
# no ACM certificate in us-east-1 yet; the real dashboard gets its custom
# domain.
resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  comment             = "${local.name} (spike 2, PWA login)"
  default_root_object = "index.html"
  price_class         = "PriceClass_100" # Europe + North America edges only
  http_version        = "http2and3"

  origin {
    origin_id                = "s3"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id           = "s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# --- The site files ------------------------------------------------------------

resource "aws_s3_object" "static" {
  for_each = fileset(local.site_dir, "*")

  bucket       = aws_s3_bucket.site.id
  key          = each.value
  source       = "${local.site_dir}/${each.value}"
  etag         = filemd5("${local.site_dir}/${each.value}")
  content_type = local.content_types[reverse(split(".", each.value))[0]]
}

# Runtime config, generated here because it holds values Terraform knows:
# the client ID and the Cognito domain. Nothing secret (public client).
resource "aws_s3_object" "config" {
  bucket       = aws_s3_bucket.site.id
  key          = "config.js"
  content_type = local.content_types.js
  content = "window.SPIKE_CONFIG = ${jsonencode({
    loginBaseUrl = local.login_base_url
    clientId     = aws_cognito_user_pool_client.pwa.id
    scope        = local.read_scope
    redirectUri  = "${local.site_url}/"
    logoutUri    = "${local.site_url}/"
  })};\n"
}

# --- Cognito: the dashboard's own client, read-only -------------------------

# Separate from claude.ai's client, and limited to food:read: a token stolen
# from the browser (XSS, a lost phone) can read but never write.
resource "aws_cognito_user_pool_client" "pwa" {
  name         = "${local.name}-web"
  user_pool_id = local.user_pool_id

  generate_secret                      = false # a browser can't keep a secret
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = [local.read_scope]
  supported_identity_providers         = ["COGNITO"]

  callback_urls = ["${local.site_url}/"]
  logout_urls   = ["${local.site_url}/"]

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

resource "aws_cognito_managed_login_branding" "pwa" {
  user_pool_id                = local.user_pool_id
  client_id                   = aws_cognito_user_pool_client.pwa.id
  use_cognito_provided_values = true
}
