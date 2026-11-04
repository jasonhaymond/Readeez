// metrics.js
// Simple request counters since the server started, shown in the admin Server panel. No
// monitoring system consumes them yet; they're there so one could be attached later.

const startedAt = Date.now();
const counts = { requests: 0, clientErrors: 0, serverErrors: 0, totalMs: 0 };

/**
 * Records one finished request. In: its HTTP status and how long it took, in milliseconds.
 */
function recordRequest(status, ms) {
  counts.requests += 1;
  counts.totalMs += ms;
  if (status >= 500) counts.serverErrors += 1;
  else if (status >= 400) counts.clientErrors += 1;
}

/**
 * Reads the counters. Out: uptime in seconds, the counts, and the average response time.
 */
function snapshot() {
  return {
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    requests: counts.requests,
    clientErrors: counts.clientErrors,
    serverErrors: counts.serverErrors,
    averageMs: counts.requests ? Math.round(counts.totalMs / counts.requests) : 0,
  };
}

module.exports = { recordRequest, snapshot };
