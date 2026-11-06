output "ecr_repository_url" {
  value = aws_ecr_repository.rin.repository_url
}

output "deploy_role_arn" {
  description = "Role GitHub Actions assumes on main. GitHub repository variable RIN_DEPLOY_ROLE_ARN."
  value       = aws_iam_role.deploy.arn
}
