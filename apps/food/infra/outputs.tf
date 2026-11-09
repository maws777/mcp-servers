output "mcp_url" {
  description = "claude.ai custom connector URL."
  value       = local.resource_uri
}

output "claude_client_id" {
  description = "claude.ai \"OAuth Client ID\" (public client, no secret)."
  value       = aws_cognito_user_pool_client.claude.id
}

output "table_name" {
  value = aws_dynamodb_table.food.name
}
