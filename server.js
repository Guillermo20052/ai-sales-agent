require("dotenv").config();

// ── Node version enforcement (engines: node >=18) ─────────────────────────
const nodeMajor = parseInt(process.version.slice(1).split(".")[0], 10);
if (nodeMajor < 18) {
  console.error("FATAL: Node.js 18 or later is required. Current:", process.version);
  process.exit(1);
}

// ── Process-level crash protection ───────────────────────────────────────
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return '{"error":"Invalid response"}';
  }
}

process.on("uncaughtException", (err) => {
  const msg = err && err.message ? err.message : String(err);
  console.error("UNCAUGHT_EXCEPTION:", msg);
  if (err && err.stack) console.error(err.stack);
  setTimeout(() => process.exit(1), 500);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("UNHANDLED_REJECTION:", reason);
});

const {
  globalLimiter,
  authLimiter,
  agentLimiter,
  sanitizeBody,
  safeErrorHandler,
  validateEnvVars,
  passwordLimiter,
  requestTimeoutMiddleware,
  botFilter,
  ipBlockMiddleware,
  perUserLimiter,
  aiPerUserLimiter,
} = require("./middleware/security");

validateEnvVars();

if (process.env.NODE_ENV === "development") {
  console.log("Database connection configured.");
}

const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const cors = require("cors");
const helmet = require("helmet");

const app = express();
app.disable("x-powered-by");
const PORT = process.env.PORT || 5000;
if (!process.env.AGENT_STRICT_GROUNDED) process.env.AGENT_STRICT_GROUNDED = "true";
if (!process.env.AGENT_STRICT_MIN_EVIDENCE) process.env.AGENT_STRICT_MIN_EVIDENCE = "1";
if (!process.env.AGENT_STRICT_MIN_SCORE) process.env.AGENT_STRICT_MIN_SCORE = "0.35";
if (!process.env.AGENT_MAX_REPLY_SOURCES) process.env.AGENT_MAX_REPLY_SOURCES = "2";
if (!process.env.AGENT_ENABLE_LIVE_NAV) process.env.AGENT_ENABLE_LIVE_NAV = "true";
if (!process.env.AGENT_LIVE_NAV_MAX_STEPS) process.env.AGENT_LIVE_NAV_MAX_STEPS = "2";
if (!process.env.AGENT_LIVE_NAV_TIMEOUT_MS) process.env.AGENT_LIVE_NAV_TIMEOUT_MS = "8000";
if (!process.env.AGENT_LIVE_NAV_TOTAL_BUDGET_MS) process.env.AGENT_LIVE_NAV_TOTAL_BUDGET_MS = "12000";
if (!process.env.AGENT_MEMORY_DEFAULT_ENABLED) process.env.AGENT_MEMORY_DEFAULT_ENABLED = "true";
if (!process.env.AGENT_MEMORY_DEFAULT_RETENTION_DAYS) process.env.AGENT_MEMORY_DEFAULT_RETENTION_DAYS = "30";
if (!process.env.AGENT_RETRIEVAL_CACHE_TTL_MS) process.env.AGENT_RETRIEVAL_CACHE_TTL_MS = "45000";
if (!process.env.AGENT_NAV_CACHE_TTL_MS) process.env.AGENT_NAV_CACHE_TTL_MS = "30000";
if (!process.env.AGENT_RATE_LIMIT_PER_MIN) process.env.AGENT_RATE_LIMIT_PER_MIN = "40";
if (!process.env.AGENT_CATALOG_NARROW_THRESHOLD) process.env.AGENT_CATALOG_NARROW_THRESHOLD = "12";
if (!process.env.AGENT_QUEUE_CONCURRENCY) process.env.AGENT_QUEUE_CONCURRENCY = "1";
if (!process.env.AGENT_QUEUE_MAX_JOBS) process.env.AGENT_QUEUE_MAX_JOBS = "500";
if (!process.env.SLA_FALLBACK_WARN_PCT) process.env.SLA_FALLBACK_WARN_PCT = "45";
if (!process.env.SLA_ERROR_WARN_PCT) process.env.SLA_ERROR_WARN_PCT = "8";
if (!process.env.SLA_P95_WARN_MS) process.env.SLA_P95_WARN_MS = "8000";
if (!process.env.SLA_QUEUE_WARN) process.env.SLA_QUEUE_WARN = "25";

