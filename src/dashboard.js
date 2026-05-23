'use strict';

const http = require('http');

function startDashboard(config, sessionManager) {
  if (!config.dashboardPort) {
    return null;
  }
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      sendJson(res, { ok: true });
      return;
    }
    if (req.url === '/sessions') {
      sendJson(res, sessionManager.snapshot());
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  server.listen(config.dashboardPort, config.dashboardHost || '127.0.0.1');
  return server;
}

function sendJson(res, value) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value, null, 2));
}

module.exports = { startDashboard };
