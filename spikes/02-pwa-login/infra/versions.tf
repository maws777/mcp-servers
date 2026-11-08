terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Same bucket as infra/staging/shared, its own key:
  #   terraform init -backend-config=../../../infra/staging/shared/backend.hcl
  backend "s3" {
    key          = "spikes/02-pwa-login.tfstate"
    region       = "eu-west-3"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile

  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      project      = "mcp-servers"
      "managed-by" = "terraform"
      environment  = "staging"
      stack        = "spike-02-pwa-login"
    }
  }
}
