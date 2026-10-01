# Every value that needs an owner decision has no default (subscription, region, DNS, budget,
# alert recipients, GitHub repository). See terraform.tfvars.example.

variable "subscription_id" {
  description = "Azure subscription that will hold the demo."
  type        = string
}

variable "location" {
  description = "Azure region; must offer AKS, PostgreSQL Flexible Server 17 with pgvector and Azure Cache for Redis."
  type        = string
}

variable "environment" {
  description = "Short environment name used in resource names."
  type        = string
  default     = "demo"
}

variable "name_prefix" {
  description = "Globally unique prefix for ACR, Key Vault and PostgreSQL names (lowercase letters and digits)."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,11}$", var.name_prefix))
    error_message = "name_prefix must be 3-12 lowercase letters or digits."
  }
}

variable "kubernetes_version" {
  description = "AKS Kubernetes version (null = region default)."
  type        = string
  default     = null
}

variable "system_node_vm_size" {
  type    = string
  default = "Standard_B2s"
}

variable "system_node_count" {
  type    = number
  default = 2
}

variable "postgres_version" {
  description = "PostgreSQL Flexible Server major version (the app is tested on 17 with pgvector 0.8)."
  type        = string
  default     = "17"
}

variable "postgres_sku" {
  type    = string
  default = "B_Standard_B1ms"
}

variable "postgres_admin_login" {
  type    = string
  default = "commerce_admin"
}

variable "redis_sku" {
  description = "Azure Cache for Redis SKU (Basic | Standard | Premium)."
  type        = string
  default     = "Basic"
}

variable "redis_capacity" {
  type    = number
  default = 0
}

variable "app_namespace" {
  description = "Kubernetes namespace of the app (must match deploy/k8s)."
  type        = string
  default     = "commerce"
}

variable "app_service_account" {
  description = "Kubernetes service account federated with the workload identity (must match deploy/k8s)."
  type        = string
  default     = "commerce-app"
}

variable "github_repository" {
  description = "owner/name of the GitHub repository allowed to deploy through OIDC."
  type        = string
}

variable "github_environment" {
  description = "GitHub environment whose OIDC tokens may deploy."
  type        = string
  default     = "aks-demo"
}

variable "monthly_budget" {
  description = "Monthly cost budget for the resource group, in the subscription currency."
  type        = number
}

variable "budget_alert_emails" {
  type = list(string)
}

variable "budget_start_date" {
  description = "First day of the budget period, RFC3339 (e.g. 2026-11-01T00:00:00Z)."
  type        = string
}
