# Values the deploy workflow and deploy/k8s/overlays/aks/params.env need (no secrets).

output "resource_group" {
  value = azurerm_resource_group.main.name
}

output "aks_name" {
  value = azurerm_kubernetes_cluster.main.name
}

output "acr_login_server" {
  value = azurerm_container_registry.main.login_server
}

output "key_vault_name" {
  value = azurerm_key_vault.main.name
}

output "tenant_id" {
  value = data.azurerm_client_config.current.tenant_id
}

output "app_identity_client_id" {
  description = "AZURE_WORKLOAD_CLIENT_ID in params.env (service account annotation and SecretProviderClass)."
  value       = azurerm_user_assigned_identity.app.client_id
}

output "deploy_identity_client_id" {
  description = "AZURE_CLIENT_ID repository variable for .github/workflows/deploy.yml."
  value       = azurerm_user_assigned_identity.deploy.client_id
}

output "postgres_fqdn" {
  value = azurerm_postgresql_flexible_server.main.fqdn
}