const useHttps = process.env.NODE_ENV === "production" || String(process.env.USE_HTTPS || "").toLowerCase() === "true";

// Security headers (apply to all routes and static)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://js.stripe.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https://api.stripe.com"],
        frameSrc: ["https://js.stripe.com"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    frameguard: { action: "deny" },
    xContentTypeOptions: true,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: useHttps ? { maxAge: 31536000, includeSubDomains: true } : false,
  })
);

// Body parsing with size limits
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Request timeout (15s)
app.use(requestTimeoutMiddleware(15 * 1000));

// Block abusive IPs (Redis-backed when REDIS_URL set)
app.use(ipBlockMiddleware);

// Bot detection (skip webhook/health in middleware)
app.use(botFilter);

// Global rate limiting (100/min per IP)
app.use(globalLimiter);

// Sanitize request bodies
app.use(sanitizeBody);

// Safe JSON: prevent circular refs and huge objects from crashing response
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = function (body) {
    try {
      const str = safeStringify(body);
      if (str === '{"error":"Invalid response"}') {
        res.status(500).set("Content-Type", "application/json").send(str);
        return res;
      }
      res.setHeader("Content-Type", "application/json");
      res.send(str);
      return res;
    } catch (_) {
      res.status(500).set("Content-Type", "application/json").send('{"error":"Server error"}');
      return res;
    }
  };
  next();
});

const passwordRoutes = require("./routes/password");
app.use("/password", passwordLimiter, passwordRoutes);

/* ========= HEALTH CHECK (DB, Redis, AI config) ========= */
app.get("/health", async (req, res) => {
  const status = { status: "ok", database: "unknown", redis: "unknown", ai: "unknown" };
  let httpStatus = 200;
  try {
    await pool.query("SELECT 1");
    status.database = "connected";
  } catch (err) {
    status.database = "error";
    console.error("HEALTH_DB_ERROR:", err.message);
    httpStatus = 503;
  }
  try {
    const redis = require("./services/redis");
    if (redis.REDIS_URL) {
      status.redis = (await redis.ping()) ? "connected" : "error";
      if (status.redis === "error") httpStatus = 503;
    } else {
      status.redis = "disabled";
    }
  } catch (err) {
    status.redis = "error";
    console.error("HEALTH_REDIS_ERROR:", err.message);
    httpStatus = 503;
  }
  status.ai = process.env.ANTHROPIC_API_KEY && String(process.env.ANTHROPIC_API_KEY).trim() ? "configured" : "missing";
  status.embeddings = process.env.VOYAGE_API_KEY && String(process.env.VOYAGE_API_KEY).trim() ? "configured" : "missing";
  if (status.ai === "missing") status.ai = "not_configured";
  if (status.embeddings === "missing") status.embeddings = "not_configured";
  res.status(httpStatus).json(status);
});

/* ========= PUBLIC SLA HEALTH (no internal metrics) ========= */
app.get("/health/sla", async (req, res) => {
  try {
    const health = require("./services/slaService").evaluateHealth();
    const payload = { status: health.status, alerts: health.alerts, timestamp: health.timestamp };
    const httpStatus = health.status === "healthy" ? 200 : 503;
    res.status(httpStatus).json(payload);
  } catch (err) {
    console.error("HEALTH_SLA_ERROR:", err.message);
    res.status(503).json({ status: "error", alerts: [], timestamp: new Date().toISOString() });
  }
});

/* ========= LANDING PAGE (also serves as health check — returns 200) ========= */
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/views/landing.html");
});

