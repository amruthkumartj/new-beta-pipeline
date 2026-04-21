# CodeBuild Service Role
resource "aws_iam_role" "codebuild_role" {
  name               = "codebuild-${local.sanitized_repo_name}-role"
  assume_role_policy = data.aws_iam_policy_document.codebuild_assume_role.json
}

data "aws_iam_policy_document" "codebuild_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

# CodeBuild - ECR Access
resource "aws_iam_role_policy" "codebuild_ecr_policy" {
  name   = "codebuild-${local.sanitized_repo_name}-ecr"
  role   = aws_iam_role.codebuild_role.id
  policy = data.aws_iam_policy_document.codebuild_ecr.json
}

data "aws_iam_policy_document" "codebuild_ecr" {
  statement {
    actions = [
      "ecr:GetAuthorizationToken",
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:PutImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
    ]
    resources = ["arn:aws:ecr:${var.aws_region}:${data.aws_caller_identity.current.account_id}:repository/${var.ecr_repository_name}"]
  }

  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
}

# CodeBuild - CodeCommit Access (to clone private repo)
resource "aws_iam_role_policy" "codebuild_codecommit_policy" {
  name   = "codebuild-${local.sanitized_repo_name}-codecommit"
  role   = aws_iam_role.codebuild_role.id
  policy = data.aws_iam_policy_document.codebuild_codecommit.json
}

data "aws_iam_policy_document" "codebuild_codecommit" {
  statement {
    actions = [
      "codecommit:GitPull",
      "codecommit:GetBranch",
      "codecommit:GetCommit",
    ]
    resources = ["arn:aws:codecommit:${var.aws_region}:${data.aws_caller_identity.current.account_id}:${var.codecommit_repo_name}"]
  }
}

# CodeBuild - CloudWatch Logs
resource "aws_iam_role_policy_attachment" "codebuild_logs_access" {
  role       = aws_iam_role.codebuild_role.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchLogsFullAccess"
}

# CodePipeline Service Role
resource "aws_iam_role" "codepipeline_role" {
  name               = "codepipeline-${local.sanitized_repo_name}-role"
  assume_role_policy = data.aws_iam_policy_document.codepipeline_assume_role.json
}

data "aws_iam_policy_document" "codepipeline_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codepipeline.amazonaws.com"]
    }
  }
}

# CodePipeline - S3 Artifacts Access
resource "aws_iam_role_policy" "codepipeline_s3_policy" {
  name   = "codepipeline-${local.sanitized_repo_name}-s3"
  role   = aws_iam_role.codepipeline_role.id
  policy = data.aws_iam_policy_document.codepipeline_s3.json
}

data "aws_iam_policy_document" "codepipeline_s3" {
  statement {
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
      "s3:GetBucketVersioning",
    ]
    resources = [
      aws_s3_bucket.pipeline_artifacts.arn,
      "${aws_s3_bucket.pipeline_artifacts.arn}/*",
    ]
  }
}

# CodePipeline - CodeBuild Permissions
resource "aws_iam_role_policy" "codepipeline_codebuild_policy" {
  name   = "codepipeline-${local.sanitized_repo_name}-codebuild"
  role   = aws_iam_role.codepipeline_role.id
  policy = data.aws_iam_policy_document.codepipeline_codebuild.json
}

data "aws_iam_policy_document" "codepipeline_codebuild" {
  statement {
    actions = [
      "codebuild:StartBuild",
      "codebuild:BatchGetBuilds",
      "codebuild:BatchGetReports",
      "codebuild:List*",
      "codebuild:DescribeCodeCoverages",
      "codebuild:DescribeTestCases",
      "codebuild:CreateReportGroup",
      "codebuild:CreateReport",
      "codebuild:UpdateReport",
      "codebuild:CoverageReportGenerated",
      "codebuild:BatchPutTestReports",
      "codebuild:BatchPutCodeCoverages",
    ]
    resources = [
      "arn:aws:codebuild:${var.aws_region}:${data.aws_caller_identity.current.account_id}:project/${aws_codebuild_project.app_build.name}",
    ]
  }

  statement {
    actions = [
      "codebuild:BatchGetBuilds",
      "codebuild:BatchGetReports",
    ]
    resources = ["*"]
  }
}

# CodePipeline - ECS Deploy Permission
resource "aws_iam_role_policy" "codepipeline_ecs_policy" {
  name   = "codepipeline-${local.sanitized_repo_name}-ecs"
  role   = aws_iam_role.codepipeline_role.id
  policy = data.aws_iam_policy_document.codepipeline_ecs.json
}

data "aws_iam_policy_document" "codepipeline_ecs" {
  statement {
    actions = [
      "ecs:DescribeServices",
      "ecs:DescribeTaskDefinition",
      "ecs:DescribeTasks",
      "ecs:ListTasks",
      "ecs:ListTaskDefinitions",
      "ecs:UpdateService",
    ]
    resources = ["*"]
  }

  statement {
    actions = [
      "iam:PassRole",
    ]
    resources = ["*"]
  }
}

# CodePipeline - Pass Role (for ECS)
resource "aws_iam_role_policy" "codepipeline_pass_role" {
  name   = "codepipeline-${local.sanitized_repo_name}-pass-role"
  role   = aws_iam_role.codepipeline_role.id
  policy = data.aws_iam_policy_document.codepipeline_pass_role.json
}

data "aws_iam_policy_document" "codepipeline_pass_role" {
  statement {
    actions = [
      "iam:PassRole",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}
