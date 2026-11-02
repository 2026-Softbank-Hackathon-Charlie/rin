# Shared state in the platform's state bucket (platform/deploy/aws/state).
# S3 lock files keep two applies from running at once.
terraform {
  backend "s3" {
    bucket       = "hopcharlie-tfstate-525091405886-apne2"
    key          = "rin/terraform.tfstate"
    region       = "ap-northeast-2"
    encrypt      = true
    use_lockfile = true
  }
}
