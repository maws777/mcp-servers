output "mcp_url" {
  description = "Paste into claude.ai as the custom connector URL."
  value       = "${aws_apigatewayv2_api.mcp.api_endpoint}/mcp"
}

output "claude_client_id" {
  description = "Paste into claude.ai's \"OAuth Client ID\" field (no secret: public client)."
  value       = aws_cognito_user_pool_client.claude.id
}

output "user_pool_id" {
  value = local.user_pool_id
}
