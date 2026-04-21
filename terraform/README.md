# Deploy-Watch Infrastructure as Code

## Architecture Overview

This Terraform configuration implements an **AWS CodePipeline-based CI/CD** system that replaces GitHub webhooks with industry-standard AWS-native services.

### How It Works

```
Developer Push
    ↓
GitHub (source only, via OAuth/PAT)
    ↓
AWS CodePipeline (triggered by GitHub change detection)
    ↓
AWS CodeBuild (builds Docker image, pushes to ECR)
    ↓
ECS Task Definition Updated
    ↓
Fargate Cluster (auto-deploys via service update)
```

### Key Benefits

✓ **No Webhooks**: Pipeline built into AWS services, not your app  
✓ **Code-Restricted**: App code stays in CodeCommit; only IaC in GitHub  
✓ **Native Audit Trail**: All deployments logged in CloudTrail  
✓ **IAM-Based Security**: Fine-grained role-based access control  
✓ **Auto-Rollback**: Failed deployments automatically roll back  
✓ **No Public Exposure**: Pipeline doesn't require your app to be internet-facing

## Repository Structure (Recommended)

```
GitHub (Public/Private)
├── terraform/              ← All infrastructure code
│   ├── main.tf
│   ├── codepipeline.tf
│   ├── codebuild.tf
│   ├── iam-roles.tf
│   ├── variables.tf
│   └── terraform.tfvars    ← (Git-ignored, set locally)
└── buildspec.yml           ← CodeBuild instructions

AWS CodeCommit (Private, VPC-Internal)
└── app-code/
    ├── src/
    ├── package.json
    ├── Dockerfile
    └── ... (proprietary code)
```

## Prerequisites

1. **AWS Account** with appropriate permissions
2. **Terraform** (v1.0+) installed locally
3. **AWS CLI** configured with credentials
4. **GitHub Personal Access Token** (repo scope) or OAuth app
5. **AWS CodeCommit** repository with your app code
6. **ECR Repository** for Docker images

## Setup Steps

### 1. Create CodeCommit Repository

```bash
aws codecommit create-repository \
  --repository-name my-app-code \
  --description "Private app code (not in GitHub)"
```

### 2. Configure Terraform Variables

Create `terraform.tfvars`:

```hcl
aws_region              = "us-east-1"
github_token            = "ghp_xxxxxxxxxxxxxxxxxxxx"  # Personal Access Token
github_owner            = "your-github-username"
github_repo             = "your-repo-name"
github_branch           = "main"

codecommit_repo_name    = "my-app-code"
codecommit_branch       = "main"

ecr_repository_name     = "my-app"
docker_image_tag        = "latest"

ecs_cluster_name        = "cluster-3-beta"
ecs_service_name        = "my-app-service"
ecs_container_name      = "my-app"

codebuild_service_role  = "CodeBuildServiceRole"
codepipeline_role       = "CodePipelineServiceRole"
artifacts_bucket        = "my-pipeline-artifacts-${data.aws_caller_identity.current.account_id}"
```

### 3. Deploy Infrastructure

```bash
cd terraform
terraform init
terraform plan
terraform apply
```

### 4. (Optional) Modify buildspec.yml

The included `buildspec.yml` handles:

- Building Docker image
- Pushing to ECR
- Creating new ECS task definition
- Updating service

Customize for your build steps.

## Environment Variables in CodeBuild

Available in buildspec.yml:

```bash
$AWS_ACCOUNT_ID        # AWS Account number
$AWS_DEFAULT_REGION    # Region (e.g., us-east-1)
$IMAGE_REPO_NAME       # ECR repo name
$IMAGE_TAG             # Commit SHA (auto-set)
$REPOSITORY_NAME       # CodeCommit repo
$BRANCH_NAME           # Git branch
```

## Monitoring Deployments

### CloudWatch Logs

```bash
# View CodeBuild logs
aws logs tail /aws/codebuild/my-app-pipeline-build --follow

# View CodePipeline execution history
aws codepipeline list-pipeline-executions \
  --pipeline-name my-app-pipeline
```

### AWS Console

1. Navigate to CodePipeline → Pipelines → my-app-pipeline
2. Watch real-time deployment progress
3. Click each stage to view detailed logs

## Security Best Practices

### 1. GitHub Token Management

**Never commit tokens to Git!**

- Create Personal Access Token with minimal scopes (repo:read, webhook:write)
- Store in AWS Secrets Manager:

```bash
aws secretsmanager create-secret \
  --name github-deploy-token \
  --secret-string "ghp_xxxx"
```

- Reference in Terraform:

```hcl
data "aws_secretsmanager_secret_version" "github_token" {
  secret_id = "github-deploy-token"
}
```

### 2. IAM Roles

- CodeBuild role only has permission to push to specific ECR repo
- CodePipeline role only has permission to trigger deployments
- ECS service role handles runtime app permissions

### 3. Secrets in Application

Use **AWS Secrets Manager** or **Parameter Store** for app secrets:

```bash
# In buildspec.yml
- aws secretsmanager get-secret-value --secret-id my-app-secrets
```

## Troubleshooting

### Pipeline Fails at "Build" Stage

1. Check CodeBuild logs:

```bash
aws logs tail /aws/codebuild/my-app-pipeline-build --follow
```

2. Common issues:

- Docker image build failure → check Dockerfile
- ECR push failure → check IAM role has ECR push permission
- Buildspec syntax error → validate buildspec.yml

### ECS Update Fails

1. Check task definition:

```bash
aws ecs describe-task-definition \
  --task-definition my-app:latest
```

2. Check service:

```bash
aws ecs describe-services \
  --cluster cluster-3-beta \
  --services my-app-service
```

## Cost Optimization

- CodePipeline: **$1/month** flat rate
- CodeBuild: **$0.005/build minute** (free tier: 100 min/month)
- ECR storage: **$0.10/GB/month**
- S3 artifacts: **minimal** (~$0.01/month)

Total: ~$10-20/month for typical usage

## Migration from Webhooks

### Before (Old)

```
GitHub Push → Your App (webhook) → AWS API calls
```

### After (New)

```
GitHub Push → CodePipeline → CodeBuild → ECR → ECS
Your App: No deployment responsibilities (read-only API access)
```

**Next Steps:**

1. Deploy this infrastructure
2. Trigger a test push to verify pipeline works
3. Remove webhook from GitHub repo
4. Remove `/webhook` routes from server.js (optional, cleanup)

## Advanced: Multi-Environment Pipelines

To deploy to BOTH prod and beta:

```hcl
# Deploy to both clusters
resource "aws_codepipeline" "prod_pipeline" {
  name = "my-app-pipeline-prod"
  # ... same config, but targets prod cluster
}

resource "aws_codepipeline" "beta_pipeline" {
  name = "my-app-pipeline-beta"
  # ... same config, but targets beta cluster
}
```

## Support

For issues or questions:

1. Check CloudWatch Logs
2. Review Terraform plan output
3. Verify AWS permissions
4. Check GitHub token scope

---

**Last Updated**: 2026-04-21
