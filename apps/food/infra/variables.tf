variable "region" {
  type    = string
  default = "eu-west-3"
}

variable "environment" {
  description = "staging or prod. Names the resources and the domain."
  type        = string
  default     = "staging"

  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
  }
}

variable "account_id" {
  description = "Workload account ID (safety net, boundary ARN)."
  type        = string
}

variable "network_account_id" {
  description = "Network account ID, where the hosted zone lives (safety net)."
  type        = string
}

variable "aws_profile" {
  description = "Local profile for the workload account. null in CI."
  type        = string
  default     = "staging-admin"
}

variable "network_profile" {
  description = "Local profile for the network account. null in CI."
  type        = string
  default     = "network-admin"
}

variable "network_role_arn" {
  description = "In CI: the DNS role to assume in the network account. null locally."
  type        = string
  default     = null
}

variable "user_pool_name" {
  type    = string
  default = "mcp-staging"
}

variable "parent_zone" {
  type    = string
  default = "lab.michaelteplov.com"
}
