const express = require('express');
const router = express.Router();
const {
  CloudWatchClient,
  GetMetricDataCommand,
  ListMetricsCommand,
} = require('@aws-sdk/client-cloudwatch');
const {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
} = require('@aws-sdk/client-ecs');

const cw = new CloudWatchClient({ region: process.env.AWS_REGION });
const ecs = new ECSClient({ region: process.env.AWS_REGION });

// ─────────────────────────────────────────────
// GET /api/metrics/nodes?cluster=prod|beta
// Returns per-task CPU utilization (shown as node circles in the dashboard)
//
// WHERE TO FIND THESE METRICS IN AWS CONSOLE:
//   CloudWatch → Metrics → ECS → ClusterName, ServiceName → CPUUtilization
//   Namespace: AWS/ECS
//   Dimension: ClusterName + ServiceName
// ─────────────────────────────────────────────
router.get('/nodes', async (req, res) => {
  const clusterKey = req.query.cluster === 'beta' ? 'BETA' : 'PROD';
  const clusterName = process.env[`ECS_CLUSTER_${clusterKey}`];
  const serviceName = process.env[`ECS_SERVICE_${clusterKey}`];

  try {
    const listResp = await ecs.send(
      new ListTasksCommand({ cluster: clusterName, serviceName, desiredStatus: 'RUNNING' })
    );

    const taskArns = listResp.taskArns || [];
    if (taskArns.length === 0) {
      return res.json({
        nodes: [],
        clusterName,
        serviceName,
        warning: 'No RUNNING tasks found for this service.',
      });
    }

    const descResp = await ecs.send(
      new DescribeTasksCommand({ cluster: clusterName, tasks: taskArns.slice(0, 50) })
    );

    const tasks = (descResp.tasks || []).slice(0, 20);
    const nodes = tasks.map((task, i) => {
      const taskId = task.taskArn.split('/').pop();
      return {
        id: i + 1,
        label: taskId?.slice(-8) || `task-${i + 1}`,
        taskId,
        taskArn: task.taskArn,
        lastStatus: task.lastStatus,
        cpu: null,
      };
    });

    let metricWarning = null;
    if (tasks.length > 0) {
      try {
        const now = new Date();
        const startTime = new Date(now.getTime() - 5 * 60 * 1000);

        const queries = tasks.map((task, i) => {
          const taskId = task.taskArn.split('/').pop();
          return {
            Id: `cpu${i}`,
            Label: taskId.slice(-8),
            MetricStat: {
              Metric: {
                Namespace: 'ECS/ContainerInsights',
                MetricName: 'CpuUtilized',
                Dimensions: [
                  { Name: 'ClusterName', Value: clusterName },
                  { Name: 'ServiceName', Value: serviceName },
                  { Name: 'TaskId', Value: taskId },
                ],
              },
              Period: 60,
              Stat: 'Average',
            },
          };
        });

        const cwResp = await cw.send(
          new GetMetricDataCommand({
            MetricDataQueries: queries,
            StartTime: startTime,
            EndTime: now,
          })
        );

        (cwResp.MetricDataResults || []).forEach((r, i) => {
          if (nodes[i]) {
            nodes[i].cpu = r.Values.length > 0 ? Math.round(r.Values[0]) : null;
          }
        });
      } catch (metricErr) {
        metricWarning = `Unable to read ECS/ContainerInsights CpuUtilized: ${metricErr.message}`;
      }
    }

    res.json({
      nodes,
      clusterName,
      serviceName,
      taskCount: taskArns.length,
      warning: metricWarning,
    });
  } catch (err) {
    console.error('GET /api/metrics/nodes error:', err);
    res.status(500).json({ error: err.message, clusterName, serviceName });
  }
});

