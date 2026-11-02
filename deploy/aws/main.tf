# Rin host: one EC2 instance running postgres, gateway and worker with Docker
# Compose (deploy/compose.yaml). GitHub Actions builds the image, pushes it to
# ECR and deploys it through SSM Run Command (.github/workflows/deploy.yml).
# Nothing reaches the host from outside: no inbound rule, no SSH.
#
# Cost (ap-northeast-2, on-demand, 2026-11):
#   t3.large          about $0.104/h
#   EBS gp3 40 GiB    about $0.13/day
#   public IPv4       $0.005/h
#   total             about $2.7/day
#
# Remove everything: ./tf.sh destroy

data "aws_caller_identity" "me" {}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

# The AWS managed key SSM uses for SecureString parameters without a key id.
data "aws_kms_alias" "ssm" {
  name = "alias/aws/ssm"
}

# One per account and already shared by other repos, so only referenced here.
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

locals {
  name          = "rin"
  account_id    = data.aws_caller_identity.me.account_id
  parameter_arn = "arn:aws:ssm:${var.region}:${local.account_id}:parameter/rin"
  # The repo uses GitHub's immutable OIDC subject, which carries the owner and repo IDs
  # (gh api repos/2026-Softbank-Hackathon-Charlie/rin/actions/oidc/customization/sub).
  github_ref = "repo:2026-Softbank-Hackathon-Charlie@350278309/rin@1443173546:ref:refs/heads/main"
}

# --- image registry ---

resource "aws_ecr_repository" "rin" {
  name                 = "hopcharlie/rin"
  image_tag_mutability = "MUTABLE" # a re-run of the workflow pushes the same sha tag again
  force_delete         = true      # destroy must not stop at leftover images

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "rin" {
  repository = aws_ecr_repository.rin.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep the last 20 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 20 }
      action       = { type = "expire" }
    }]
  })
}

# --- secrets generated here; the team's own secrets come from put-secrets.sh ---
#
# deploy/ec2/deploy.sh writes every /rin/* parameter to /run/rin.env on each deploy.

resource "random_password" "postgres" {
  length  = 32
  special = false
}

resource "aws_ssm_parameter" "postgres_password" {
  name  = "/rin/POSTGRES_PASSWORD"
  type  = "SecureString"
  value = random_password.postgres.result
}

# --- the AI's own AWS identity: can look at the account, cannot read secrets or data ---

resource "aws_iam_user" "ai" {
  name = "rin-ai"
}

resource "aws_iam_user_policy_attachment" "ai_view_only" {
  user       = aws_iam_user.ai.name
  policy_arn = "arn:aws:iam::aws:policy/job-function/ViewOnlyAccess"
}

# ViewOnlyAccess already leaves these out; the explicit Deny keeps them out even
# if someone attaches a broader policy later.
resource "aws_iam_user_policy" "ai_deny_secrets" {
  name = "deny-secret-reads"
  user = aws_iam_user.ai.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Deny"
      Action   = ["ssm:GetParameter*", "secretsmanager:GetSecretValue", "s3:GetObject", "kms:Decrypt"]
      Resource = "*"
    }]
  })
}

resource "aws_iam_access_key" "ai" {
  user = aws_iam_user.ai.name
}

resource "aws_ssm_parameter" "ai_access_key_id" {
  name  = "/rin/RIN_AI_AWS_ACCESS_KEY_ID"
  type  = "SecureString"
  value = aws_iam_access_key.ai.id
}

resource "aws_ssm_parameter" "ai_secret_access_key" {
  name  = "/rin/RIN_AI_AWS_SECRET_ACCESS_KEY"
  type  = "SecureString"
  value = aws_iam_access_key.ai.secret
}

# --- instance identity: SSM Session Manager and Run Command, its parameters, ECR pull ---

resource "aws_iam_role" "host" {
  name = "${local.name}-host"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "host_ssm_core" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "host" {
  name = "read-rin-parameters-and-image"
  role = aws_iam_role.host.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # parameter/rin is what GetParametersByPath checks for --path /rin.
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
        Resource = [local.parameter_arn, "${local.parameter_arn}/*"]
      },
      {
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = data.aws_kms_alias.ssm.target_key_arn
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
        Resource = aws_ecr_repository.rin.arn
      },
      {
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
    ]
  })
}

resource "aws_iam_instance_profile" "host" {
  name = "${local.name}-host"
  role = aws_iam_role.host.name
}

# --- network: nothing in, everything out (Slack Socket Mode, Anthropic, GitHub, ECR, SSM) ---

resource "aws_security_group" "host" {
  name        = "${local.name}-host"
  description = "Rin host: no inbound, all outbound"
  vpc_id      = data.aws_vpc.default.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "rin" {
  ami                         = data.aws_ssm_parameter.al2023.insecure_value
  instance_type               = "t3.large"
  subnet_id                   = sort(data.aws_subnets.default.ids)[0]
  vpc_security_group_ids      = [aws_security_group.host.id]
  iam_instance_profile        = aws_iam_instance_profile.host.name
  associate_public_ip_address = true # egress without a NAT gateway

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
    # The token answer cannot cross Docker's bridge, so containers cannot use
    # the instance role. Rin uses rin-ai's keys instead.
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 40
    encrypted   = true
  }

  # First boot only: Docker, the Compose plugin and /srv/rin. Deploys bring
  # everything else, so editing user_data never replaces the host (and its
  # PostgreSQL data).
  user_data                   = replace(file("${path.module}/user_data.sh"), "\r\n", "\n")
  user_data_replace_on_change = false

  tags = { Name = local.name }

  lifecycle {
    # A newer AL2023 AMI must not replace the host.
    ignore_changes = [ami, user_data]
  }
}

# --- GitHub Actions on main: push the image and run deploy.sh on the host ---

resource "aws_iam_role" "deploy" {
  name = "rin-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = local.github_ref
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "deploy" {
  name = "push-image-and-deploy"
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
        ]
        Resource = aws_ecr_repository.rin.arn
      },
      {
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = "ssm:SendCommand"
        Resource = [
          aws_instance.rin.arn,
          "arn:aws:ssm:${var.region}::document/AWS-RunShellScript",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]
        Resource = "*"
      },
    ]
  })
}