/* ========= STRIPE WEBHOOK (MUST BE FIRST & RAW) ========= */
const { webhookLimiter } = require("./middleware/security");
app.use(
  "/webhook",
  express.raw({ type: "application/json" }),
  webhookLimiter,
  require("./routes/webhook"),
);

/* ========= MIDDLEWARE ========= */
app.set("trust proxy", 1);

const agentCors = cors({ origin: "*" });
const baseOrigin = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/+$/, "") : null;
const restrictedCors = cors({
  origin: baseOrigin ? baseOrigin : false,
  credentials: true,
});
app.use("/agent", agentCors);
app.use(restrictedCors);

/* ========= STATIC FILES (safe: resolved path, block directory traversal) ========= */
const path = require("path");
const publicDir = path.join(__dirname, "public");
app.use((req, res, next) => {
  const p = (req.path || "").replace(/\/+/g, "/");
  if (p.includes("..") || /\.env$/i.test(p)) return res.status(404).send("Not Found");
  next();
});
app.use(express.static(publicDir));

const sessionPool = require("./services/db");
app.use(
  session({
    store: new pgSession({
      pool: sessionPool,
      tableName: "user_sessions",
      createTableIfMissing: true,
      pruneSessionInterval: 60 * 15,
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: useHttps,
      sameSite: "strict",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
    name: "sid",
  }),
);

// Per-user rate limit (200/min when authenticated)
app.use(perUserLimiter);

/* ========= ROUTES ========= */
app.use("/auth", authLimiter, require("./routes/auth"));
app.use("/chat", aiPerUserLimiter, agentLimiter, requestTimeoutMiddleware(30 * 1000), require("./routes/chat"));
app.use("/dashboard", require("./routes/dashboard"));
app.use("/agent", aiPerUserLimiter, agentLimiter, requestTimeoutMiddleware(30 * 1000), require("./routes/agent"));
app.use("/b", require("./routes/publicBusiness"));
app.use("/indexing", require("./routes/indexing"));
app.use("/internal-admin-portal-93847", require("./routes/admin"));

/* ========= SIGNUP PAGE ========= */
app.get("/signup", (req, res) => {
  res.sendFile(__dirname + "/views/signup.html");
});

/* ========= EMAIL VERIFICATION ========= */
const pool = require("./services/db");

app.get("/verify", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).send("Invalid verification link.");
    }

    const result = await pool.query(
      "SELECT id FROM users WHERE verification_token = $1",
      [token],
    );

    if (result.rows.length === 0) {
      return res.status(400).send("Invalid or expired verification link.");
    }

    const userId = result.rows[0].id;

    await pool.query(
      "UPDATE users SET email_verified = true, verification_token = NULL WHERE id = $1",
      [userId],
    );

    req.session.userId = userId;
    req.session._ip = req.ip;
    req.session._ua = req.headers["user-agent"];
    req.session._lastActivity = Date.now();
    req.session._createdAt = Date.now();

    logAuthEvent("email_verification", { userId, ip: req.ip, timestamp: new Date().toISOString() });
    res.redirect("/checkout");
  } catch (err) {
    console.error("VERIFY ERROR:", err);
    res.status(500).send("Server error.");
  }
});

/* ========= VERIFY PENDING PAGE ========= */
app.get("/verify-pending", (req, res) => {
  res.sendFile(__dirname + "/views/verify-pending.html");
});

/* ========= CHECKOUT PAGE ========= */
app.get("/checkout", async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.redirect("/login.html");
    }

    const result = await pool.query(
      "SELECT email_verified, subscription_status, is_paid, role FROM users WHERE id = $1",
      [req.session.userId],
    );

    if (result.rows.length === 0) {
      return res.redirect("/login.html");
    }

    const user = result.rows[0];

    if (user.role === "admin" || user.subscription_status === "active") {
      return res.redirect("/dashboard");
    }

    if (!user.email_verified) {
      return res.redirect("/verify-pending");
    }

    res.sendFile(__dirname + "/views/checkout.html");
  } catch (err) {
    console.error("CHECKOUT PAGE ERROR:", err);
    res.status(500).send("Server error.");
  }
});

