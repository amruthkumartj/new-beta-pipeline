variable "aws_region" {
  description = "AWS region for resources"
  type        = string
  default     = "us-east-1"
}

variable "github_token" {
  description = "GitHub Personal Access Token (repo scope)"
  type        = string
  sensitive   = true
}

variable "github_owner" {
  description = "GitHub repository owner/username"
  type        = string
}

variable "github_repo" {
  description = "GitHub repository name"
  type        = string
}

variable "github_branch" {
  description = "GitHub branch to trigger on"
  type        = string
  default     = "main"
}

variable "codecommit_repo_name" {
  description = "AWS CodeCommit repository name (private app code)"
  type        = string
}

variable "codecommit_branch" {
  description = "CodeCommit branch to pull from"
  type        = string
  default     = "main"
}

variable "ecr_repository_name" {
  description = "ECR repository name where Docker images are pushed"
  type        = string
}

variable "docker_image_tag" {
  description = "Docker image tag (usually latest or commit SHA)"
  type        = string
  default     = "latest"
}

variable "ecs_cluster_name" {
  description = "ECS cluster name to deploy to"
  type        = string
}

variable "ecs_service_name" {
  description = "ECS service name to update"
  type        = string
}

variable "ecs_container_name" {
  description = "Container name in task definition"
  type        = string
}

variable "codebuild_service_role" {
  description = "Name of CodeBuild service role"
  type        = string
  default     = "CodeBuildServiceRole"
}

variable "codepipeline_role" {
  description = "Name of CodePipeline role"
  type        = string
  default     = "CodePipelineServiceRole"
}

variable "artifacts_bucket" {
  description = "S3 bucket for pipeline artifacts (auto-generated if not provided)"
  type        = string
  default     = ""
}

variable "build_timeout" {
  description = "CodeBuild timeout in minutes"
  type        = number
  default     = 15
}

variable "build_compute_type" {
  description = "CodeBuild compute type"
  type        = string
  default     = "BUILD_GENERAL1_SMALL"
}
