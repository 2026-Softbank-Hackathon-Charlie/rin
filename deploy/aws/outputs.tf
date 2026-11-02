output "instance_id" {
  description = "Rin host. GitHub repository variable RIN_INSTANCE_ID."
  value       = aws_instance.rin.id
}

output "ecr_repository_url" {
  value = aws_ecr_repository.rin.repository_url
}

output "deploy_role_arn" {
  description = "Role GitHub Actions assumes on main. GitHub repository variable RIN_DEPLOY_ROLE_ARN."
  value       = aws_iam_role.deploy.arn
}
