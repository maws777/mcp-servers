variable "region" {
  type    = string
  default = "eu-west-3"
}

variable "account_id" {
  description = "Staging account ID (safety net, bucket name)."
  type        = string
}

variable "aws_profile" {
  type    = string
  default = "staging-admin"
}

variable "user_pool_name" {
  type    = string
  default = "mcp-staging"
}

variable "mcp_url" {
  description = "Spike 1's MCP URL (its output mcp_url): the resource server whose read scope the dashboard client gets."
  type        = string
}
