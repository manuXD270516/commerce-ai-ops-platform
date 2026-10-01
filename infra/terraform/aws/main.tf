# Cloud demo topology of docs/architecture.md §5 on AWS (ECS Fargate, RDS PostgreSQL with pgvector,
# ElastiCache, Secrets Manager, ALB with TLS). STATUS: written and reviewed, NOT applied and NOT
# validated against an AWS account: no region, budget, OIDC trust or zero-cost host has been
# authorized yet (see docs/runbook.md §Cloud). Applying it creates billable resources.

terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "commerce-ai-ops", environment = var.environment, managed_by = "terraform" }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name     = "commerce-ai-ops-${var.environment}"
  azs      = slice(data.aws_availability_zones.available.names, 0, 2)
  services = { api = 3001, worker = 3002, mcp = 3003, web = 3000 }
}

# ---------------------------------------------------------------- network
resource "aws_vpc" "main" {
  cidr_block           = "10.40.0.0/16"
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "${local.name}-public-${count.index}" }
}

# Private subnets: tasks, database and Redis have no public address.
resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 10)
  availability_zone = local.azs[count.index]
  tags              = { Name = "${local.name}-private-${count.index}" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# One NAT gateway (not per AZ) to keep the demo cheap; tasks only need egress to AWS APIs/ECR.
resource "aws_eip" "nat" {
  domain = "vpc"
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_security_group" "alb" {
  name   = "${local.name}-alb"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidrs
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }
}

resource "aws_security_group" "tasks" {
  name   = "${local.name}-tasks"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 3000
    to_port         = 3001
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  # Tasks reach each other (web -> api, agents -> mcp) inside the VPC only.
  ingress {
    from_port = 3000
    to_port   = 3003
    protocol  = "tcp"
    self      = true
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "data" {
  name   = "${local.name}-data"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }
}

# ---------------------------------------------------------------- data services
resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

# PostgreSQL 17 on RDS supports the vector extension; confirm the minor version in the region
# before applying (open question in openspec/changes/add-cloud-deployment-demo/design.md).
resource "aws_db_instance" "main" {
  identifier                   = local.name
  engine                       = "postgres"
  engine_version               = var.postgres_version
  instance_class               = var.db_instance_class
  allocated_storage            = 20
  storage_encrypted            = true
  db_name                      = "commerce"
  username                     = "commerce_admin"
  manage_master_user_password  = true
  db_subnet_group_name         = aws_db_subnet_group.main.name
  vpc_security_group_ids       = [aws_security_group.data.id]
  publicly_accessible          = false
  backup_retention_period      = 7
  deletion_protection          = var.environment != "demo"
  skip_final_snapshot          = var.environment == "demo"
  performance_insights_enabled = false
}

resource "aws_elasticache_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

# Coordination only (queues, schedulers): no snapshots on purpose; PostgreSQL is the source of truth.
resource "aws_elasticache_replication_group" "main" {
  replication_group_id       = local.name
  description                = "BullMQ coordination for ${local.name}"
  engine                     = "redis"
  node_type                  = var.redis_node_type
  num_cache_clusters         = 1
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.data.id]
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true
  auth_token                 = random_password.redis.result
  snapshot_retention_limit   = 0
}

resource "random_password" "redis" {
  length  = 40
  special = false
}

# ---------------------------------------------------------------- secrets
# Values are written out of band (pnpm prod:secrets equivalent); Terraform only owns the containers.
resource "aws_secretsmanager_secret" "app" {
  for_each = toset(["database_url", "database_migrator_url", "database_admin_url", "redis_url", "pii_key", "jwks", "issuer_private_jwk"])
  name     = "${local.name}/${each.key}"
}

