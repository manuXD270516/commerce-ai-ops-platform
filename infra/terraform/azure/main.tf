# Topology of docs/architecture.md §5 on Azure: AKS (workload identity, Key Vault CSI driver,
# app-routing ingress, Cilium network policy), ACR, PostgreSQL Flexible Server with pgvector and
# Azure Cache for Redis on private networking, Key Vault for every secret, GitHub OIDC federation
# for deployments and a budget alert. Not applied (see versions.tf).

data "azurerm_client_config" "current" {}

locals {
  name = "commerce-${var.environment}"
  tags = { project = "commerce-ai-ops", environment = var.environment, managed_by = "terraform" }
  # Kubernetes service account that reads Key Vault through workload identity.
  app_subject = "system:serviceaccount:${var.app_namespace}:${var.app_service_account}"
}

resource "azurerm_resource_group" "main" {
  name     = "rg-${local.name}"
  location = var.location
  tags     = local.tags
}

# ---------------------------------------------------------------- network
resource "azurerm_virtual_network" "main" {
  name                = "vnet-${local.name}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = ["10.42.0.0/16"]
  tags                = local.tags
}

resource "azurerm_subnet" "aks" {
  name                 = "snet-aks"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.42.0.0/20"]
}

# Delegated subnet: PostgreSQL gets a private address only (no public endpoint).
resource "azurerm_subnet" "postgres" {
  name                 = "snet-postgres"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.42.16.0/24"]
  delegation {
    name = "postgres"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "private_endpoints" {
  name                 = "snet-private-endpoints"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.42.17.0/24"]
}

resource "azurerm_private_dns_zone" "postgres" {
  name                = "${var.name_prefix}.private.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                  = "postgres"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.postgres.name
  virtual_network_id    = azurerm_virtual_network.main.id
}

resource "azurerm_private_dns_zone" "redis" {
  name                = "privatelink.redis.cache.windows.net"
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "redis" {
  name                  = "redis"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.redis.name
  virtual_network_id    = azurerm_virtual_network.main.id
}

# ---------------------------------------------------------------- registry
resource "azurerm_container_registry" "main" {
  name                = "${var.name_prefix}acr"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}

# ---------------------------------------------------------------- AKS
resource "azurerm_kubernetes_cluster" "main" {
  name                = "aks-${local.name}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  dns_prefix          = "${var.name_prefix}-${var.environment}"
  kubernetes_version  = var.kubernetes_version
  sku_tier            = "Free"

  default_node_pool {
    name                        = "system"
    vm_size                     = var.system_node_vm_size
    node_count                  = var.system_node_count
    vnet_subnet_id              = azurerm_subnet.aks.id
    temporary_name_for_rotation = "systemtmp"
  }

  identity {
    type = "SystemAssigned"
  }

  # Workload identity: pods exchange their service account token for an Entra token.
  oidc_issuer_enabled       = true
  workload_identity_enabled = true

  # Secrets Store CSI driver with the Azure Key Vault provider.
  key_vault_secrets_provider {
    secret_rotation_enabled = true
  }

  # Managed NGINX ingress (app-routing add-on); TLS certificates come from Key Vault.
  web_app_routing {
    dns_zone_ids = []
  }

  network_profile {
    network_plugin      = "azure"
    network_plugin_mode = "overlay"
    network_data_plane  = "cilium"
    network_policy      = "cilium"
  }

  local_account_disabled = true
  azure_active_directory_role_based_access_control {
    azure_rbac_enabled = true
    tenant_id          = data.azurerm_client_config.current.tenant_id
  }

  tags = local.tags
}

resource "azurerm_role_assignment" "aks_acr_pull" {
  scope                            = azurerm_container_registry.main.id
  role_definition_name             = "AcrPull"
  principal_id                     = azurerm_kubernetes_cluster.main.kubelet_identity[0].object_id
  skip_service_principal_aad_check = true
}

# ---------------------------------------------------------------- PostgreSQL
resource "random_password" "postgres_admin" {
  length  = 32
  special = false
}

resource "random_password" "migrator" {
  length  = 32
  special = false
}

resource "random_password" "runtime" {
  length  = 32
  special = false
}

resource "random_id" "pii_key" {
  byte_length = 32
}

resource "azurerm_postgresql_flexible_server" "main" {
  name                          = "${var.name_prefix}-pg-${var.environment}"
  resource_group_name           = azurerm_resource_group.main.name
  location                      = azurerm_resource_group.main.location
  version                       = var.postgres_version
  sku_name                      = var.postgres_sku
  storage_mb                    = 32768
  backup_retention_days         = 7
  delegated_subnet_id           = azurerm_subnet.postgres.id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres.id
  public_network_access_enabled = false
  administrator_login           = var.postgres_admin_login
  administrator_password        = random_password.postgres_admin.result
  tags                          = local.tags

  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]

  lifecycle {
    ignore_changes = [zone]
  }
}

# pgvector and pgcrypto must be allow-listed before the migration job can CREATE EXTENSION.
resource "azurerm_postgresql_flexible_server_configuration" "extensions" {
  name      = "azure.extensions"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "VECTOR,PGCRYPTO"
}

resource "azurerm_postgresql_flexible_server_database" "commerce" {
  name      = "commerce"
  server_id = azurerm_postgresql_flexible_server.main.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# ---------------------------------------------------------------- Redis (coordination only)
resource "azurerm_redis_cache" "main" {
  name                          = "${var.name_prefix}-redis-${var.environment}"
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  capacity                      = var.redis_capacity
  family                        = var.redis_sku == "Premium" ? "P" : "C"
  sku_name                      = var.redis_sku
  non_ssl_port_enabled          = false
  minimum_tls_version           = "1.2"
  public_network_access_enabled = false
  tags                          = local.tags
}

resource "azurerm_private_endpoint" "redis" {
  name                = "pe-redis-${local.name}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  subnet_id           = azurerm_subnet.private_endpoints.id

  private_service_connection {
    name                           = "redis"
    private_connection_resource_id = azurerm_redis_cache.main.id
    subresource_names              = ["redisCache"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "redis"
    private_dns_zone_ids = [azurerm_private_dns_zone.redis.id]
  }
}

# ---------------------------------------------------------------- Key Vault
resource "azurerm_key_vault" "main" {
  name                       = "${var.name_prefix}-kv-${var.environment}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  purge_protection_enabled   = true
  soft_delete_retention_days = 7
  tags                       = local.tags
}

# The principal running terraform writes the generated secrets (they also live in the state:
# keep the state in a protected backend).
resource "azurerm_role_assignment" "kv_officer_terraform" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

locals {
  pg_host = azurerm_postgresql_flexible_server.main.fqdn
  generated_secrets = {
    "database-admin-url"    = "postgres://${var.postgres_admin_login}:${random_password.postgres_admin.result}@${local.pg_host}:5432/commerce?sslmode=require"
    "database-migrator-url" = "postgres://commerce_migrator:${random_password.migrator.result}@${local.pg_host}:5432/commerce?sslmode=require"
    "database-url"          = "postgres://commerce_runtime:${random_password.runtime.result}@${local.pg_host}:5432/commerce?sslmode=require"
    "redis-url"             = "rediss://:${azurerm_redis_cache.main.primary_access_key}@${azurerm_redis_cache.main.hostname}:${azurerm_redis_cache.main.ssl_port}"
    "pii-key"               = random_id.pii_key.hex
  }
}

resource "azurerm_key_vault_secret" "generated" {
  for_each     = local.generated_secrets
  name         = each.key
  value        = each.value
  key_vault_id = azurerm_key_vault.main.id
  depends_on   = [azurerm_role_assignment.kv_officer_terraform]
}

# jwks and issuer-private-jwk are ES256 JWKs produced by `pnpm prod:secrets` and uploaded out of
# band (docs/runbook.md), so the issuer private key never enters the Terraform state.

# ---------------------------------------------------------------- workload identity (pods)
resource "azurerm_user_assigned_identity" "app" {
  name                = "id-${local.name}-app"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "app" {
  name                = "aks-${var.app_service_account}"
  resource_group_name = azurerm_resource_group.main.name
  parent_id           = azurerm_user_assigned_identity.app.id
  issuer              = azurerm_kubernetes_cluster.main.oidc_issuer_url
  subject             = local.app_subject
  audience            = ["api://AzureADTokenExchange"]
}

resource "azurerm_role_assignment" "app_kv_reader" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

# ---------------------------------------------------------------- GitHub OIDC (deployments)
resource "azurerm_user_assigned_identity" "deploy" {
  name                = "id-${local.name}-github-deploy"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "github" {
  name                = "github-${var.github_environment}"
  resource_group_name = azurerm_resource_group.main.name
  parent_id           = azurerm_user_assigned_identity.deploy.id
  issuer              = "https://token.actions.githubusercontent.com"
  subject             = "repo:${var.github_repository}:environment:${var.github_environment}"
  audience            = ["api://AzureADTokenExchange"]
}

resource "azurerm_role_assignment" "deploy_acr_push" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPush"
  principal_id         = azurerm_user_assigned_identity.deploy.principal_id
}

resource "azurerm_role_assignment" "deploy_aks_user" {
  scope                = azurerm_kubernetes_cluster.main.id
  role_definition_name = "Azure Kubernetes Service Cluster User Role"
  principal_id         = azurerm_user_assigned_identity.deploy.principal_id
}

# Kubernetes RBAC through Azure RBAC, limited to the app namespace.
resource "azurerm_role_assignment" "deploy_aks_namespace_writer" {
  scope                = "${azurerm_kubernetes_cluster.main.id}/namespaces/${var.app_namespace}"
  role_definition_name = "Azure Kubernetes Service RBAC Writer"
  principal_id         = azurerm_user_assigned_identity.deploy.principal_id
}

# ---------------------------------------------------------------- cost guard
resource "azurerm_consumption_budget_resource_group" "main" {
  name              = "budget-${local.name}"
  resource_group_id = azurerm_resource_group.main.id
  amount            = var.monthly_budget
  time_grain        = "Monthly"

  time_period {
    start_date = var.budget_start_date
  }

  notification {
    enabled        = true
    threshold      = 80
    threshold_type = "Forecasted"
    operator       = "GreaterThan"
    contact_emails = var.budget_alert_emails
  }
}
