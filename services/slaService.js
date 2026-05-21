const { getRuntimeMetrics } = require("./runtimeMetricsService");
const { getTrainingQueueStats } = require("./trainingQueueService");

function pct(numerator, denominator) {
  if (!denominator) return 0;
  return (Number(numerator || 0) / Number(denominator || 0)) * 100;
}

function evaluateHealth() {
  const runtime = getRuntimeMetrics();
  const queue = getTrainingQueueStats();

  const fallbackRate = pct(runtime.agent.fallback, runtime.agent.total);
  const errorRate = pct(runtime.agent.errors, runtime.agent.total);
  const p95Latency = Number(runtime.agent.latency.p95 || 0);
  const queueBacklog = Number(queue.queued || 0) + Number(queue.running || 0);

  const maxFallbackWarn = Number(process.env.SLA_FALLBACK_WARN_PCT || 45);
  const maxErrorWarn = Number(process.env.SLA_ERROR_WARN_PCT || 8);
  const maxP95Warn = Number(process.env.SLA_P95_WARN_MS || 8000);
  const maxQueueWarn = Number(process.env.SLA_QUEUE_WARN || 25);

  const alerts = [];
  if (fallbackRate > maxFallbackWarn) {
    alerts.push({
      severity: "warning",
      code: "fallback_rate_high",
      message: `Fallback rate ${fallbackRate.toFixed(1)}% is above ${maxFallbackWarn}%`,
    });
  }
  if (errorRate > maxErrorWarn) {
    alerts.push({
      severity: "warning",
      code: "error_rate_high",
      message: `Error rate ${errorRate.toFixed(1)}% is above ${maxErrorWarn}%`,
    });
  }
  if (p95Latency > maxP95Warn) {
    alerts.push({
      severity: "warning",
      code: "latency_high",
      message: `P95 latency ${p95Latency}ms is above ${maxP95Warn}ms`,
    });
  }
  if (queueBacklog > maxQueueWarn) {
    alerts.push({
      severity: "warning",
      code: "training_queue_backlog",
      message: `Training queue backlog ${queueBacklog} is above ${maxQueueWarn}`,
    });
  }

  const status = alerts.length ? "degraded" : "healthy";
  return {
    status,
    alerts,
    signals: {
      fallbackRatePct: Number(fallbackRate.toFixed(2)),
      errorRatePct: Number(errorRate.toFixed(2)),
      p95LatencyMs: p95Latency,
      queueBacklog,
    },
    thresholds: {
      maxFallbackWarn,
      maxErrorWarn,
      maxP95Warn,
      maxQueueWarn,
    },
    runtime,
    queue,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  evaluateHealth,
};
