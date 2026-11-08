# The staging user pool: the OAuth authorization server shared by every MCP
# app in this environment (landing-zone ADR 0012). Each app adds its own
# resource server (its scopes) and its own app clients in its own stack; this
# stack only owns what they share: the user directory and the login domain.

resource "aws_cognito_user_pool" "main" {
  name = "mcp-staging"

  # Essentials over Lite: adds access token customization (a Lambda trigger
  # could add an `aud` claim later), refresh token rotation and password-reuse
  # prevention. Both tiers include 10,000 monthly active users free, with no
  # expiry, so it's free for one user.
  user_pool_tier = "ESSENTIALS"

  # Can't be deleted by accident (a destroy fails until this is turned off).
  deletion_protection = "ACTIVE"

  # Sign in with an email address. No self sign-up: accounts are created by
  # an admin (me), so nobody on the internet can register and get a token.
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  username_configuration {
    case_sensitive = false
  }

  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 3
  }

  # MFA on every account, with an authenticator app (TOTP). SMS would cost
  # money and is weaker; email codes would need SES.
  mfa_configuration = "ON"
  software_token_mfa_configuration {
    enabled = true
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  # Cognito's built-in sender: free, 50 emails/day, fine for invitations and
  # password resets for one user.
  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# The managed login domain: where the sign-in pages and the OAuth endpoints
# (/oauth2/authorize, /oauth2/token) live. A prefix domain is free and needs
# no certificate; a custom domain (auth.staging.lab...) can replace it later.
resource "aws_cognito_user_pool_domain" "main" {
  domain                = var.login_domain_prefix
  user_pool_id          = aws_cognito_user_pool.main.id
  managed_login_version = 2
}
