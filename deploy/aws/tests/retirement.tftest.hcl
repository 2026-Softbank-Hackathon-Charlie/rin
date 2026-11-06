mock_provider "aws" {
  mock_data "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::525091405886:oidc-provider/token.actions.githubusercontent.com" }
  }
  mock_resource "aws_ecr_repository" {
    defaults = { arn = "arn:aws:ecr:ap-northeast-2:525091405886:repository/hopcharlie/rin" }
  }
}

mock_provider "random" {}

run "retained_aws_dependencies" {
  # Apply only materializes computed policy fields; both providers are mocked.
  command = apply

  assert {
    condition = (
      length(jsondecode(aws_iam_role_policy.deploy.policy).Statement) == 2 &&
      alltrue([for statement in jsondecode(aws_iam_role_policy.deploy.policy).Statement : statement.Effect == "Allow"]) &&
      toset(jsondecode(aws_iam_role_policy.deploy.policy).Statement[0].Action) == toset([
        "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
        "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload",
        "ecr:PutImage",
      ]) &&
      jsondecode(aws_iam_role_policy.deploy.policy).Statement[0].Resource == aws_ecr_repository.rin.arn &&
      jsondecode(aws_iam_role_policy.deploy.policy).Statement[1].Action == "ecr:GetAuthorizationToken" &&
      jsondecode(aws_iam_role_policy.deploy.policy).Statement[1].Resource == "*"
    )
    error_message = "The deploy role must retain scoped ECR push/pull permissions and token access, without obsolete EC2 commands."
  }

  assert {
    condition = (
      aws_iam_role.deploy.name == "rin-deploy" &&
      jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:2026-Softbank-Hackathon-Charlie@350278309/rin@1443173546:ref:refs/heads/main" &&
      aws_iam_user.ai.name == "rin-ai" &&
      aws_iam_user_policy_attachment.ai_view_only.policy_arn == "arn:aws:iam::aws:policy/job-function/ViewOnlyAccess" &&
      aws_ssm_parameter.postgres_password.name == "/rin/POSTGRES_PASSWORD" &&
      aws_ssm_parameter.ai_access_key_id.name == "/rin/RIN_AI_AWS_ACCESS_KEY_ID" &&
      aws_ssm_parameter.ai_secret_access_key.name == "/rin/RIN_AI_AWS_SECRET_ACCESS_KEY"
    )
    error_message = "The existing deployment trust, AI identity and SSM parameter names must remain stable."
  }
}
