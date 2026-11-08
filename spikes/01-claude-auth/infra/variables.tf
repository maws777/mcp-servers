variable "region" {
  type    = string
  default = "eu-west-3"
}

variable "account_id" {
  description = "Staging account ID (safety net and boundary ARN)."
  type        = string
}

variable "aws_profile" {
  type    = string
  default = "staging-admin"
}

variable "as_metadata_mode" {
  description = <<-EOT
    Which authorization server the protected resource metadata points to.
    "cognito": Cognito itself (plan A). Its OpenID discovery document lacks
      code_challenge_methods_supported, and the MCP spec tells clients to
      refuse in that case, so a strict client may stop there.
    "shim": this server publishes its own RFC 8414 metadata that lists
      Cognito's endpoints plus code_challenge_methods_supported = ["S256"]
      (plan B). Cognito does support S256; only the advertisement is missing.
  EOT
  type        = string
  default     = "cognito"

  validation {
    condition     = contains(["cognito", "shim"], var.as_metadata_mode)
    error_message = "as_metadata_mode must be \"cognito\" or \"shim\"."
  }
}

variable "user_pool_name" {
  description = "The shared user pool created by infra/staging/shared."
  type        = string
  default     = "mcp-staging"
}
