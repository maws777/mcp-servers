output "site_url" {
  description = "Open on the iPhone in Safari, then Share -> Add to Home Screen."
  value       = "https://${aws_cloudfront_distribution.site.domain_name}/"
}

output "pwa_client_id" {
  value = aws_cognito_user_pool_client.pwa.id
}
