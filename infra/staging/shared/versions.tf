terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # State in the staging account's own bucket (landing-zone ADR 0013).
  # The bucket name holds the account ID, so it stays out of the public repo:
  #   terraform init -backend-config=backend.hcl   (copy backend.hcl.example)
  backend "s3" {
    key          = "staging/shared.tfstate"
    region       = "eu-west-3"
    encrypt      = true
    use_lockfile = true
  }
}

# Locally: profile staging-admin (Identity Center). In CI: profile = null and
# the job's OIDC credentials (ci/mcp-ci-plan or ci/mcp-ci-apply).
provider "aws" {
  region  = var.region
  profile = var.aws_profile

  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      project      = "mcp-servers"
      "managed-by" = "terraform"
      environment  = "staging"
      stack        = "shared"
    }
  }
}
