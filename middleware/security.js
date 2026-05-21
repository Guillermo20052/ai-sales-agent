const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const redis = require("../services/redis");

// ── Sanitize details for logging (never log passwords, tokens, API keys) ─
const SENSITIVE_KEYS = /password|token|secret|apiKey|api_key|credential|session_id|authorization/i;
function sanitizeDetailsForLog(details) {
  if (!details || typeof details !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(details)) {
    if (SENSITIVE_KEYS.test(k)) continue;
    if (typeof v === "string" && v.length > 64 && /^[a-zA-Z0-9_-]+$/.test(v)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── Security event logger (structured format, sanitized) ───────────────────
function logSecurityEvent(eventType, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    event: eventType,
    ...sanitizeDetailsForLog(details),
  };
  console.log("SECURITY_EVENT:", JSON.stringify(entry));
}

const RATE_LIMIT_MESSAGE = "Too many requests";

// ── Redis-backed rate limit stores (when REDIS_URL set); else in-memory ─
const globalStore = redis.createRateLimitStore({ prefix: "saas:rl:global:" });
const authStore = redis.createRateLimitStore({ prefix: "saas:rl:auth:" });
const agentStore = redis.createRateLimitStore({ prefix: "saas:rl:agent:" });
const passwordStore = redis.createRateLimitStore({ prefix: "saas:rl:password:" });
const billingStore = redis.createRateLimitStore({ prefix: "saas:rl:billing:" });
const webhookStore = redis.createRateLimitStore({ prefix: "saas:rl:webhook:" });
const trainingStore = redis.createRateLimitStore({ prefix: "saas:rl:training:" });
const userStore = redis.createRateLimitStore({ prefix: "saas:rl:user:" });
const aiPerUserStore = redis.createRateLimitStore({ prefix: "saas:rl:aiuser:" });

// ── Global API rate limit: 100/min per IP ──────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  store: globalStore || undefined,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  skip: (req) => req.path === "/health",
  handler: (req, res) => {
    logSecurityEvent("rate_limit_violation", { ip: req.ip, endpoint: req.path, timestamp: new Date().toISOString(), windowMax: 100 });
    redis.blockIp(req.ip, 5 * 60 * 1000).catch(() => {});
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  },
});

// ── Strict auth route limiter: 5/min per IP ───────────────────────────
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  store: authStore || undefined,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  handler: (req, res) => {
    logSecurityEvent("rate_limit_violation", { ip: req.ip, endpoint: req.path, timestamp: new Date().toISOString(), windowMax: 5 });
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  },
});

// ── Strict AI / chat endpoint limiter: 10/min per IP (AI cost protection) ─
const agentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  store: agentStore || undefined,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  handler: (req, res) => {
    logSecurityEvent("rate_limit_violation", { ip: req.ip, endpoint: req.path, timestamp: new Date().toISOString(), windowMax: 10 });
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  },
});

// ── Password reset limiter: 5/min per IP ────────────────────────────────
const passwordLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  store: passwordStore || undefined,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  handler: (req, res) => {
    logSecurityEvent("rate_limit_violation", { ip: req.ip, endpoint: "/password", timestamp: new Date().toISOString(), windowMax: 5 });
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  },
});

// ── Billing (checkout/refund): 15/min per IP ─────────────────────────────
const billingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  store: billingStore || undefined,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  handler: (req, res) => {
    logSecurityEvent("rate_limit_violation", { ip: req.ip, endpoint: req.path, timestamp: new Date().toISOString(), windowMax: 15 });
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  },
});

// ── Stripe webhook: 200/min per IP (allow Stripe bursts) ─────────────────
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  store: webhookStore || undefined,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  handler: (req, res) => {
    logSecurityEvent("rate_limit_violation", { ip: req.ip, endpoint: "/webhook", timestamp: new Date().toISOString(), windowMax: 200 });
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  },
});

// ── Training / scrape: 10/min per IP ─────────────────────────────────────
const trainingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  store: trainingStore || undefined,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  handler: (req, res) => {
    logSecurityEvent("rate_limit_violation", { ip: req.ip, endpoint: req.path, timestamp: new Date().toISOString(), windowMax: 10 });
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  },
});

// ── Per-user limit: 200/min (authenticated only; skip when no session) ────
const perUserLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  store: userStore || undefined,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !req.session || !req.session.userId,
  keyGenerator: (req) => (req.session?.userId ? String(req.session.userId) : ipKeyGenerator(req.ip)),
  handler: (req, res) => {
    logSecurityEvent("rate_limit_violation", { ip: req.ip, userId: req.session?.userId, endpoint: req.path, windowMax: 200 });
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  },
});

