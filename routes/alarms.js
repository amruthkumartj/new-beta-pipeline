const express = require('express');
const router = express.Router();
const {
  CloudWatchClient,
  PutMetricAlarmCommand,
  DescribeAlarmsCommand,
  DeleteAlarmsCommand,
  EnableAlarmActionsCommand,
  DisableAlarmActionsCommand,
} = require('@aws-sdk/client-cloudwatch');

const cw = new CloudWatchClient({ region: process.env.AWS_REGION });

// ─────────────────────────────────────────────
// GET /api/alarms
// Lists all CloudWatch alarms for both clusters
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const resp = await cw.send(
      new DescribeAlarmsCommand({
        AlarmNamePrefix: process.env.ALARM_PREFIX || 'deploywatch-',
        MaxRecords: 50,
      })
    );

    const alarms = (resp.MetricAlarms || []).map((a) => ({
      name: a.AlarmName,
      description: a.AlarmDescription,
      state: a.StateValue,          // OK | ALARM | INSUFFICIENT_DATA
      stateReason: a.StateReason,
      metric: a.MetricName,
      namespace: a.Namespace,
      threshold: a.Threshold,
      comparisonOperator: a.ComparisonOperator,
      dimensions: a.Dimensions,
      evaluationPeriods: a.EvaluationPeriods,
      period: a.Period,
      statistic: a.Statistic,
      actionsEnabled: a.ActionsEnabled,
      alarmActions: a.AlarmActions,   // SNS topic ARNs
      updatedAt: a.StateUpdatedTimestamp,
    }));

    res.json({ alarms });
  } catch (err) {
    console.error('GET /api/alarms error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/alarms
// Creates or updates a CloudWatch alarm
//
// Body:
// {
//   name: "deploywatch-prod-cpu-high",
//   description: "Prod cluster CPU above 80%",
//   metric: "CPUUtilization",
//   namespace: "AWS/ECS",
//   dimensions: [{ Name: "ClusterName", Value: "prod-cluster" }],
//   threshold: 80,
//   comparisonOperator: "GreaterThanThreshold",
//   evaluationPeriods: 2,
//   period: 60,
//   statistic: "Average",
//   snsTopicArn: "arn:aws:sns:us-east-1:123456789:my-alerts"
// }
//
// HOW TO GET SNS TOPIC ARN:
//   AWS Console → SNS → Topics → create or select → copy ARN
// ─────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    name,
    description,
    metric,
    namespace,
    dimensions,
    threshold,
    comparisonOperator = 'GreaterThanThreshold',
    evaluationPeriods = 2,
    period = 60,
    statistic = 'Average',
    snsTopicArn,
  } = req.body;

  if (!name || !metric || !namespace || threshold == null) {
    return res.status(400).json({ error: 'name, metric, namespace, threshold required' });
  }

  const alarmName = name.startsWith('deploywatch-') ? name : `deploywatch-${name}`;

  try {
    await cw.send(
      new PutMetricAlarmCommand({
        AlarmName: alarmName,
        AlarmDescription: description || `Alarm: ${metric} ${comparisonOperator} ${threshold}`,
        MetricName: metric,
        Namespace: namespace,
        Dimensions: dimensions || [],
        Threshold: Number(threshold),
        ComparisonOperator: comparisonOperator,
        EvaluationPeriods: Number(evaluationPeriods),
        Period: Number(period),
        Statistic: statistic,
        ActionsEnabled: true,
        AlarmActions: snsTopicArn ? [snsTopicArn] : [],
        OKActions: snsTopicArn ? [snsTopicArn] : [],
        TreatMissingData: 'notBreaching',
      })
    );

    res.json({ success: true, alarmName });
  } catch (err) {
    console.error('POST /api/alarms error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/alarms/:name
// Deletes a CloudWatch alarm
// ─────────────────────────────────────────────
router.delete('/:name', async (req, res) => {
  try {
    await cw.send(new DeleteAlarmsCommand({ AlarmNames: [req.params.name] }));
    res.json({ success: true, deleted: req.params.name });
  } catch (err) {
    console.error('DELETE /api/alarms error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/alarms/:name/enable-actions
// Enables AlarmActions/OKActions execution for one alarm
// ─────────────────────────────────────────────
router.post('/:name/enable-actions', async (req, res) => {
  try {
    await cw.send(new EnableAlarmActionsCommand({ AlarmNames: [req.params.name] }));
    res.json({ success: true, alarm: req.params.name, actionsEnabled: true });
  } catch (err) {
    console.error('POST /api/alarms/:name/enable-actions error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/alarms/:name/disable-actions
// Disables AlarmActions/OKActions execution for one alarm
// ─────────────────────────────────────────────
router.post('/:name/disable-actions', async (req, res) => {
  try {
    await cw.send(new DisableAlarmActionsCommand({ AlarmNames: [req.params.name] }));
    res.json({ success: true, alarm: req.params.name, actionsEnabled: false });
  } catch (err) {
    console.error('POST /api/alarms/:name/disable-actions error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/alarms/options
// Returns UI options for alarm setup forms
// ─────────────────────────────────────────────
router.get('/options', async (_req, res) => {
  const ecsProdCluster = process.env.ECS_CLUSTER_PROD;
  const ecsProdService = process.env.ECS_SERVICE_PROD;
  const ecsBetaCluster = process.env.ECS_CLUSTER_BETA;
  const ecsBetaService = process.env.ECS_SERVICE_BETA;
  const prodTargetGroup = process.env.TARGET_GROUP_PROD_ARN?.split(':').pop() || '';
  const betaTargetGroup = process.env.TARGET_GROUP_BETA_ARN?.split(':').pop() || '';

  res.json({
    comparisonOperators: [
      'GreaterThanThreshold',
      'GreaterThanOrEqualToThreshold',
      'LessThanThreshold',
      'LessThanOrEqualToThreshold',
    ],
    statistics: ['Average', 'Maximum', 'Minimum', 'Sum', 'p90', 'p95', 'p99'],
    periods: [60, 120, 300, 600],
    evaluationPeriods: [1, 2, 3, 5, 10],
    recommendedMetrics: [
      {
        label: 'ECS CPU Utilization (Prod)',
        metric: 'CPUUtilization',
        namespace: 'AWS/ECS',
        dimensions: [
          { Name: 'ClusterName', Value: ecsProdCluster },
          { Name: 'ServiceName', Value: ecsProdService },
        ],
      },
      {
        label: 'ECS Memory Utilization (Prod)',
        metric: 'MemoryUtilization',
        namespace: 'AWS/ECS',
        dimensions: [
          { Name: 'ClusterName', Value: ecsProdCluster },
          { Name: 'ServiceName', Value: ecsProdService },
        ],
      },
      {
        label: 'ECS CPU Utilization (Beta)',
        metric: 'CPUUtilization',
        namespace: 'AWS/ECS',
        dimensions: [
          { Name: 'ClusterName', Value: ecsBetaCluster },
          { Name: 'ServiceName', Value: ecsBetaService },
        ],
      },
      {
        label: 'ALB 5XX (Prod Target Group)',
        metric: 'HTTPCode_Target_5XX_Count',
        namespace: 'AWS/ApplicationELB',
        dimensions: [{ Name: 'TargetGroup', Value: prodTargetGroup }],
      },
      {
        label: 'ALB 5XX (Beta Target Group)',
        metric: 'HTTPCode_Target_5XX_Count',
        namespace: 'AWS/ApplicationELB',
        dimensions: [{ Name: 'TargetGroup', Value: betaTargetGroup }],
      },
      {
        label: 'ALB Target Response Time (Prod)',
        metric: 'TargetResponseTime',
        namespace: 'AWS/ApplicationELB',
        dimensions: [{ Name: 'TargetGroup', Value: prodTargetGroup }],
      },
    ],
  });
});

// ─────────────────────────────────────────────
// POST /api/alarms/presets
// Creates the standard set of alarms for both clusters at once.
// Call this once during setup to provision all recommended alarms.
// ─────────────────────────────────────────────
router.post('/presets', async (req, res) => {
  const { snsTopicArn } = req.body;

  const presets = [
    // Production alarms
    {
      name: 'deploywatch-prod-cpu-high',
      metric: 'CPUUtilization',
      namespace: 'AWS/ECS',
      dimensions: [
        { Name: 'ClusterName', Value: process.env.ECS_CLUSTER_PROD },
        { Name: 'ServiceName', Value: process.env.ECS_SERVICE_PROD },
      ],
      threshold: 80,
      description: 'Prod CPU > 80% for 2 consecutive minutes',
    },
    {
      name: 'deploywatch-prod-memory-high',
      metric: 'MemoryUtilization',
      namespace: 'AWS/ECS',
      dimensions: [
        { Name: 'ClusterName', Value: process.env.ECS_CLUSTER_PROD },
        { Name: 'ServiceName', Value: process.env.ECS_SERVICE_PROD },
      ],
      threshold: 85,
      description: 'Prod Memory > 85%',
    },
    {
      name: 'deploywatch-prod-5xx-rate',
      metric: 'HTTPCode_Target_5XX_Count',
      namespace: 'AWS/ApplicationELB',
      dimensions: [
        { Name: 'TargetGroup', Value: process.env.TARGET_GROUP_PROD_ARN?.split(':').pop() || '' },
      ],
      threshold: 10,
      description: 'Prod ALB 5xx errors > 10 per minute',
    },
    {
      name: 'deploywatch-prod-p99-latency',
      metric: 'TargetResponseTime',
      namespace: 'AWS/ApplicationELB',
      dimensions: [
        { Name: 'TargetGroup', Value: process.env.TARGET_GROUP_PROD_ARN?.split(':').pop() || '' },
      ],
      threshold: 2,
      statistic: 'p99',
      description: 'Prod P99 response time > 2s',
    },
    // Beta cluster alarms
    {
      name: 'deploywatch-beta-cpu-high',
      metric: 'CPUUtilization',
      namespace: 'AWS/ECS',
      dimensions: [
        { Name: 'ClusterName', Value: process.env.ECS_CLUSTER_BETA },
        { Name: 'ServiceName', Value: process.env.ECS_SERVICE_BETA },
      ],
      threshold: 80,
      description: 'Beta CPU > 80%',
    },
    {
      name: 'deploywatch-beta-5xx-rate',
      metric: 'HTTPCode_Target_5XX_Count',
      namespace: 'AWS/ApplicationELB',
      dimensions: [
        { Name: 'TargetGroup', Value: process.env.TARGET_GROUP_BETA_ARN?.split(':').pop() || '' },
      ],
      threshold: 10,
      description: 'Beta ALB 5xx errors > 10 per minute',
    },
  ];

  const results = [];
  for (const preset of presets) {
    try {
      await cw.send(
        new PutMetricAlarmCommand({
          AlarmName: preset.name,
          AlarmDescription: preset.description,
          MetricName: preset.metric,
          Namespace: preset.namespace,
          Dimensions: preset.dimensions,
          Threshold: preset.threshold,
          ComparisonOperator: 'GreaterThanThreshold',
          EvaluationPeriods: 2,
          Period: 60,
          Statistic: preset.statistic || 'Average',
          ActionsEnabled: true,
          AlarmActions: snsTopicArn ? [snsTopicArn] : [],
          OKActions: snsTopicArn ? [snsTopicArn] : [],
          TreatMissingData: 'notBreaching',
        })
      );
      results.push({ name: preset.name, status: 'created' });
    } catch (err) {
      results.push({ name: preset.name, status: 'error', error: err.message });
    }
  }

  res.json({ results });
});

module.exports = router;