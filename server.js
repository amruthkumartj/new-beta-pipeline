require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const clustersRouter = require('./routes/clusters');
const metricsRouter = require('./routes/metrics');
const logsRouter = require('./routes/logs');
const alarmsRouter = require('./routes/alarms');
const githubRouter = require('./routes/github');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// Serve dashboard for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DeployWatch running on http://localhost:${PORT}`);
});