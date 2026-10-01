# Every value that needs a human decision has no default: region, certificate, issuer, budget and
# alert recipients must be chosen explicitly before any plan.

variable "region" {
  description = "AWS region; must offer RDS PostgreSQL 17 with pgvector, Fargate and ElastiCache."
  type        = string
}

variable "environment" {
  description = "Environment name; 'demo' allows destroy without final snapshot."
  type        = string
  default     = "demo"
}

variable "image_tag" {
  description = "Immutable image tag (the git commit) built by .github/workflows/deploy.yml."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate for the ALB HTTPS listener."
  type        = string
}

variable "auth_issuer" {
  description = "Token issuer URL configured for the console's demo sign-in."
  type        = string
}

variable "allowed_cidrs" {
  description = "Client CIDRs allowed to reach the ALB (restrict for a private demo)."
  type        = list(string)
}

variable "postgres_version" {
  description = "RDS PostgreSQL engine version (17.x with pgvector >= 0.8)."
  type        = string
  default     = "17"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "monthly_budget_usd" {
  description = "Monthly cost budget; alerts at 80% forecast."
  type        = string
}

variable "budget_alert_emails" {
  type = list(string)
}
