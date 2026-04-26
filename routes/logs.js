const express = require('express');
const router = express.Router();
const {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  DescribeLogGroupsCommand,
  StartQueryCommand,
  GetQueryResultsCommand,
} = require('@aws-sdk/client-cloudwatch-logs');

const cwl = new CloudWatchLogsClient({ region: process.env.AWS_REGION });

// ─────────────────────────────────────────────
// GET /api/logs/search
// Searches CloudWatch Logs with filters
//
// Query params:
//   timeframe  = "1h" | "6h" | "24h" | "7d"
//   org        = org ID string (optional)
//   user       = user ID string (optional)
//   session    = session ID string (optional)
//   text       = free text search (optional)
//   cluster    = "prod" | "beta" | "all" (default: all)
//   limit      = number of events (default: 100)
//
// WHERE YOUR LOG GROUPS ARE IN AWS CONSOLE:
//   CloudWatch → Log groups → /ecs/your-service-name
//   Get exact name from: ECS Console → Task Definition → Log Configuration
// ─────────────────────────────────────────────
router.get('/search', async (req, res) => {
  const {
    timeframe = '1h',
    org,
    user,
    session,
    text,
    level,
    streamPrefix,
    logGroup,
    start,
    end,
    sort = 'desc',
    cluster = 'all',
    limit = 100,
  } = req.query;

  const logGroups = [];
  if (logGroup) {
    String(logGroup)
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean)
      .forEach((g) => logGroups.push(g));
  } else {
    if (cluster === 'all' || cluster === 'prod') {
      logGroups.push(process.env.LOG_GROUP_PROD || `/ecs/${process.env.ECS_SERVICE_PROD}`);
    }
    if (cluster === 'all' || cluster === 'beta') {
      logGroups.push(process.env.LOG_GROUP_BETA || `/ecs/${process.env.ECS_SERVICE_BETA}`);
    }
  }

  const now = Date.now();
  const timeframeMs = {
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
  };
  const customStart = start ? Number(new Date(String(start)).getTime()) : null;
  const customEnd = end ? Number(new Date(String(end)).getTime()) : null;
  const endTime = Number.isFinite(customEnd) ? customEnd : now;
  const startTime = Number.isFinite(customStart)
    ? customStart
    : now - (timeframeMs[timeframe] || timeframeMs['1h']);
  const safeLimit = Math.max(1, Math.min(Number(limit || 100), 500));

  // Build CloudWatch filter pattern from search fields
  // CloudWatch filter syntax: { $.field = "value" } for JSON logs
  // or plain text patterns like [org, user, session]
  const patterns = [];
  if (org) patterns.push(`"org=${org}"`);
  if (user) patterns.push(`"user=${user}"`);
  if (session) patterns.push(`"session=${session}"`);
  if (text) patterns.push(`"${text}"`);
  if (level) patterns.push(`"${String(level).toLowerCase()}"`);

  // If your logs are JSON, use: { ($.org = "acme") && ($.level = "error") }
  // If plain text, join patterns with space (implicit AND in CW)
  const filterPattern = patterns.join(' ');

  try {
    const results = [];

    for (const logGroup of logGroups) {
      let nextToken;
      let fetched = 0;
      const groupLimit = Math.ceil(safeLimit / Math.max(logGroups.length, 1));

      do {
        const cmd = new FilterLogEventsCommand({
          logGroupName: logGroup,
          startTime,
          endTime,
          filterPattern: filterPattern || undefined,
          logStreamNamePrefix: streamPrefix || undefined,
          limit: Math.min(groupLimit - fetched, 50),
          nextToken,
        });

        const resp = await cwl.send(cmd);

        (resp.events || []).forEach((e) => {
          results.push({
            timestamp: e.timestamp,
            time: new Date(e.timestamp).toISOString(),
            message: e.message,
            logGroup,
            logStream: e.logStreamName,
            cluster: logGroup.includes(process.env.ECS_SERVICE_BETA) ? 'beta' : 'prod',
          });
        });

        nextToken = resp.nextToken;
        fetched += (resp.events || []).length;
      } while (nextToken && fetched < groupLimit);
    }

    if (String(sort).toLowerCase() === 'asc') {
      results.sort((a, b) => a.timestamp - b.timestamp);
    } else {
      results.sort((a, b) => b.timestamp - a.timestamp);
    }

    res.json({
      events: results.slice(0, safeLimit),
      count: results.length,
      filters: {
        timeframe,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        cluster,
        logGroups,
        sort,
      },
    });
  } catch (err) {
    console.error('GET /api/logs/search error:', err);
    res.status(isAccessDenied(err) ? 403 : 500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/logs/stream  (Server-Sent Events)
// Streams new log lines every N seconds to the dashboard.
// The dashboard toggles this with the "Auto-fetch" switch.
//
// Usage: const es = new EventSource('/api/logs/stream?cluster=all')
// ─────────────────────────────────────────────
router.get('/stream', (req, res) => {
  const { cluster = 'all', intervalSec = 5 } = req.query;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const logGroups = [];
  if (cluster === 'all' || cluster === 'prod') {
    logGroups.push(process.env.LOG_GROUP_PROD || `/ecs/${process.env.ECS_SERVICE_PROD}`);
  }
  if (cluster === 'all' || cluster === 'beta') {
    logGroups.push(process.env.LOG_GROUP_BETA || `/ecs/${process.env.ECS_SERVICE_BETA}`);
  }

  let lastTimestamp = Date.now() - 10000; // start 10s in the past

  const fetchAndSend = async () => {
    for (const logGroup of logGroups) {
      try {
        const cmd = new FilterLogEventsCommand({
          logGroupName: logGroup,
          startTime: lastTimestamp + 1,
          endTime: Date.now(),
          limit: 20,
        });
        const resp = await cwl.send(cmd);
        const events = resp.events || [];

        if (events.length > 0) {
          lastTimestamp = events[events.length - 1].timestamp;
          events.forEach((e) => {
            const payload = JSON.stringify({
              time: new Date(e.timestamp).toISOString(),
              message: e.message,
              cluster: logGroup.includes(process.env.ECS_SERVICE_BETA) ? 'beta' : 'prod',
            });
            res.write(`data: ${payload}\n\n`);
          });
        }
      } catch (err) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        if (isAccessDenied(err)) {
          clearInterval(interval);
          res.end();
          return;
        }
      }
    }
  };

  fetchAndSend();
  const interval = setInterval(fetchAndSend, parseInt(intervalSec) * 1000);

  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

// ─────────────────────────────────────────────
// GET /api/logs/groups
// Lists available CloudWatch log groups (for dropdown population)
// ─────────────────────────────────────────────
router.get('/groups', async (req, res) => {
  try {
    const resp = await cwl.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: '/ecs/' })
    );
    res.json({
      groups: (resp.logGroups || []).map((g) => ({
        name: g.logGroupName,
        retentionDays: g.retentionInDays,
        storedBytes: g.storedBytes,
      })),
    });
  } catch (err) {
    console.error('GET /api/logs/groups error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/logs/insights
// Runs a CloudWatch Logs Insights query (more powerful, async)
// Body: { query, logGroups[], startTime, endTime }
//
// Example query: "fields @timestamp, @message | filter org='acme' | sort @timestamp desc | limit 50"
// ─────────────────────────────────────────────
router.post('/insights', async (req, res) => {
  const { query, logGroups, startTime, endTime } = req.body;

  try {
    const startResp = await cwl.send(
      new StartQueryCommand({
        logGroupNames: logGroups,
        queryString: query,
        startTime: Math.floor(new Date(startTime).getTime() / 1000),
        endTime: Math.floor(new Date(endTime || new Date()).getTime() / 1000),
      })
    );

    const queryId = startResp.queryId;

    // Poll until complete (max 30s)
    let results;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const pollResp = await cwl.send(new GetQueryResultsCommand({ queryId }));
      if (pollResp.status === 'Complete') {
        results = pollResp.results;
        break;
      }
    }

    res.json({ queryId, results: results || [] });
  } catch (err) {
    console.error('POST /api/logs/insights error:', err);
    res.status(500).json({ error: err.message });
  }
});

function isAccessDenied(err) {
  const message = `${err?.name || ''} ${err?.message || ''}`.toLowerCase();
  return message.includes('accessdenied') || message.includes('not authorized');
}

module.exports = router;