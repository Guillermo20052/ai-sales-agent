require("dotenv").config();

const express = require("express");
const session = require("express-session");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5000;

const passwordRoutes = require("./routes/password");
app.use("/password", passwordRoutes);

/* ========= HEALTH CHECK (instant 200, no DB) ========= */
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

/* ========= LANDING PAGE (also serves as health check — returns 200) ========= */
const fs = require("fs");
const landingHtml = fs.readFileSync("./views/landing.html", "utf8");
app.get("/", (req, res) => {
  res.status(200).send(landingHtml);
});

/* ========= STRIPE WEBHOOK (MUST BE FIRST & RAW) ========= */
app.use(
  "/webhook",
  express.raw({ type: "application/json" }),
  require("./routes/webhook"),
);

/* ========= MIDDLEWARE ========= */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "devsecret",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }, // Set true only if forcing HTTPS
  }),
);

/* ========= STATIC FILES ========= */
app.use(express.static("public"));

/* ========= ROUTES ========= */
app.use("/auth", require("./routes/auth"));
app.use("/chat", require("./routes/chat"));
app.use("/dashboard", require("./routes/dashboard"));
app.use("/agent", require("./routes/agent"));
app.use("/b", require("./routes/publicBusiness"));
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

/* ========= LOGOUT ========= */
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
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

/* ========= BACKWARD COMPAT — /home alias ========= */
app.get("/home", (req, res) => {
  res.status(200).send(landingHtml);
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

/* ========= START SERVER ========= */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
