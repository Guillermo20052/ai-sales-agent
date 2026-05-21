const express = require("express");
const path = require("path");
const pool = require("../services/db");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { sendPasswordResetEmail } = require("../services/emailService");
const { isValidEmail, logSecurityEvent } = require("../middleware/security");

const router = express.Router();
const isProd = process.env.NODE_ENV === "production";

function getBaseUrl(req) {
  // Prefer explicit BASE_URL but fall back to request host for dev/local
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/+$/, "");
  }
  return `${req.protocol}://${req.get("host")}`;
}

function wantsJson(req) {
  return (
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes("application/json"))
  );
}

/**
 * =========================
 * GET /password/forgot
 * Show forgot password page
 * =========================
 */
router.get("/forgot", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "forgot-password.html"));
});

/**
 * =========================
 * GET /password/reset
 * Validate token + show reset page
 * =========================
 */
router.get("/reset", async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.redirect("/login.html");
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const result = await pool.query(
      `SELECT id FROM password_resets
       WHERE token = $1
       AND expires_at > NOW()`,
      [tokenHash],
    );

    if (!result.rows.length) {
      // Friendly error page for invalid/expired tokens
      return res
        .status(400)
        .send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Password reset link invalid</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f5; margin: 0; padding: 40px 16px; }
      .container { max-width: 480px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 32px 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
      h1 { font-size: 22px; margin-bottom: 12px; color: #111827; }
      p { font-size: 15px; color: #4b5563; line-height: 1.6; margin-bottom: 8px; }
      a { color: #4f46e5; text-decoration: none; font-weight: 600; }
      .btn { display: inline-block; margin-top: 16px; padding: 10px 18px; background: #4f46e5; color: #fff; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Password reset link expired</h1>
      <p>That password reset link is invalid or has expired.</p>
      <p>You can request a new link from the forgot password page.</p>
      <a href="/forgot-password.html" class="btn">Back to reset password</a>
    </div>
  </body>
</html>`);
    }

    return res.sendFile(path.join(__dirname, "..", "views", "reset-password.html"));
  } catch (err) {
    if (!isProd) {
      console.error("RESET PASSWORD TOKEN VALIDATION ERROR:", err);
    }
    if (wantsJson(req)) {
      return res.status(500).json({ error: "Server error" });
    }
    return res
      .status(500)
      .send("An unexpected error occurred. Please try again.");
  }
});

/**
 * =========================
 * POST /password/forgot
 * Generate reset token
 * =========================
 */
router.post("/forgot", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.json({ success: true });
    }

    const userResult = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [email],
    );

    if (!userResult.rows.length) {
      // Do not reveal whether the email exists
      if (!isProd) {
        console.log(
          "[dev] No user found for this email; no email sent (same response to client).",
        );
      }
      return res.json({ success: true });
    }

    const userId = userResult.rows[0].id;

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60); // 1 hour

    // Invalidate any previous reset tokens for this user
    await pool.query("DELETE FROM password_resets WHERE user_id = $1", [
      userId,
    ]);

    await pool.query(
      `INSERT INTO password_resets (user_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, tokenHash, expiresAt],
    );

    const baseUrl = getBaseUrl(req);
    const resetLink = `${baseUrl}/password/reset?token=${rawToken}`;

    logSecurityEvent("password_reset_request", { userId, ip: req.ip, timestamp: new Date().toISOString() });
    // Send reset email; never throw on SMTP issues
    const emailSent = await sendPasswordResetEmail(email, resetLink);
    if (!isProd && !emailSent) {
      console.error(
        "Password reset email could not be sent. Check SMTP settings and any PASSWORD RESET EMAIL ERROR above.",
      );
    }

    res.json({ success: true });
  } catch (err) {
    if (!isProd) {
      console.error("FORGOT PASSWORD ERROR:", err);
    }
    if (wantsJson(req)) {
      return res.status(500).json({ error: "Server error" });
    }
    return res
      .status(500)
      .send("An unexpected error occurred. Please try again.");
  }
});

/**
 * =========================
 * POST /password/reset
 * Update password
 * =========================
 */
router.post("/reset", async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      if (wantsJson(req)) {
        return res.status(400).json({ error: "Invalid request" });
      }
      return res.status(400).send("Invalid password reset request.");
    }

    if (typeof password !== "string" || password.length < 8 || password.length > 128) {
      if (wantsJson(req)) {
        return res.status(400).json({ error: "Password must be between 8 and 128 characters" });
      }
      return res.status(400).send("Password must be between 8 and 128 characters.");
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const result = await pool.query(
      `SELECT * FROM password_resets
       WHERE token = $1
       AND expires_at > NOW()`,
      [tokenHash],
    );

    if (!result.rows.length) {
      if (wantsJson(req)) {
        return res
          .status(400)
          .json({ error: "Invalid or expired token" });
      }
      return res
        .status(400)
        .send("Your password reset link is invalid or has expired.");
    }

    const resetRow = result.rows[0];

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query("UPDATE users SET password = $1 WHERE id = $2", [
      hashedPassword,
      resetRow.user_id,
    ]);

    // Prevent token reuse: delete all reset tokens for this user
    await pool.query("DELETE FROM password_resets WHERE user_id = $1", [
      resetRow.user_id,
    ]);

    logSecurityEvent("password_reset_success", { userId: resetRow.user_id, ip: req.ip, timestamp: new Date().toISOString() });
    // Destroy any active session after password change
    try {
      if (req.session && typeof req.session.destroy === "function") {
        req.session.destroy(() => {});
      }
    } catch (_) {}

    if (wantsJson(req)) {
      return res.json({ success: true });
    }

    // Redirect to login with a success hint for server-rendered flows
    return res.redirect("/login.html?reset=success");
  } catch (err) {
    if (!isProd) {
      console.error("RESET PASSWORD ERROR:", err);
    }
    if (wantsJson(req)) {
      return res.status(500).json({ error: "Server error" });
    }
    return res
      .status(500)
      .send("An unexpected error occurred. Please try again.");
  }
});

module.exports = router;
