/**
 * Redis client and cache helpers. When REDIS_URL is not set, all operations no-op or use fallback.
 * Used for: rate limiting store, login attempts, AI usage counters, IP block list, response cache.
 */

const Redis = require("ioredis");
const { RedisStore } = require("rate-limit-redis");

const REDIS_URL = process.env.REDIS_URL && String(process.env.REDIS_URL).trim();
let client = null;
let storePrefix = "saas:";

function getClient() {
  if (!REDIS_URL) return null;
  if (client) return client;
  try {
    client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });
    client.on("error", (err) => {
      console.error("REDIS_ERROR:", err.message);
    });
    return client;
  } catch (err) {
    console.error("REDIS_INIT_ERROR:", err.message);
    return null;
  }
}

async function connect() {
  const c = getClient();
  if (!c) return false;
  try {
    await c.connect?.();
    return true;
  } catch (err) {
    console.error("REDIS_CONNECT_ERROR:", err.message);
    return false;
  }
}

function isAvailable() {
  return !!REDIS_URL && !!getClient();
}

async function ping() {
  const c = getClient();
  if (!c) return false;
  try {
    const p = await c.ping();
    return p === "PONG";
  } catch (_) {
    return false;
  }
}

function close() {
  if (client) {
    try {
      client.disconnect();
    } catch (_) {}
    client = null;
  }
}

/**
 * Create a RedisStore for express-rate-limit. Returns undefined if Redis unavailable (use default in-memory).
 */
function createRateLimitStore(options = {}) {
  const c = getClient();
  if (!c) return undefined;
  return new RedisStore({
    prefix: options.prefix || storePrefix + "rl:",
    sendCommand: (command, ...args) => c.call(command, ...args),
    ...options,
  });
}

/**
 * Login attempts: key login:{ip}, value count, TTL 10 min. Returns new count.
 */
async function incrementLoginAttempts(ip) {
  const c = getClient();
  if (!c) return 0;
  const key = `${storePrefix}login:${ip}`;
  try {
    const count = await c.incr(key);
    if (count === 1) await c.pexpire(key, 10 * 60 * 1000);
    return count;
  } catch (_) {
    return 0;
  }
}

async function getLoginAttempts(ip) {
  const c = getClient();
  if (!c) return 0;
  try {
    const n = await c.get(`${storePrefix}login:${ip}`);
    return n ? parseInt(n, 10) : 0;
  } catch (_) {
    return 0;
  }
}

async function resetLoginAttemptsRedis(ip) {
  const c = getClient();
  if (!c) return;
  try {
    await c.del(`${storePrefix}login:${ip}`);
  } catch (_) {}
}

/** Block abusive IP for durationMs. Key block_ip:{ip}. */
async function blockIp(ip, durationMs = 15 * 60 * 1000) {
  const c = getClient();
  if (!c) return;
  try {
    await c.setex(`${storePrefix}block_ip:${ip}`, Math.ceil(durationMs / 1000), "1");
  } catch (_) {}
}

async function isIpBlocked(ip) {
  const c = getClient();
  if (!c) return false;
  try {
    const v = await c.get(`${storePrefix}block_ip:${ip}`);
    return v === "1";
  } catch (_) {
    return false;
  }
}

/** Burst detection: increment request count for IP in 5s window; returns current count. */
async function incrementBurst(ip) {
  const c = getClient();
  if (!c) return 0;
  const key = `${storePrefix}burst:${ip}`;
  try {
    const count = await c.incr(key);
    if (count === 1) await c.pexpire(key, 5000);
    return count;
  } catch (_) {
    return 0;
  }
}

/** AI usage: key ai_user:{userId} or ai_biz:{businessId}, window 1 hour. Returns current count after increment. */
async function incrementAiUsageUser(userId) {
  const c = getClient();
  if (!c) return 0;
  const key = `${storePrefix}ai_user:${userId}`;
  try {
    const count = await c.incr(key);
    if (count === 1) await c.pexpire(key, 60 * 60 * 1000);
    return count;
  } catch (_) {
    return 0;
  }
}

async function incrementAiUsageBusiness(businessId) {
  const c = getClient();
  if (!c) return 0;
  const key = `${storePrefix}ai_biz:${businessId}`;
  try {
    const count = await c.incr(key);
    if (count === 1) await c.pexpire(key, 60 * 60 * 1000);
    return count;
  } catch (_) {
    return 0;
  }
}

async function getAiUsageUser(userId) {
  const c = getClient();
  if (!c) return 0;
  try {
    const n = await c.get(`${storePrefix}ai_user:${userId}`);
    return n ? parseInt(n, 10) : 0;
  } catch (_) {
    return 0;
  }
}

async function getAiUsageBusiness(businessId) {
  const c = getClient();
  if (!c) return 0;
  try {
    const n = await c.get(`${storePrefix}ai_biz:${businessId}`);
    return n ? parseInt(n, 10) : 0;
  } catch (_) {
    return 0;
  }
}

/** Cache: get/set with TTL (seconds). */
async function cacheGet(key) {
  const c = getClient();
  if (!c) return null;
  try {
    const raw = await c.get(`${storePrefix}cache:${key}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function cacheSet(key, value, ttlSeconds = 45) {
  const c = getClient();
  if (!c) return;
  try {
    const s = JSON.stringify(value);
    await c.setex(`${storePrefix}cache:${key}`, ttlSeconds, s);
  } catch (_) {}
}

/** Replay buckets in Redis (optional): key replay:{visitorKey}, store last N message hashes with TTL. */
async function replayCheckRedis(visitorKey, messageNorm, windowMs, maxSame) {
  const c = getClient();
  if (!c) return false;
  const key = `${storePrefix}replay:${visitorKey}`;
  try {
    const raw = await c.get(key);
    const list = raw ? JSON.parse(raw) : [];
    const now = Date.now();
    const since = now - windowMs;
    const recent = list.filter((e) => e.ts > since);
    const sameCount = recent.filter((e) => e.msg === messageNorm).length;
    recent.push({ msg: messageNorm, ts: now });
    const toKeep = recent.slice(-20);
    await c.setex(key, Math.ceil(windowMs / 1000) + 60, JSON.stringify(toKeep));
    return sameCount > maxSame;
  } catch (_) {
    return false;
  }
}

module.exports = {
  getClient,
  connect,
  isAvailable,
  ping,
  close,
  createRateLimitStore,
  incrementLoginAttempts,
  getLoginAttempts,
  resetLoginAttemptsRedis,
  blockIp,
  isIpBlocked,
  incrementBurst,
  incrementAiUsageUser,
  incrementAiUsageBusiness,
  getAiUsageUser,
  getAiUsageBusiness,
  cacheGet,
  cacheSet,
  replayCheckRedis,
  REDIS_URL: !!REDIS_URL,
};
