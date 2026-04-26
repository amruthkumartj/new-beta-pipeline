require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const clustersRouter = require('./routes/cluster');
const metricsRouter = require('./routes/metrics');
const logsRouter = require('./routes/logs');
const alarmsRouter = require('./routes/alarms');
const githubRouter = require('./routes/github');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function summarizeEnv() {
  const required = [
    'AWS_REGION',
    'ECS_CLUSTER_PROD',
    'ECS_CLUSTER_BETA',
    'ECS_SERVICE_PROD',
    'ECS_SERVICE_BETA',
    'TARGET_GROUP_PROD_ARN',
    'TARGET_GROUP_BETA_ARN',
  ];

  const present = required.filter((k) => !!process.env[k]);
  const missing = required.filter((k) => !process.env[k]);

  const albRule = process.env.ALB_BETA_RULE_ARN || '';
  const albRuleLooksValid = albRule.includes(':listener-rule/');

  return {
    region: process.env.AWS_REGION || null,
    port: process.env.PORT || '80 (default)',
    presentCount: present.length,
    missing,
    albBetaRuleArnConfigured: Boolean(albRule),
    albBetaRuleArnLooksValid: albRuleLooksValid,
    albBetaListenerArnConfigured: Boolean(process.env.ALB_BETA_LISTENER_ARN),
  };
}

// API Routes
app.use('/api/clusters', clustersRouter);
app.use('/api/metrics', metricsRouter);
app.use('/api/logs', logsRouter);
app.use('/api/alarms', alarmsRouter);
app.use('/webhook', githubRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString(), route: '/health' });
});

app.get('/', (req, res, next) => {
  if (req.accepts('html')) {
    return next();
  }
  return res.json({ status: 'ok', ts: new Date().toISOString(), route: '/' });
});

app.get('/api/runtime', (req, res) => {
  res.json({
    status: 'ok',
    ts: new Date().toISOString(),
    env: summarizeEnv(),
    pid: process.pid,
    node: process.version,
  });
});

// Serve dashboard for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = Number(process.env.PORT || 80);
app.listen(PORT, () => {
  const envSummary = summarizeEnv();
  console.log(`[Startup] DeployWatch listening on port ${PORT}`);
  console.log(
    `[Startup] AWS region=${envSummary.region || 'unset'} requiredEnv=${envSummary.presentCount}/${envSummary.presentCount + envSummary.missing.length}`
  );
  if (envSummary.missing.length > 0) {
    console.warn(`[Startup] Missing env keys: ${envSummary.missing.join(', ')}`);
  }
  if (envSummary.albBetaRuleArnConfigured && !envSummary.albBetaRuleArnLooksValid) {
    console.warn(
      '[Startup] ALB_BETA_RULE_ARN is set but is not a listener-rule ARN. Set ALB_BETA_RULE_ARN to an ARN containing ":listener-rule/" or set ALB_BETA_LISTENER_ARN.'
    );
  }
});

//new changes as per 26-04-2026