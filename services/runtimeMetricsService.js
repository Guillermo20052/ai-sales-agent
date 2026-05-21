const redis = require("./redis");

const MAX_LATENCIES = 200;
const REDIS_KEY = "saas:metrics:snapshot";
const REDIS_TTL_SECONDS = 300;
const PERSIST_INTERVAL_MS = 60 * 1000;

const metrics = {
  agent: {
    total: 0,
    grounded: 0,
    fallback: 0,
    errors: 0,
    latenciesMs: [],
  },
  vision: {
    total: 0,
    grounded: 0,
    fallback: 0,
    errors: 0,
    latenciesMs: [],
  },
};

function pushLatency(bucket, ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return;
  bucket.latenciesMs.push(Math.round(n));
  if (bucket.latenciesMs.length > MAX_LATENCIES) {
    bucket.latenciesMs.splice(0, bucket.latenciesMs.length - MAX_LATENCIES);
  }
}

function recordAgentMetric(channel, data) {
  const bucket = metrics[channel] || metrics.agent;
  bucket.total += 1;
  if (data && data.outcome === "grounded") bucket.grounded += 1;
  if (data && data.outcome === "fallback") bucket.fallback += 1;
  if (data && data.error) bucket.errors += 1;
  if (data && data.latencyMs != null) pushLatency(bucket, data.latencyMs);
  if (data && Number.isFinite(Number(data.estimatedPromptChars))) {
    if (!bucket.promptChars) bucket.promptChars = [];
    bucket.promptChars.push(Math.round(Number(data.estimatedPromptChars)));
    if (bucket.promptChars.length > MAX_LATENCIES) {
      bucket.promptChars.splice(0, bucket.promptChars.length - MAX_LATENCIES);
    }
  }
  if (data && data.retrievalCacheHit != null) {
    bucket.retrievalCacheHits = (bucket.retrievalCacheHits || 0) + (data.retrievalCacheHit ? 1 : 0);
    bucket.retrievalCacheMisses = (bucket.retrievalCacheMisses || 0) + (data.retrievalCacheHit ? 0 : 1);
  }
}

function summarizeLatencies(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { p50: 0, p95: 0, max: 0, samples: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const max = sorted[sorted.length - 1] || 0;
  return { p50, p95, max, samples: sorted.length };
}

function getRuntimeMetrics() {
  return {
    agent: {
      total: metrics.agent.total,
      grounded: metrics.agent.grounded,
      fallback: metrics.agent.fallback,
      errors: metrics.agent.errors,
      latency: summarizeLatencies(metrics.agent.latenciesMs),
      promptChars: summarizeLatencies(metrics.agent.promptChars || []),
      retrievalCache: {
        hits: metrics.agent.retrievalCacheHits || 0,
        misses: metrics.agent.retrievalCacheMisses || 0,
      },
    },
    vision: {
      total: metrics.vision.total,
      grounded: metrics.vision.grounded,
      fallback: metrics.vision.fallback,
      errors: metrics.vision.errors,
      latency: summarizeLatencies(metrics.vision.latenciesMs),
      promptChars: summarizeLatencies(metrics.vision.promptChars || []),
      retrievalCache: {
        hits: metrics.vision.retrievalCacheHits || 0,
        misses: metrics.vision.retrievalCacheMisses || 0,
      },
    },
  };
}

function serializeMetrics() {
  return JSON.stringify({
    agent: {
      total: metrics.agent.total,
      grounded: metrics.agent.grounded,
      fallback: metrics.agent.fallback,
      errors: metrics.agent.errors,
      latenciesMs: metrics.agent.latenciesMs,
      promptChars: metrics.agent.promptChars || [],
      retrievalCacheHits: metrics.agent.retrievalCacheHits || 0,
      retrievalCacheMisses: metrics.agent.retrievalCacheMisses || 0,
    },
    vision: {
      total: metrics.vision.total,
      grounded: metrics.vision.grounded,
      fallback: metrics.vision.fallback,
      errors: metrics.vision.errors,
      latenciesMs: metrics.vision.latenciesMs,
      promptChars: metrics.vision.promptChars || [],
      retrievalCacheHits: metrics.vision.retrievalCacheHits || 0,
      retrievalCacheMisses: metrics.vision.retrievalCacheMisses || 0,
    },
  });
}

function restoreMetricsBucket(bucket, saved) {
  if (!saved) return;
  bucket.total = Number(saved.total) || 0;
  bucket.grounded = Number(saved.grounded) || 0;
  bucket.fallback = Number(saved.fallback) || 0;
  bucket.errors = Number(saved.errors) || 0;
  bucket.latenciesMs = Array.isArray(saved.latenciesMs) ? saved.latenciesMs.slice(-MAX_LATENCIES) : [];
  bucket.promptChars = Array.isArray(saved.promptChars) ? saved.promptChars.slice(-MAX_LATENCIES) : [];
  bucket.retrievalCacheHits = Number(saved.retrievalCacheHits) || 0;
  bucket.retrievalCacheMisses = Number(saved.retrievalCacheMisses) || 0;
}

async function persistToRedis() {
  try {
    const c = redis.getClient();
    if (!c) return;
    await c.setex(REDIS_KEY, REDIS_TTL_SECONDS, serializeMetrics());
  } catch (_) {}
}

async function loadFromRedis() {
  try {
    const c = redis.getClient();
    if (!c) return;
    const raw = await c.get(REDIS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    restoreMetricsBucket(metrics.agent, saved.agent);
    restoreMetricsBucket(metrics.vision, saved.vision);
  } catch (_) {}
}

loadFromRedis();
setInterval(persistToRedis, PERSIST_INTERVAL_MS);

module.exports = {
  recordAgentMetric,
  getRuntimeMetrics,
};
