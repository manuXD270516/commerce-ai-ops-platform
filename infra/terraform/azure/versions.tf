# Azure (AKS) target of M11. STATUS: deployment-ready, NOT applied. Validated only with
# `terraform fmt -check` and `terraform validate` (init -backend=false). Applying it creates
# billable resources and requires the repo owner's explicit authorization (docs/runbook.md).

terraform {
  required_version = ">= 1.9"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
  # Remote state is chosen at apply time (e.g. an azurerm backend in a separate storage account):
  #   terraform init -backend-config=backend.hcl
}

provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy = false
    }
  }
  subscription_id = var.subscription_id
}