/* ========= INSTALL SUCCESS PAGE ========= */
const Stripe = require("stripe");
const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);

app.get("/install-success", async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.redirect("/login.html");
    }

    const sessionId = req.query.session_id;
    if (sessionId) {
      try {
        const stripeSession =
          await stripeClient.checkout.sessions.retrieve(sessionId);
        const metaUserId = stripeSession.metadata?.userId;
        if (
          metaUserId &&
          String(metaUserId) === String(req.session.userId) &&
          stripeSession.payment_status === "paid"
        ) {
          await pool.query(
            "UPDATE users SET subscription_status = 'active', is_paid = true WHERE id = $1",
            [req.session.userId],
          );
          console.log(
            "INSTALL-SUCCESS: Stripe-verified activation for user:",
            req.session.userId,
          );
        }
      } catch (stripeErr) {
        console.error(
          "INSTALL-SUCCESS: Stripe session verification error:",
          stripeErr.message,
        );
      }
    }

    const userCheck = await pool.query(
      "SELECT subscription_status FROM users WHERE id = $1",
      [req.session.userId],
    );
    if (
      !userCheck.rows.length ||
      userCheck.rows[0].subscription_status !== "active"
    ) {
      return res.redirect("/checkout");
    }

    const result = await pool.query(
      `SELECT u.id, bp.business_name, bp.id as business_id
       FROM users u
       LEFT JOIN business_profiles bp ON bp.user_id = u.id
       WHERE u.id = $1`,
      [req.session.userId],
    );

    const row = result.rows[0];
    const businessName =
      row && row.business_name ? row.business_name : "Your Business";
    const baseUrl = process.env.BASE_URL || "";
    const hostedLink =
      row && row.business_id ? `${baseUrl}/b/${row.business_id}` : "";
    const embedCode =
      row && row.business_id
        ? `&lt;script src="${baseUrl}/widget.js" data-business="${row.business_id}"&gt;&lt;/script&gt;`
        : "";

    res
      .status(200)
      .send(
        `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Subscription Activated - AI Sales Agent</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet"/><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:#0f1117;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;color:#e1e4e8}.card{background:#161822;border:1px solid rgba(255,255,255,0.06);border-radius:20px;padding:48px;text-align:center;max-width:560px;width:100%}.icon{width:72px;height:72px;border-radius:50%;background:rgba(16,185,129,0.12);display:inline-flex;align-items:center;justify-content:center;font-size:36px;margin-bottom:24px}h1{font-size:28px;font-weight:800;color:#fff;margin-bottom:8px;letter-spacing:-0.5px}p.sub{font-size:15px;color:rgba(255,255,255,0.5);margin-bottom:32px;line-height:1.6}.status-badge{display:inline-flex;align-items:center;gap:8px;padding:8px 18px;border-radius:100px;font-size:14px;font-weight:600;background:rgba(16,185,129,0.12);color:#34d399;border:1px solid rgba(16,185,129,0.2);margin-bottom:28px}.status-dot{width:8px;height:8px;border-radius:50%;background:#34d399;box-shadow:0 0 8px rgba(52,211,153,0.5)}.info-box{background:#0d0f16;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px 20px;margin-bottom:16px;text-align:left}.info-label{font-size:11px;font-weight:600;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px}.info-value{font-size:13px;color:#a5b4fc;font-family:'SF Mono','Fira Code',monospace;word-break:break-all;line-height:1.6}.actions{display:flex;gap:12px;margin-top:28px;justify-content:center;flex-wrap:wrap}a.btn{display:inline-flex;align-items:center;gap:8px;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:700;text-decoration:none;transition:all 0.2s}a.btn-primary{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff}a.btn-primary:hover{transform:translateY(-1px);box-shadow:0 8px 25px rgba(99,102,241,0.35)}a.btn-outline{background:rgba(255,255,255,0.06);color:#fff;border:1px solid rgba(255,255,255,0.1)}a.btn-outline:hover{background:rgba(255,255,255,0.1)}.redirect-note{font-size:12px;color:rgba(255,255,255,0.3);margin-top:24px}@media(max-width:480px){.card{padding:32px 24px}h1{font-size:22px}.actions{flex-direction:column}a.btn{justify-content:center}}</style></head><body><div class="card"><div class="icon">&#10003;</div><h1>Subscription Activated!</h1><p class="sub">Your AI Sales Agent for <strong style="color:#fff">${businessName}</strong> is now live and ready to capture leads 24/7.</p><div class="status-badge"><span class="status-dot"></span>Agent is LIVE</div>${hostedLink ? `<div class="info-box"><div class="info-label">Your Hosted AI Agent Link</div><div class="info-value">${hostedLink}</div></div>` : ""}${embedCode ? `<div class="info-box"><div class="info-label">Embed Code</div><div class="info-value">${embedCode}</div></div>` : ""}<div class="actions"><a href="/dashboard" class="btn btn-primary">Go to Dashboard</a><a href="/dashboard/install" class="btn btn-outline">Install Widget</a></div><p class="redirect-note">Redirecting to dashboard in 3 seconds...</p></div><script>setTimeout(function(){window.location.href="/dashboard"},3000);</script></body></html>`,
      );
  } catch (err) {
    console.error("PAYMENT SUCCESS ERROR:", err);
    res
      .status(200)
      .send(
        `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Payment Successful</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet"/><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:#0f1117;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#161822;border:1px solid rgba(255,255,255,0.06);border-radius:20px;padding:48px;text-align:center;max-width:440px}.icon{width:64px;height:64px;border-radius:50%;background:rgba(16,185,129,0.12);display:inline-flex;align-items:center;justify-content:center;font-size:32px;margin-bottom:24px}h1{font-size:24px;font-weight:800;color:#fff;margin-bottom:8px}p{font-size:15px;color:rgba(255,255,255,0.5);margin-bottom:32px;line-height:1.6}a{display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:14px;font-weight:700;border-radius:10px;text-decoration:none;transition:all 0.2s}a:hover{transform:translateY(-1px);box-shadow:0 8px 25px rgba(99,102,241,0.35)}</style></head><body><div class="card"><div class="icon">&#10003;</div><h1>Payment Successful!</h1><p>Your subscription has been activated.</p><a href="/dashboard">Go to Dashboard</a></div></body></html>`,
      );
  }
});

