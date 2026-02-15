require("dotenv").config();

const express = require("express");
const session = require("express-session");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5000;

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
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).send("Invalid or expired verification link.");
    }

    const userId = result.rows[0].id;

    await pool.query(
      "UPDATE users SET email_verified = true, verification_token = NULL WHERE id = $1",
      [userId]
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
      "SELECT email_verified, subscription_status, is_paid FROM users WHERE id = $1",
      [req.session.userId]
    );

    if (result.rows.length === 0) {
      return res.redirect("/login.html");
    }

    const user = result.rows[0];

    if (!user.email_verified) {
      return res.redirect("/verify-pending");
    }

    if (user.subscription_status === "active" || user.is_paid) {
      return res.redirect("/dashboard");
    }

    res.sendFile(__dirname + "/views/checkout.html");
  } catch (err) {
    console.error("CHECKOUT PAGE ERROR:", err);
    res.status(500).send("Server error.");
  }
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
  res.send(`<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Payment Successful</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet"/><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:#0f1117;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#161822;border:1px solid rgba(255,255,255,0.06);border-radius:20px;padding:48px;text-align:center;max-width:440px}.icon{width:64px;height:64px;border-radius:50%;background:rgba(16,185,129,0.12);display:inline-flex;align-items:center;justify-content:center;font-size:32px;margin-bottom:24px}h1{font-size:24px;font-weight:800;color:#fff;margin-bottom:8px}p{font-size:15px;color:rgba(255,255,255,0.5);margin-bottom:32px;line-height:1.6}a{display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:14px;font-weight:700;border-radius:10px;text-decoration:none;transition:all 0.2s}a:hover{transform:translateY(-1px);box-shadow:0 8px 25px rgba(99,102,241,0.35)}</style></head><body><div class="card"><div class="icon">&#10003;</div><h1>Payment Successful!</h1><p>Your subscription has been activated. You now have unlimited access to AI Sales Agent.</p><a href="/dashboard/install">Go to Dashboard</a></div></body></html>`);
});

app.get("/cancel", (req, res) => {
  res.send(`<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Payment Cancelled</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet"/><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:#0f1117;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#161822;border:1px solid rgba(255,255,255,0.06);border-radius:20px;padding:48px;text-align:center;max-width:440px}.icon{width:64px;height:64px;border-radius:50%;background:rgba(239,68,68,0.12);display:inline-flex;align-items:center;justify-content:center;font-size:32px;margin-bottom:24px}h1{font-size:24px;font-weight:800;color:#fff;margin-bottom:8px}p{font-size:15px;color:rgba(255,255,255,0.5);margin-bottom:32px;line-height:1.6}a{display:inline-block;padding:12px 32px;background:rgba(255,255,255,0.08);color:#fff;font-size:14px;font-weight:700;border-radius:10px;text-decoration:none;border:1px solid rgba(255,255,255,0.1);transition:all 0.2s}a:hover{background:rgba(255,255,255,0.12)}</style></head><body><div class="card"><div class="icon">&#10005;</div><h1>Payment Cancelled</h1><p>Your payment was not processed. You can try again anytime from your dashboard.</p><a href="/dashboard/install">Back to Dashboard</a></div></body></html>`);
});

/* ========= START SERVER ========= */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