# ---------------------------------------------------------------- images and logs
resource "aws_ecr_repository" "app" {
  for_each             = toset(["api", "worker", "mcp", "web", "migrate"])
  name                 = "commerce-ai-ops/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_cloudwatch_log_group" "app" {
  for_each          = local.services
  name              = "/${local.name}/${each.key}"
  retention_in_days = 30
}

# ---------------------------------------------------------------- ECS
resource "aws_ecs_cluster" "main" {
  name = local.name
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Only the execution role reads secrets, and only this stack's.
resource "aws_iam_role_policy" "execution_secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [for s in aws_secretsmanager_secret.app : s.arn]
    }]
  })
}

locals {
  common_env = [
    { name = "NODE_ENV", value = "production" },
    { name = "AUTH_ISSUER", value = var.auth_issuer },
  ]
  common_secrets = [
    { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.app["database_url"].arn },
    { name = "REDIS_URL", valueFrom = aws_secretsmanager_secret.app["redis_url"].arn },
    { name = "PII_ENCRYPTION_KEY", valueFrom = aws_secretsmanager_secret.app["pii_key"].arn },
    { name = "AUTH_JWKS", valueFrom = aws_secretsmanager_secret.app["jwks"].arn },
  ]
}

resource "aws_ecs_task_definition" "app" {
  for_each                 = local.services
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions = jsonencode([{
    name      = each.key
    image     = "${aws_ecr_repository.app[each.key].repository_url}:${var.image_tag}"
    essential = true
    # The entrypoint writes AUTH_JWKS / AUTH_SIGNING_KEY to private files at start; nothing in layers.
    portMappings = [{ containerPort = each.value }]
    environment = concat(local.common_env, [
      { name = "API_HOST", value = "0.0.0.0" },
      { name = "WORKER_HOST", value = "0.0.0.0" },
      { name = "MCP_HOST", value = "0.0.0.0" },
      { name = "RUN_EXECUTION", value = "queue" },
      { name = "API_BASE_URL", value = "http://api.${local.name}.local:3001" },
    ])
    secrets = each.key == "web" ? [
      { name = "AUTH_SIGNING_KEY", valueFrom = aws_secretsmanager_secret.app["issuer_private_jwk"].arn },
    ] : local.common_secrets
    readonlyRootFilesystem = false
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app[each.key].name
        awslogs-region        = var.region
        awslogs-stream-prefix = each.key
      }
    }
  }])
}

resource "aws_service_discovery_private_dns_namespace" "main" {
  name = "${local.name}.local"
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "app" {
  for_each = local.services
  name     = each.key
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main.id
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}

resource "aws_ecs_service" "app" {
  for_each        = local.services
  name            = each.key
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app[each.key].arn
  desired_count   = 1
  launch_type     = "FARGATE"
  # Rollback: a failed deployment (health checks) is rolled back to the previous task definition.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }
  service_registries {
    registry_arn = aws_service_discovery_service.app[each.key].arn
  }
  dynamic "load_balancer" {
    for_each = contains(["api", "web"], each.key) ? [each.key] : []
    content {
      target_group_arn = aws_lb_target_group.app[load_balancer.value].arn
      container_name   = load_balancer.value
      container_port   = local.services[load_balancer.value]
    }
  }
}

# ---------------------------------------------------------------- edge (TLS)
resource "aws_lb" "main" {
  name                       = local.name
  load_balancer_type         = "application"
  subnets                    = aws_subnet.public[*].id
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "app" {
  for_each    = { api = 3001, web = 3000 }
  name        = "${local.name}-${each.key}"
  port        = each.value
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    path    = each.key == "api" ? "/readyz" : "/login"
    matcher = "200"
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app["web"].arn
  }
}

# Same routing as infra/docker/Caddyfile: /v1/* and /healthz to the API, the rest to the console.
resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app["api"].arn
  }
  condition {
    path_pattern {
      values = ["/v1/*", "/healthz"]
    }
  }
}

# ---------------------------------------------------------------- cost guard
resource "aws_budgets_budget" "monthly" {
  name         = local.name
  budget_type  = "COST"
  limit_amount = var.monthly_budget_usd
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = var.budget_alert_emails
  }
}
