variable "region" {
  type    = string
  default = "eu-west-3"
}

variable "account_id" {
  description = "Staging account ID. A safety net: the provider refuses to touch any other account."
  type        = string
}

variable "aws_profile" {
  description = "Local AWS CLI profile. null in CI, where OIDC credentials come from the environment."
  type        = string
  default     = "staging-admin"
}

variable "login_domain_prefix" {
  description = "Prefix of the Cognito managed login domain (<prefix>.auth.<region>.amazoncognito.com). Must be unique in the region."
  type        = string
  default     = "michaelteplov-mcp-staging"
}