/* ========= STOP IMPERSONATION ========= */
app.post("/admin/stop-impersonation", async (req, res) => {
  if (!req.session.adminImpersonatorId) {
    return res.redirect("/dashboard");
  }
  try {
    const adminCheck = await pool.query(
      "SELECT role FROM users WHERE id = $1",
      [req.session.adminImpersonatorId],
    );
    if (!adminCheck.rows.length || adminCheck.rows[0].role !== "admin") {
      req.session.destroy(() => {
        res.clearCookie("sid", { path: "/" });
        res.redirect("/login.html");
      });
      return;
    }
  } catch (err) {
    return res.redirect("/dashboard");
  }
  req.session.userId = req.session.adminImpersonatorId;
  delete req.session.adminImpersonatorId;
  res.redirect("/internal-admin-portal-93847/users");
});

/* ========= LOGOUT ========= */
const { logSecurityEvent: logAuthEvent } = require("./middleware/security");
app.get("/logout", (req, res) => {
  const userId = req.session && req.session.userId;
  const ip = req.ip;
  req.session.destroy(() => {
    if (userId != null || ip) {
      logAuthEvent("logout", { userId: userId || null, ip, timestamp: new Date().toISOString() });
    }
    res.clearCookie("sid", { path: "/" });
    res.redirect("/login.html");
  });
});

