output "codepipeline_name" {
  description = "Name of the CodePipeline"
  value       = aws_codepipeline.app_pipeline.name
}

output "codepipeline_arn" {
  description = "ARN of the CodePipeline"
  value       = aws_codepipeline.app_pipeline.arn
}

output "codebuild_project_name" {
  description = "Name of the CodeBuild project"
  value       = aws_codebuild_project.app_build.name
}

output "artifacts_bucket" {
  description = "S3 bucket for pipeline artifacts"
  value       = aws_s3_bucket.pipeline_artifacts.bucket
}

output "cloudwatch_log_group" {
  description = "CloudWatch log group for CodeBuild logs"
  value       = aws_cloudwatch_log_group.codebuild_logs.name
}

output "codebuild_role_arn" {
  description = "ARN of the CodeBuild service role"
  value       = aws_iam_role.codebuild_role.arn
}

output "codepipeline_role_arn" {
  description = "ARN of the CodePipeline role"
  value       = aws_iam_role.codepipeline_role.arn
}

output "deployment_instructions" {
  description = "Instructions for monitoring deployments"
  value       = <<-EOT
    
    ✓ CodePipeline created successfully!
    
    Next steps:
    
    1. View pipeline progress:
       aws codepipeline start-pipeline-execution --pipeline-name ${aws_codepipeline.app_pipeline.name}
    
    2. Monitor in AWS Console:
       https://console.aws.amazon.com/codesuite/codepipeline/pipelines/${aws_codepipeline.app_pipeline.name}
    
    3. View CodeBuild logs:
       aws logs tail /aws/codebuild/${aws_codebuild_project.app_build.name} --follow
    
    4. Test the pipeline:
       - Push a commit to ${var.github_owner}/${var.github_repo} branch "${var.github_branch}"
       - Pipeline should automatically trigger
       - Monitor progress in AWS Console
    
    Artifacts stored in S3: ${aws_s3_bucket.pipeline_artifacts.bucket}
    
  EOT
}
