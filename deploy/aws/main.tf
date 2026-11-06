# AWS dependencies for Rin on GCP: ECR, SSM parameters and AWS identities.
# This root keeps the existing rin/terraform.tfstate ownership; the GCP host
# and rin-gcp-deploy-read policy are managed by the infra repository.

# One per account and already shared by other repos, so only referenced here.
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

locals {
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
# CI reads /rin/* and delivers a one-shot env to the GCP host over IAP.

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

# --- GitHub Actions on main: ECR push, then pull-only credentials for GCP ---

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
    ]
  })
}