/* ========= BACKWARD COMPAT — /payment-success alias ========= */
app.get("/payment-success", (req, res) => {
  res.redirect("/install-success");
});

/* ========= TERMS & PRIVACY ========= */
app.get("/terms", (req, res) => {
  res.sendFile(__dirname + "/views/terms.html");
});

app.get("/privacy", (req, res) => {
  res.sendFile(__dirname + "/views/privacy.html");
});

/* ========= ABOUT ========= */
app.get("/about", (req, res) => {
  res.sendFile(__dirname + "/views/about.html");
});

/* ========= DEBUG EMAIL (temporary — remove after verifying SMTP works) ========= */
app.get("/debug-email", async (req, res) => {
  try {
    const { sendTestEmail } = require("./services/emailService");
    await sendTestEmail();
    res.json({ success: true, message: "Test email sent to sales@aiagentproperties.com" });
  } catch (err) {
    console.error("DEBUG_EMAIL_ERROR:", err.message);
    if (err.response) console.error("DEBUG_EMAIL SMTP response:", err.response);
    if (err.code) console.error("DEBUG_EMAIL SMTP code:", err.code);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ========= CONTACT SALES ========= */
app.get("/contact-sales", (req, res) => {
  res.sendFile(__dirname + "/views/contact-sales.html");
});

app.post("/contact-sales", async (req, res) => {
  const { name, email, businessName, message } = req.body || {};
  if (!name || !email) {
    return res.redirect("/contact-sales");
  }
  try {
    const { sendContactSalesEmail } = require("./services/emailService");
    await sendContactSalesEmail({
      name: String(name).slice(0, 200),
      email: String(email).slice(0, 254),
      company: String(businessName || "").slice(0, 200),
      message: String(message || "").slice(0, 5000),
    });
  } catch (err) {
    console.error("CONTACT_SALES_ROUTE_ERROR:", err.message);
  }
  res.redirect("/contact-sales?success=1");
});

/* ========= BACKWARD COMPAT — /home alias ========= */
app.get("/home", (req, res) => {
  res.sendFile(__dirname + "/views/landing.html");
});

/* ========= STRIPE SUCCESS / CANCEL ========= */
app.get("/success", (req, res) => {
  res.send(
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Payment Successful</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet"/><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:#0f1117;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#161822;border:1px solid rgba(255,255,255,0.06);border-radius:20px;padding:48px;text-align:center;max-width:440px}.icon{width:64px;height:64px;border-radius:50%;background:rgba(16,185,129,0.12);display:inline-flex;align-items:center;justify-content:center;font-size:32px;margin-bottom:24px}h1{font-size:24px;font-weight:800;color:#fff;margin-bottom:8px}p{font-size:15px;color:rgba(255,255,255,0.5);margin-bottom:32px;line-height:1.6}a{display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:14px;font-weight:700;border-radius:10px;text-decoration:none;transition:all 0.2s}a:hover{transform:translateY(-1px);box-shadow:0 8px 25px rgba(99,102,241,0.35)}</style></head><body><div class="card"><div class="icon">&#10003;</div><h1>Payment Successful!</h1><p>Your subscription has been activated. You now have unlimited access to AI Sales Agent.</p><a href="/dashboard/install">Go to Dashboard</a></div></body></html>`,
  );
});

app.get("/cancel", (req, res) => {
  res.send(
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Payment Cancelled</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet"/><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:#0f1117;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#161822;border:1px solid rgba(255,255,255,0.06);border-radius:20px;padding:48px;text-align:center;max-width:440px}.icon{width:64px;height:64px;border-radius:50%;background:rgba(239,68,68,0.12);display:inline-flex;align-items:center;justify-content:center;font-size:32px;margin-bottom:24px}h1{font-size:24px;font-weight:800;color:#fff;margin-bottom:8px}p{font-size:15px;color:rgba(255,255,255,0.5);margin-bottom:32px;line-height:1.6}a{display:inline-block;padding:12px 32px;background:rgba(255,255,255,0.08);color:#fff;font-size:14px;font-weight:700;border-radius:10px;text-decoration:none;border:1px solid rgba(255,255,255,0.1);transition:all 0.2s}a:hover{background:rgba(255,255,255,0.12)}</style></head><body><div class="card"><div class="icon">&#10005;</div><h1>Payment Cancelled</h1><p>Your payment was not processed. You can try again anytime from your dashboard.</p><a href="/dashboard/install">Back to Dashboard</a></div></body></html>`,
  );
});

/* ========= 404 (after all routes) ========= */
app.use((req, res) => {
  res.status(404).send("Not Found");
});

/* ========= GLOBAL ERROR HANDLER (safe: no stack traces to clients) ========= */
app.use(safeErrorHandler);

/* ========= ENSURE business_profiles HAS WEBSITE COLUMNS ========= */
async function ensureBusinessProfilesWebsiteColumns() {
  const pool = require("./services/db");
  const alters = [
    'ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS website_url TEXT',
    'ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS website_knowledge JSONB',
    'ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS website_training_status TEXT',
    'ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS website_last_trained_at TIMESTAMPTZ',
    'ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS ai_agent_name VARCHAR(100)',
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS knowledge_priority VARCHAR(20) DEFAULT 'website'",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS memory_enabled BOOLEAN DEFAULT false",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS memory_retention_days INTEGER DEFAULT 30",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS strict_grounded_enabled BOOLEAN DEFAULT true",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS live_nav_enabled BOOLEAN DEFAULT true",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS citation_enabled BOOLEAN DEFAULT true",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS max_reply_sources INTEGER DEFAULT 2",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS language VARCHAR(16)",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS website_type VARCHAR(50)",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS detected_language VARCHAR(16)",
  ];
  for (const sql of alters) {
    try {
      await pool.query(sql);
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("Migration warning:", err.message);
      }
    }
  }
  await ensureBusinessWebsitePagesTable();
  await ensureBusinessWebsiteChunksTable();
}

async function ensureBusinessWebsitePagesTable() {
  const pool = require("./services/db");
  const sql = `
    CREATE TABLE IF NOT EXISTS business_website_pages (
      id SERIAL PRIMARY KEY,
      business_id INTEGER NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      page_type VARCHAR(50) NOT NULL DEFAULT 'general',
      title TEXT,
      cleaned_content TEXT,
      metadata_json JSONB,
      importance_score NUMERIC(5,2) DEFAULT 0,
      content_hash VARCHAR(64),
      extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(business_id, url)
    )`;
  try {
    await pool.query(sql);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_business_website_pages_business_id ON business_website_pages(business_id)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_business_website_pages_page_type ON business_website_pages(business_id, page_type)");
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Migration warning (business_website_pages):", err.message);
    }
  }
}

async function ensureBusinessWebsiteChunksTable() {
  const pool = require("./services/db");
  const sql = `
    CREATE TABLE IF NOT EXISTS business_website_chunks (
      id SERIAL PRIMARY KEY,
      business_id INTEGER NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
      page_url TEXT,
      page_type VARCHAR(50),
      content_chunk TEXT,
      embedding JSONB,
      extracted_at TIMESTAMPTZ DEFAULT NOW()
    )`;
  try {
    await pool.query(sql);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_business_website_chunks_business_id ON business_website_chunks(business_id)");
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Migration warning (business_website_chunks):", err.message);
    }
  }
}

