output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "ecr_repositories" {
  value = { for k, r in aws_ecr_repository.app : k => r.repository_url }
}

output "secret_arns" {
  description = "Secrets to fill out of band before the first deployment."
  value       = { for k, s in aws_secretsmanager_secret.app : k => s.arn }
}

output "database_endpoint" {
  value     = aws_db_instance.main.address
  sensitive = true
}
