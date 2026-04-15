const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const {
  ECSClient,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
  DescribeTaskDefinitionCommand,
} = require('@aws-sdk/client-ecs');

const ecs = new ECSClient({ region: process.env.AWS_REGION });

// ─────────────────────────────────────────────
// Verify GitHub webhook signature
// HOW TO SET UP THE WEBHOOK SECRET:
//   GitHub → Your repo → Settings → Webhooks → Add webhook
//   Payload URL: https://your-domain.com/webhook/github
//   Content type: application/json
//   Secret: paste the value of GITHUB_WEBHOOK_SECRET from your .env
//   Events: "Just the push event"
// ─────────────────────────────────────────────
function verifyGithubSignature(req) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return true; // skip if not configured (dev only)

  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return false;

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(JSON.stringify(req.body));
  const digest = `sha256=${hmac.digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest));
}

// Deployment log (in-memory, last 50 entries)
const deployLog = [];
function addLog(entry) {
  deployLog.unshift({ ...entry, ts: new Date().toISOString() });
  if (deployLog.length > 50) deployLog.pop();
}

// ─────────────────────────────────────────────
// POST /webhook/github
// Receives push events from GitHub, deploys to the configured cluster.
//
// Environment:
//   DEPLOY_BRANCH       = "main" (only deploy on push to this branch)
//   DEPLOY_TARGET       = "beta" | "prod" (which cluster to update)
//   ECR_IMAGE_URI       = "123456789.dkr.ecr.us-east-1.amazonaws.com/my-app"
//   ECS_TASK_FAMILY_BETA= task definition family name for beta
//   ECS_TASK_FAMILY_PROD= task definition family name for prod
// ─────────────────────────────────────────────
router.post('/github', async (req, res) => {
  if (!verifyGithubSignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.headers['x-github-event'];

  // Only act on push events
  if (event !== 'push') {
    return res.json({ ignored: true, event });
  }

  const { ref, after: commitSha, repository, pusher } = req.body;
  const branch = ref?.replace('refs/heads/', '');
  const deployBranch = process.env.DEPLOY_BRANCH || 'main';

  if (branch !== deployBranch) {
    addLog({ branch, commitSha, status: 'skipped', reason: `Not ${deployBranch}` });
    return res.json({ ignored: true, reason: `Branch ${branch} not ${deployBranch}` });
  }

  const deployTarget = process.env.DEPLOY_TARGET || 'beta'; // default: deploy to beta
  const clusterName =
    deployTarget === 'prod' ? process.env.ECS_CLUSTER_PROD : process.env.ECS_CLUSTER_BETA;
  const serviceName =
    deployTarget === 'prod' ? process.env.ECS_SERVICE_PROD : process.env.ECS_SERVICE_BETA;
  const taskFamily =
    deployTarget === 'prod'
      ? process.env.ECS_TASK_FAMILY_PROD
      : process.env.ECS_TASK_FAMILY_BETA;

  // Ack GitHub immediately (must respond < 10s)
  res.json({ received: true, commitSha, branch, deployTarget });

  // Run deployment async
  deployToECS({ commitSha, clusterName, serviceName, taskFamily, branch, pusher });
});

async function deployToECS({ commitSha, clusterName, serviceName, taskFamily, branch, pusher }) {
  const shortSha = commitSha?.slice(0, 7) || 'unknown';
  addLog({ commitSha: shortSha, clusterName, serviceName, status: 'started' });

  try {
    // 1. Get current task definition to copy its config
    const currentDef = await ecs.send(
      new DescribeTaskDefinitionCommand({ taskDefinition: taskFamily })
    );
    const td = currentDef.taskDefinition;

    // 2. Register new task definition revision with updated image tag
    // The image tag is the commit SHA — your CI/CD must push:
    //   docker push ${ECR_IMAGE_URI}:${commitSha}
    const newImageUri = `${process.env.ECR_IMAGE_URI}:${commitSha}`;

    const containerDefs = td.containerDefinitions.map((c) => ({
      ...c,
      image: c.name === process.env.APP_CONTAINER_NAME ? newImageUri : c.image,
    }));

    const newTaskDef = await ecs.send(
      new RegisterTaskDefinitionCommand({
        family: taskFamily,
        containerDefinitions: containerDefs,
        taskRoleArn: td.taskRoleArn,
        executionRoleArn: td.executionRoleArn,
        networkMode: td.networkMode,
        requiresCompatibilities: td.requiresCompatibilities,
        cpu: td.cpu,
        memory: td.memory,
        volumes: td.volumes,
        tags: [
          { key: 'deploy-commit', value: commitSha },
          { key: 'deploy-branch', value: branch },
          { key: 'deployed-by', value: pusher?.name || 'webhook' },
        ],
      })
    );

    const newRevision = newTaskDef.taskDefinition.taskDefinitionArn;
    addLog({ commitSha: shortSha, status: 'task-def-registered', revision: newRevision });

    // 3. Update the ECS service with the new task definition
    await ecs.send(
      new UpdateServiceCommand({
        cluster: clusterName,
        service: serviceName,
        taskDefinition: newRevision,
        forceNewDeployment: true,
      })
    );

    addLog({ commitSha: shortSha, clusterName, serviceName, status: 'service-updated', success: true });
    console.log(`[Deploy] ✓ ${shortSha} → ${serviceName} on ${clusterName}`);
  } catch (err) {
    addLog({ commitSha: shortSha, status: 'error', error: err.message });
    console.error(`[Deploy] ✗ ${shortSha} failed:`, err.message);
  }
}

// ─────────────────────────────────────────────
// GET /webhook/github/log
// Returns recent deployment log entries for the dashboard
// ─────────────────────────────────────────────
router.get('/github/log', (req, res) => {
  res.json({ log: deployLog });
});

// ─────────────────────────────────────────────
// POST /webhook/github/deploy-manual
// Trigger a manual deploy without a GitHub push event
// Body: { commitSha, target: "beta" | "prod" }
// ─────────────────────────────────────────────
router.post('/github/deploy-manual', async (req, res) => {
  const { commitSha = 'latest', target = 'beta' } = req.body;

  const clusterName = target === 'prod' ? process.env.ECS_CLUSTER_PROD : process.env.ECS_CLUSTER_BETA;
  const serviceName = target === 'prod' ? process.env.ECS_SERVICE_PROD : process.env.ECS_SERVICE_BETA;
  const taskFamily = target === 'prod' ? process.env.ECS_TASK_FAMILY_PROD : process.env.ECS_TASK_FAMILY_BETA;

  res.json({ received: true, commitSha, target, clusterName, serviceName });

  deployToECS({ commitSha, clusterName, serviceName, taskFamily, branch: 'manual', pusher: { name: 'dashboard' } });
});

module.exports = router;