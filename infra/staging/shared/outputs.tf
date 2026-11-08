output "user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "issuer" {
  description = "Token issuer, and the authorization server URL the MCP servers advertise."
  value       = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
}

output "login_base_url" {
  description = "Managed login domain (sign-in pages, /oauth2/authorize, /oauth2/token)."
  value       = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.region}.amazoncognito.com"
}