// ── AI per-user limit: 10/min (for /chat and /agent when logged in) ──────
const aiPerUserLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  store: aiPerUserStore || undefined,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !req.session || !req.session.userId,
  keyGenerator: (req) => (req.session?.userId ? `ai:${req.session.userId}` : ipKeyGenerator(req.ip)),
  handler: (req, res) => {
    logSecurityEvent("rate_limit_violation", { ip: req.ip, userId: req.session?.userId, endpoint: req.path, windowMax: 10, type: "ai_per_user" });
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  },
});

// ── Login brute force tracker (Redis primary, in-memory fallback) ──────────
const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

function trackLoginFailureInMemory(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, firstAttempt: now };
  if (now - record.firstAttempt > LOGIN_WINDOW_MS) {
    record.count = 1;
    record.firstAttempt = now;
  } else {
    record.count += 1;
  }
  loginAttempts.set(ip, record);
  if (loginAttempts.size > 10000) {
    const oldest = loginAttempts.keys().next().value;
    loginAttempts.delete(oldest);
  }
}

async function trackLoginFailure(ip) {
  if (redis.REDIS_URL) {
    try {
      await redis.incrementLoginAttempts(ip);
      return;
    } catch (_) {}
  }
  trackLoginFailureInMemory(ip);
}

async function resetLoginAttempts(ip) {
  if (redis.REDIS_URL) {
    try {
      await redis.resetLoginAttemptsRedis(ip);
      return;
    } catch (_) {}
  }
  loginAttempts.delete(ip);
}

async function isLoginBlocked(ip) {
  if (redis.REDIS_URL) {
    try {
      const count = await redis.getLoginAttempts(ip);
      return count >= LOGIN_MAX_ATTEMPTS;
    } catch (_) {}
  }
  const record = loginAttempts.get(ip);
  if (!record) return false;
  if (Date.now() - record.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return record.count >= LOGIN_MAX_ATTEMPTS;
}

// ── Request timeout: 15s ───────────────────────────────────────────────
const REQUEST_TIMEOUT_MS = 15 * 1000;

function requestTimeoutMiddleware(timeoutMs = REQUEST_TIMEOUT_MS) {
  return (req, res, next) => {
    res.setTimeout(timeoutMs, () => {
      if (!res.headersSent) {
        logSecurityEvent("request_timeout", { ip: req.ip, path: req.path });
        res.status(503).json({ error: "Request timeout" });
      }
    });
    next();
  };
}

// ── IP block check (run early; blocks abusive IPs) ─────────────────────
const IP_BLOCK_DURATION_MS = 15 * 60 * 1000;
async function ipBlockMiddleware(req, res, next) {
  if (req.path === "/webhook" || req.path === "/health") return next();
  try {
    const blocked = await redis.isIpBlocked(req.ip);
    if (blocked) {
      logSecurityEvent("suspicious_ip_blocked", { ip: req.ip, path: req.path });
      return res.status(403).json({ error: "Forbidden" });
    }
  } catch (_) {}
  next();
}

// ── Bot detection: block empty UA, known scrapers, burst/scanning ─────────
const BOT_UA_PATTERNS = [
  /^curl\//i,
  /^wget\//i,
  /python-requests/i,
  /scrapy/i,
  /go-http-client/i,
  /^java\//i,
  /^php\//i,
  /^ruby\//i,
  /headlesschrome/i,
  /phantomjs/i,
  /selenium/i,
];
const BURST_WINDOW_REQUESTS = 25;
const BURST_WINDOW_MS = 5000;

async function botFilter(req, res, next) {
  if (req.path === "/webhook" || req.path === "/health") return next();
  const ua = (req.headers["user-agent"] || "").trim();
  if (!ua) {
    logSecurityEvent("bot_blocked", { ip: req.ip, path: req.path, reason: "empty_ua" });
    return res.status(403).json({ error: "Forbidden" });
  }
  if (BOT_UA_PATTERNS.some((p) => p.test(ua))) {
    logSecurityEvent("bot_blocked", { ip: req.ip, path: req.path, reason: "known_bot", ua: ua.slice(0, 80) });
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const burstCount = await redis.incrementBurst(req.ip);
    if (burstCount > BURST_WINDOW_REQUESTS) {
      logSecurityEvent("suspicious_ip_blocked", { ip: req.ip, path: req.path, reason: "burst", count: burstCount });
      await redis.blockIp(req.ip, IP_BLOCK_DURATION_MS);
      return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
    }
  } catch (_) {}
  next();
}

// ── Replay / spam: block repeated identical messages ───────────────────
const replayBuckets = new Map();
const REPLAY_WINDOW_MS = 60 * 1000;
const REPLAY_MAX_SAME = 3;
const REPLAY_MAX_ENTRIES = 50000;

function checkReplaySpam(visitorKey, message) {
  if (!message || typeof message !== "string") return false;
  const key = visitorKey;
  const msgNorm = message.trim().toLowerCase().slice(0, 500);
  const now = Date.now();
  let bucket = replayBuckets.get(key);
  if (!bucket) {
    bucket = [];
    replayBuckets.set(key, bucket);
  }
  bucket.push({ msg: msgNorm, ts: now });
  const since = now - REPLAY_WINDOW_MS;
  const recent = bucket.filter((e) => e.ts > since);
  replayBuckets.set(key, recent.length > 20 ? recent.slice(-20) : recent);
  if (replayBuckets.size > REPLAY_MAX_ENTRIES) {
    const firstKey = replayBuckets.keys().next().value;
    replayBuckets.delete(firstKey);
  }
  const sameCount = recent.filter((e) => e.msg === msgNorm).length;
  return sameCount > REPLAY_MAX_SAME;
}

// ── Input validation helpers ───────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isValidEmail(email) {
  return typeof email === "string" && email.length <= 254 && EMAIL_RE.test(email);
}

function isPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}

const AI_MESSAGE_MAX_LENGTH = 2000;
const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 255;
const MAX_PHONE_LENGTH = 50;
const MAX_LEAD_MESSAGE_LENGTH = 2000;

function sanitizeString(str, maxLen = 5000) {
  if (typeof str !== "string") return "";
  return str
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<[^>]*>/g, "")
    .slice(0, maxLen);
}

function validateIdParam(req, res, next) {
  const id = req.params.id || req.params.businessId;
  if (id !== undefined && !isPositiveInt(id)) {
    return res.status(400).json({ error: "Invalid ID parameter." });
  }
  next();
}

// ── Request body sanitization middleware ────────────────────────────────
function sanitizeBody(req, _res, next) {
  if (req.body && typeof req.body === "object") {
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === "string") {
        req.body[key] = req.body[key]
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
          .replace(/on\w+\s*=\s*["'][^"']*["']/gi, "");
      }
    }
  }
  next();
}

// ── Safe error handler (no stack traces or secrets to client) ─────────
function safeErrorHandler(err, req, res, _next) {
  if (err.code === "EBADCSRFTOKEN") {
    logSecurityEvent("csrf_violation", { ip: req.ip, path: req.path });
    return res.status(403).json({ error: "Invalid CSRF token." });
  }
  const isProd = process.env.NODE_ENV === "production";
  logSecurityEvent("server_error", { path: req.path, method: req.method, timestamp: new Date().toISOString() });
  if (isProd) {
    console.error("UNHANDLED_ERROR:", { path: req.path, method: req.method });
  } else {
    console.error("UNHANDLED_ERROR:", {
      message: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
    });
  }
  res.status(500).json({ error: "Internal server error" });
}

// ── Environment variable validation ────────────────────────────────────
const MIN_SESSION_SECRET_LENGTH = 32;

function validateEnvVars() {
  const required = [
    "SESSION_SECRET",
    "ANTHROPIC_API_KEY",
    "VOYAGE_API_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "DATABASE_URL",
  ];
  const missing = required.filter((key) => !process.env[key] || String(process.env[key]).trim() === "");
  if (missing.length > 0) {
    console.error("FATAL: Missing required environment variables: " + missing.join(", ") + ". Set them in .env and restart.");
    process.exit(1);
  }
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length < MIN_SESSION_SECRET_LENGTH) {
    console.error("FATAL: SESSION_SECRET must be at least " + MIN_SESSION_SECRET_LENGTH + " characters.");
    process.exit(1);
  }
}

module.exports = {
  globalLimiter,
  authLimiter,
  agentLimiter,
  passwordLimiter,
  billingLimiter,
  webhookLimiter,
  trainingLimiter,
  perUserLimiter,
  aiPerUserLimiter,
  ipBlockMiddleware,
  trackLoginFailure,
  resetLoginAttempts,
  isLoginBlocked,
  isValidEmail,
  isPositiveInt,
  sanitizeString,
  validateIdParam,
  sanitizeBody,
  logSecurityEvent,
  safeErrorHandler,
  validateEnvVars,
  requestTimeoutMiddleware,
  botFilter,
  checkReplaySpam,
  AI_MESSAGE_MAX_LENGTH,
  MAX_NAME_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_PHONE_LENGTH,
  MAX_LEAD_MESSAGE_LENGTH,
};