/* ========= ENSURE PUBLIC AGENT TABLES EXIST (business_knowledge, conversations, messages, leads) ========= */
async function ensurePublicAgentTables() {
  const pool = require("./services/db");
  const statements = [
    `CREATE TABLE IF NOT EXISTS business_knowledge (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      description TEXT,
      services TEXT,
      pricing TEXT,
      faqs TEXT,
      tone TEXT,
      website_url TEXT,
      instagram_url TEXT,
      facebook_url TEXT,
      restrictions TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      business_id INTEGER NOT NULL,
      visitor_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT,
      email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()',
    'CREATE INDEX IF NOT EXISTS idx_conversations_business_id ON conversations(business_id)',
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_conversations_business_id') THEN
        ALTER TABLE conversations ADD CONSTRAINT fk_conversations_business_id
          FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
      END IF;
    END $$`,
    'CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)',
    'CREATE INDEX IF NOT EXISTS idx_leads_user_id ON leads(user_id)',
    // Leads schema upgrade: new columns
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS name TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'new'",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS conversation_id INTEGER",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS business_id INTEGER",
    // Leads FK: conversation_id → conversations(id)
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leads_conversation_id') THEN
        ALTER TABLE leads ADD CONSTRAINT fk_leads_conversation_id
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;
      END IF;
    END $$`,
    // Leads FK: business_id → business_profiles(id)
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leads_business_id') THEN
        ALTER TABLE leads ADD CONSTRAINT fk_leads_business_id
          FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
      END IF;
    END $$`,
    // Leads indexes
    'CREATE INDEX IF NOT EXISTS idx_leads_business_id ON leads(business_id)',
    'CREATE INDEX IF NOT EXISTS idx_leads_conversation_id ON leads(conversation_id)',
    'CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email)',
    // Backfill business_id from business_profiles
    `UPDATE leads SET business_id = bp.id FROM business_profiles bp WHERE leads.user_id = bp.user_id AND leads.business_id IS NULL`,
    // Default status for existing rows
    "UPDATE leads SET status = 'new' WHERE status IS NULL",
    `CREATE TABLE IF NOT EXISTS business_products (
      id SERIAL PRIMARY KEY,
      business_id INTEGER NOT NULL,
      title TEXT,
      description TEXT,
      price TEXT,
      image_url TEXT,
      page_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS business_visitor_memory (
      id SERIAL PRIMARY KEY,
      business_id INTEGER NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
      visitor_id TEXT NOT NULL,
      memory_text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (business_id, visitor_id)
    )`,
    `CREATE TABLE IF NOT EXISTS agent_audit_logs (
      id SERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      business_id INTEGER REFERENCES business_profiles(id) ON DELETE SET NULL,
      conversation_id INTEGER,
      visitor_id TEXT,
      outcome TEXT,
      details_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    'CREATE INDEX IF NOT EXISTS idx_business_products_business_id ON business_products(business_id)',
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_business_products_business_id') THEN
        ALTER TABLE business_products ADD CONSTRAINT fk_business_products_business_id
          FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
      END IF;
    END $$`,
    'CREATE INDEX IF NOT EXISTS idx_business_visitor_memory_business_id ON business_visitor_memory(business_id)',
    'CREATE INDEX IF NOT EXISTS idx_agent_audit_logs_created_at ON agent_audit_logs(created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_agent_audit_logs_business_id ON agent_audit_logs(business_id, created_at DESC)',
  ];
  for (const sql of statements) {
    try {
      await pool.query(sql);
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("Migration warning:", err.message);
      }
    }
  }
}

/* ========= START SERVER ========= */
const server = app.listen(PORT, "0.0.0.0", async () => {
  if (process.env.NODE_ENV === "development") {
    const { initDb } = require("./scripts/initDb");
    await initDb();
  }
  await ensurePublicAgentTables();
  await ensureBusinessProfilesWebsiteColumns();
  console.log("Server running on port", PORT);
});

function gracefulShutdown(signal) {
  console.log(signal, "received: closing server and connections");
  server.close((err) => {
    if (err) console.error("SERVER_CLOSE_ERROR:", err.message);
    pool.end().catch((e) => console.error("POOL_CLOSE_ERROR:", e.message)).then(() => {
      try {
        require("./services/redis").close();
      } catch (_) {}
      process.exit(err ? 1 : 0);
    });
  });
  setTimeout(() => {
    console.error("Graceful shutdown timeout: forcing exit");
    process.exit(1);
  }, 15000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
