# AWS Configuration
aws_region = "us-east-1"

# GitHub Configuration (Source repository)
# Create a Personal Access Token at: https://github.com/settings/tokens
# Required scopes: repo, workflow (for actions)
github_token  = "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"
github_owner  = "amruthkumartj"
github_repo   = "new-beta-pipeline"
github_branch = "main"

# AWS CodeCommit Configuration (Private app code repository)
# This is where your actual application source code lives (NOT in GitHub)
codecommit_repo_name = "uat-benevolate-beta"
codecommit_branch    = "main"

# ECR Configuration (Container registry)
ecr_repository_name = "amruthkumartj/deploy-watch"
docker_image_tag    = "latest"

# ECS Configuration (Deployment target)
ecs_cluster_name   = "uat-benevolate-beta"
ecs_service_name   = "deploy-watch-app"
ecs_container_name = "deploywatch"

# (Optional) Custom build configuration
build_timeout       = 15
build_compute_type  = "BUILD_GENERAL1_SMALL"

# (Optional) Custom artifact bucket name
# If not provided, Terraform will auto-generate: my-pipeline-artifacts-ACCOUNT_ID
# artifacts_bucket = "my-custom-artifacts-bucket"
