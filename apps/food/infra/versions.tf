terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }

  # State in the workload account's bucket (landing-zone ADR 0013):
  #   terraform init -backend-config=../../../infra/staging/shared/backend.hcl
  backend "s3" {
    key          = "apps/food/staging.tfstate"
    region       = "eu-west-3"
    encrypt      = true
    use_lockfile = true
  }
}

# Workload account (staging): everything except DNS records.
# Locally: profile staging-admin. In CI: profile = null, OIDC credentials.
provider "aws" {
  region  = var.region
  profile = var.aws_profile

  allowed_account_ids = [var.account_id]

  default_tags {
    tags = local.tags
  }
}

# Network account: the lab.michaelteplov.com hosted zone, for the
# certificate validation record and the domain's alias records.
#   locally -> profile network-admin (Identity Center)
#   CI      -> assume ci/mcp-dns-<env>-apply (or -plan), which may only touch
#              names ending in .<env>.lab.michaelteplov.com (ADR 0013)
provider "aws" {
  alias   = "network"
  region  = var.region
  profile = var.network_profile

  dynamic "assume_role" {
    for_each = var.network_role_arn == null ? [] : [var.network_role_arn]
    content {
      role_arn     = assume_role.value
      session_name = "mcp-food-${var.environment}"
    }
  }

  allowed_account_ids = [var.network_account_id]

  default_tags {
    tags = local.tags
  }
}
