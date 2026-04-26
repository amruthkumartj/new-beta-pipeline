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
// Body: { target: "beta" | "prod", force?: boolean }
//
// HOW IT WORKS:
//  The ALB has TWO listener rules on port 443:
//   Rule 1 (Priority 1): condition = QueryString key=betaversion exists
//                        → forward to TARGET_GROUP_BETA_ARN
//   Rule 2 (default):    forward to TARGET_GROUP_PROD_ARN
//
//  When you call this endpoint with target="beta", Rule 1 routes to beta TG.
//  When you call it with target="prod", we modify Rule 1 to route to prod TG.
//
//  BEFORE switching, we validate the target group has healthy instances.
//  Pass force=true to skip health checks (emergency rollback only).
// ─────────────────────────────────────────────
router.post('/switch', async (req, res) => {
  const { target, force } = req.body; // target: "beta" | "prod", force?: bool
  if (!['beta', 'prod'].includes(target)) {
    return res.status(400).json({ error: 'target must be "beta" or "prod"' });
  }

  try {
    const targetGroupArn =
      target === 'beta'
        ? process.env.TARGET_GROUP_BETA_ARN
        : process.env.TARGET_GROUP_PROD_ARN;

    // Pre-flight check: verify target group has healthy instances
    if (!force) {
      const healthCheck = await checkTargetGroupHealth(targetGroupArn, target);
      if (!healthCheck.healthy) {
        return res.status(503).json({
          error: `Cannot switch to ${target}: ${healthCheck.reason}`,
          details: healthCheck.details,
          healthy: false,
        });
      }
    }

    const betaRuleArn = await resolveBetaRuleArn();

    // Modify the existing ?betaversion listener rule to forward to chosen TG
    await albClient.send(
      new ModifyRuleCommand({
        RuleArn: betaRuleArn,
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
      healthChecked: !force,
    });
  } catch (err) {
    console.error('POST /api/clusters/switch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/clusters/health
// Pre-flight check: validates target group health before switch
// ─────────────────────────────────────────────
router.get('/health', async (req, res) => {
  try {
    const betaHealth = await checkTargetGroupHealth(
      process.env.TARGET_GROUP_BETA_ARN,
      'beta'
    );
    const prodHealth = await checkTargetGroupHealth(
      process.env.TARGET_GROUP_PROD_ARN,
      'prod'
    );

    res.json({
      beta: betaHealth,
      prod: prodHealth,
      canSwitchToBeta: betaHealth.healthy,
      canSwitchToProd: prodHealth.healthy,
    });
  } catch (err) {
    console.error('GET /api/clusters/health error:', err);
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
  const svcResp = await ecsClient.send(
    new DescribeServicesCommand({ cluster: clusterName, services: [serviceName] })
  );

  let clusterResp = { clusters: [] };
  try {
    clusterResp = await ecsClient.send(new DescribeClustersCommand({ clusters: [clusterName] }));
  } catch (err) {
    if (!isAccessDenied(err)) {
      throw err;
    }
  }

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


async function checkTargetGroupHealth(targetGroupArn, name) {
  try {
    const resp = await albClient.send(
      new DescribeTargetHealthCommand({ TargetGroupArn: targetGroupArn })
    );

    const targets = resp.TargetHealthDescriptions || [];
    const healthy = targets.filter((t) => t.TargetHealth.State === 'healthy');
    const unhealthy = targets.filter((t) => t.TargetHealth.State !== 'healthy');

    const isHealthy = healthy.length > 0;

    return {
      cluster: name,
      targetGroupArn,
      healthy: isHealthy,
      healthyCount: healthy.length,
      unhealthyCount: unhealthy.length,
      totalCount: targets.length,
      reason: isHealthy
        ? `${healthy.length}/${targets.length} targets healthy`
        : `No healthy targets (${unhealthy.length} unhealthy)`,
      details: {
        healthy: healthy.map((t) => ({
          id: t.Target?.Id,
          port: t.Target?.Port,
          state: t.TargetHealth.State,
        })),
        unhealthy: unhealthy.map((t) => ({
          id: t.Target?.Id,
          port: t.Target?.Port,
          state: t.TargetHealth.State,
          reason: t.TargetHealth.Reason,
          description: t.TargetHealth.Description,
        })),
      },
    };
  } catch (err) {
    return {
      cluster: name,
      targetGroupArn,
      healthy: false,
      reason: `Failed to check health: ${err.message}`,
      error: err.message,
    };
  }
}

function isAccessDenied(err) {
  const message = `${err?.name || ''} ${err?.message || ''}`.toLowerCase();
  return message.includes('accessdenied') || message.includes('not authorized');
}
async function getCurrentRouting() {
  try {
    const betaRuleArn = await resolveBetaRuleArn();
    const resp = await albClient.send(
      new DescribeRulesCommand({ RuleArns: [betaRuleArn] })
    );
    const rule = resp.Rules[0];
    const action = rule?.Actions[0];
    const currentTgArn = action?.TargetGroupArn || '';
    return {
      ruleArn: betaRuleArn,
      currentTargetGroupArn: currentTgArn,
      routingTo:
        currentTgArn === process.env.TARGET_GROUP_BETA_ARN ? 'beta' : 'prod',
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function resolveBetaRuleArn() {
  const explicitRuleArn = process.env.ALB_BETA_RULE_ARN;
  if (explicitRuleArn && explicitRuleArn.includes(':listener-rule/')) {
    return explicitRuleArn;
  }

  const listenerArn = process.env.ALB_BETA_LISTENER_ARN;
  if (!listenerArn || !listenerArn.includes(':listener/')) {
    throw new Error(
      'ALB beta rule configuration missing. Set ALB_BETA_RULE_ARN (listener-rule ARN) or ALB_BETA_LISTENER_ARN (listener ARN).'
    );
  }

  const resp = await albClient.send(new DescribeRulesCommand({ ListenerArn: listenerArn }));
  const rules = resp.Rules || [];

  const betaRule = rules.find((rule) =>
    (rule.Conditions || []).some((condition) => {
      if (condition.Field !== 'query-string') {
        return false;
      }
      const values = condition.QueryStringConfig?.Values || [];
      return values.some(
        (v) =>
          (v.Key && v.Key.toLowerCase() === 'betaversion') ||
          (v.Value && v.Value.toLowerCase() === 'betaversion')
      );
    })
  );

  if (!betaRule?.RuleArn) {
    throw new Error(
      'Unable to find ALB listener rule for query-string betaversion on ALB_BETA_LISTENER_ARN.'
    );
  }

  return betaRule.RuleArn;
}

module.exports = router;