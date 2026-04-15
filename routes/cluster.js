const express = require('express');
const router = express.Router();
const {
  ElasticLoadBalancingV2Client,
  DescribeRulesCommand,
  ModifyRuleCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
} = require('@aws-sdk/client-elastic-load-balancing-v2');
const {
  ECSClient,
  DescribeServicesCommand,
  DescribeClustersCommand,
  ListTasksCommand,
  DescribeTasksCommand,
} = require('@aws-sdk/client-ecs');

const albClient = new ElasticLoadBalancingV2Client({ region: process.env.AWS_REGION });
const ecsClient = new ECSClient({ region: process.env.AWS_REGION });

// ─────────────────────────────────────────────
// GET /api/clusters
// Returns status of both clusters + current traffic routing
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const [c2, c3, rule] = await Promise.all([
      getClusterInfo(process.env.ECS_CLUSTER_PROD, process.env.ECS_SERVICE_PROD),
      getClusterInfo(process.env.ECS_CLUSTER_BETA, process.env.ECS_SERVICE_BETA),
      getCurrentRouting(),
    ]);

    res.json({
      prod: { ...c2, name: 'Cluster 2 · Production', version: 'v1.2' },
      beta: { ...c3, name: 'Cluster 3 · Beta', version: 'v1.3' },
      routing: rule,
    });
  } catch (err) {
    console.error('GET /api/clusters error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/clusters/switch
// Swaps the ALB listener rule to point ?betaversion at the chosen cluster.
//
// Body: { target: "beta" | "prod" }
//
// HOW IT WORKS:
//  The ALB has TWO listener rules on port 443:
//   Rule 1 (Priority 1): condition = QueryString key=betaversion exists
//                        → forward to TARGET_GROUP_BETA_ARN
//   Rule 2 (default):    forward to TARGET_GROUP_PROD_ARN
//
//  When you call this endpoint with target="beta", Rule 1 stays as-is.
//  When you call it with target="prod", we modify Rule 1 to forward to
//  TARGET_GROUP_PROD_ARN, effectively making ?betaversion hit production too.
//  (Useful for instant rollback.)
// ─────────────────────────────────────────────
router.post('/switch', async (req, res) => {
  const { target } = req.body; // "beta" | "prod"
  if (!['beta', 'prod'].includes(target)) {
    return res.status(400).json({ error: 'target must be "beta" or "prod"' });
  }

  try {
    const targetGroupArn =
      target === 'beta'
        ? process.env.TARGET_GROUP_BETA_ARN
        : process.env.TARGET_GROUP_PROD_ARN;

    // Modify the existing ?betaversion listener rule to forward to chosen TG
    await albClient.send(
      new ModifyRuleCommand({
        RuleArn: process.env.ALB_BETA_RULE_ARN,
        Actions: [
          {
            Type: 'forward',
            TargetGroupArn: targetGroupArn,
          },
        ],
      })
    );

    res.json({
      success: true,
      message: `Traffic for ?betaversion now routed to ${target} cluster`,
      target,
      targetGroupArn,
    });
  } catch (err) {
    console.error('POST /api/clusters/switch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/clusters/target-groups
// Lists health of both target groups (useful for pre-switch validation)
// ─────────────────────────────────────────────
router.get('/target-groups', async (req, res) => {
  try {
    const arns = [process.env.TARGET_GROUP_PROD_ARN, process.env.TARGET_GROUP_BETA_ARN];

    const [tgDesc, healthResults] = await Promise.all([
      albClient.send(new DescribeTargetGroupsCommand({ TargetGroupArns: arns })),
      Promise.all(
        arns.map((arn) =>
          albClient.send(new DescribeTargetHealthCommand({ TargetGroupArn: arn }))
        )
      ),
    ]);

    const groups = tgDesc.TargetGroups.map((tg, i) => {
      const health = healthResults[i].TargetHealthDescriptions;
      return {
        arn: tg.TargetGroupArn,
        name: tg.TargetGroupName,
        protocol: tg.Protocol,
        port: tg.Port,
        healthyCount: health.filter((h) => h.TargetHealth.State === 'healthy').length,
        unhealthyCount: health.filter((h) => h.TargetHealth.State !== 'healthy').length,
        totalCount: health.length,
      };
    });

    res.json({ targetGroups: groups });
  } catch (err) {
    console.error('GET /api/clusters/target-groups error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
async function getClusterInfo(clusterName, serviceName) {
  const [svcResp, clusterResp] = await Promise.all([
    ecsClient.send(
      new DescribeServicesCommand({ cluster: clusterName, services: [serviceName] })
    ),
    ecsClient.send(new DescribeClustersCommand({ clusters: [clusterName] })),
  ]);

  const svc = svcResp.services[0] || {};
  const cluster = clusterResp.clusters[0] || {};

  return {
    clusterName,
    serviceName,
    status: svc.status,
    runningCount: svc.runningCount || 0,
    desiredCount: svc.desiredCount || 0,
    pendingCount: svc.pendingCount || 0,
    registeredContainerInstancesCount: cluster.registeredContainerInstancesCount || 0,
    taskDefinition: svc.taskDefinition,
    deployments: (svc.deployments || []).map((d) => ({
      id: d.id,
      status: d.status,
      taskDef: d.taskDefinition,
      runningCount: d.runningCount,
      rolloutState: d.rolloutState,
    })),
  };
}

async function getCurrentRouting() {
  try {
    const resp = await albClient.send(
      new DescribeRulesCommand({ RuleArns: [process.env.ALB_BETA_RULE_ARN] })
    );
    const rule = resp.Rules[0];
    const action = rule?.Actions[0];
    const currentTgArn = action?.TargetGroupArn || '';
    return {
      ruleArn: process.env.ALB_BETA_RULE_ARN,
      currentTargetGroupArn: currentTgArn,
      routingTo:
        currentTgArn === process.env.TARGET_GROUP_BETA_ARN ? 'beta' : 'prod',
    };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = router;