// ─────────────────────────────────────────────
// GET /api/metrics/db-acls
// Returns Aurora Serverless / RDS connection counts per ACL group
//
// WHERE TO FIND IN AWS CONSOLE:
//   CloudWatch → Metrics → RDS → DatabaseConnections
//   Or custom metrics your app emits via PutMetricData
//   Namespace: AWS/RDS  (or your custom namespace e.g. "App/ACLs")
// ─────────────────────────────────────────────
router.get('/db-acls', async (req, res) => {
  try {
    const now = new Date();
    const startTime = new Date(now.getTime() - 10 * 60 * 1000);

    const aclNames = ['acl-prod', 'acl-beta', 'acl-read', 'acl-write', 'acl-admin'];

    // If you emit custom ACL metrics, replace namespace/metricName below
    const queries = aclNames.map((acl, i) => ({
      Id: `acl${i}`,
      Label: acl,
      MetricStat: {
        Metric: {
          Namespace: process.env.CUSTOM_METRICS_NAMESPACE || 'App/Database',
          MetricName: 'ACLConnectionCount',
          Dimensions: [{ Name: 'ACLGroup', Value: acl }],
        },
        Period: 60,
        Stat: 'Average',
      },
    }));

    const cwResp = await cw.send(
      new GetMetricDataCommand({ MetricDataQueries: queries, StartTime: startTime, EndTime: now })
    );

    const acls = cwResp.MetricDataResults.map((r) => ({
      name: r.Label,
      value: r.Values.length > 0 ? Math.round(r.Values[0]) : null,
    }));

    res.json({ acls });
  } catch (err) {
    console.error('GET /api/metrics/db-acls error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/metrics/valkeys
// Returns active key counts per Valkey (ElastiCache / Redis-compatible) shard
//
// WHERE TO FIND IN AWS CONSOLE:
//   CloudWatch → Metrics → ElastiCache → CurrItems (current key count)
//   Namespace: AWS/ElastiCache
//   Dimension: CacheClusterId
// ─────────────────────────────────────────────
router.get('/valkeys', async (req, res) => {
  try {
    const now = new Date();
    const startTime = new Date(now.getTime() - 10 * 60 * 1000);

    const shards = (process.env.VALKEY_SHARD_IDS || 'shard-0,shard-1,shard-2,shard-3').split(',');

    const queries = shards.map((shardId, i) => ({
      Id: `shard${i}`,
      Label: shardId.trim(),
      MetricStat: {
        Metric: {
          Namespace: 'AWS/ElastiCache',
          MetricName: 'CurrItems',
          Dimensions: [{ Name: 'CacheClusterId', Value: shardId.trim() }],
        },
        Period: 60,
        Stat: 'Average',
      },
    }));

    const cwResp = await cw.send(
      new GetMetricDataCommand({ MetricDataQueries: queries, StartTime: startTime, EndTime: now })
    );

    const valkeys = cwResp.MetricDataResults.map((r) => ({
      shard: r.Label,
      keys: r.Values.length > 0 ? Math.round(r.Values[0]) : null,
    }));

    res.json({ valkeys });
  } catch (err) {
    console.error('GET /api/metrics/valkeys error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/metrics/overview
// Single call returning all metrics for the dashboard top row
// ─────────────────────────────────────────────
router.get('/overview', async (req, res) => {
  try {
    const now = new Date();
    const startTime = new Date(now.getTime() - 5 * 60 * 1000);

    const queries = [
      {
        Id: 'cpu_prod',
        Label: 'CPU Prod',
        MetricStat: {
          Metric: {
            Namespace: 'AWS/ECS',
            MetricName: 'CPUUtilization',
            Dimensions: [
              { Name: 'ClusterName', Value: process.env.ECS_CLUSTER_PROD },
              { Name: 'ServiceName', Value: process.env.ECS_SERVICE_PROD },
            ],
          },
          Period: 60,
          Stat: 'Average',
        },
      },
      {
        Id: 'cpu_beta',
        Label: 'CPU Beta',
        MetricStat: {
          Metric: {
            Namespace: 'AWS/ECS',
            MetricName: 'CPUUtilization',
            Dimensions: [
              { Name: 'ClusterName', Value: process.env.ECS_CLUSTER_BETA },
              { Name: 'ServiceName', Value: process.env.ECS_SERVICE_BETA },
            ],
          },
          Period: 60,
          Stat: 'Average',
        },
      },
      {
        Id: 'mem_prod',
        Label: 'Memory Prod',
        MetricStat: {
          Metric: {
            Namespace: 'AWS/ECS',
            MetricName: 'MemoryUtilization',
            Dimensions: [
              { Name: 'ClusterName', Value: process.env.ECS_CLUSTER_PROD },
              { Name: 'ServiceName', Value: process.env.ECS_SERVICE_PROD },
            ],
          },
          Period: 60,
          Stat: 'Average',
        },
      },
    ];

    const cwResp = await cw.send(
      new GetMetricDataCommand({ MetricDataQueries: queries, StartTime: startTime, EndTime: now })
    );

    const result = {};
    cwResp.MetricDataResults.forEach((r) => {
      result[r.Id] = r.Values[0] != null ? Math.round(r.Values[0]) : null;
    });

    res.json(result);
  } catch (err) {
    console.error('GET /api/metrics/overview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/metrics/cluster-series
// Returns CPU and Memory timeseries for prod and beta clusters.
// Query:
//   minutes = lookback window (default 60, max 720)
//   period  = datapoint period in seconds (default 60)
// ─────────────────────────────────────────────
router.get('/cluster-series', async (req, res) => {
  try {
    const minutes = Math.max(5, Math.min(Number(req.query.minutes || 60), 720));
    const period = Math.max(60, Math.min(Number(req.query.period || 60), 3600));

    const now = new Date();
    const startTime = new Date(now.getTime() - minutes * 60 * 1000);

    const clusters = [
      {
        key: 'prod',
        cluster: process.env.ECS_CLUSTER_PROD,
        service: process.env.ECS_SERVICE_PROD,
      },
      {
        key: 'beta',
        cluster: process.env.ECS_CLUSTER_BETA,
        service: process.env.ECS_SERVICE_BETA,
      },
    ];

    const queries = [];
    clusters.forEach(({ key, cluster, service }) => {
      if (!cluster || !service) {
        return;
      }

      queries.push(
        {
          Id: `${key}_cpu`,
          Label: `${key.toUpperCase()} CPU`,
          MetricStat: {
            Metric: {
              Namespace: 'AWS/ECS',
              MetricName: 'CPUUtilization',
              Dimensions: [
                { Name: 'ClusterName', Value: cluster },
                { Name: 'ServiceName', Value: service },
              ],
            },
            Period: period,
            Stat: 'Average',
          },
        },
        {
          Id: `${key}_mem`,
          Label: `${key.toUpperCase()} Memory`,
          MetricStat: {
            Metric: {
              Namespace: 'AWS/ECS',
              MetricName: 'MemoryUtilization',
              Dimensions: [
                { Name: 'ClusterName', Value: cluster },
                { Name: 'ServiceName', Value: service },
              ],
            },
            Period: period,
            Stat: 'Average',
          },
        }
      );
    });

    const cwResp = await cw.send(
      new GetMetricDataCommand({
        MetricDataQueries: queries,
        StartTime: startTime,
        EndTime: now,
        ScanBy: 'TimestampAscending',
      })
    );

    const result = {
      meta: {
        minutes,
        period,
        startTime: startTime.toISOString(),
        endTime: now.toISOString(),
      },
      prod: { cpu: [], memory: [] },
      beta: { cpu: [], memory: [] },
    };

    (cwResp.MetricDataResults || []).forEach((metric) => {
      const points = (metric.Timestamps || []).map((ts, i) => ({
        time: new Date(ts).toISOString(),
        value: metric.Values?.[i] == null ? null : Number(metric.Values[i].toFixed(2)),
      }));

      if (metric.Id === 'prod_cpu') result.prod.cpu = points;
      if (metric.Id === 'prod_mem') result.prod.memory = points;
      if (metric.Id === 'beta_cpu') result.beta.cpu = points;
      if (metric.Id === 'beta_mem') result.beta.memory = points;
    });

    res.json(result);
  } catch (err) {
    console.error('GET /api/metrics/cluster-series error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;