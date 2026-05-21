const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const pool = require("../services/db");
const { sendVerificationEmail } = require("../services/emailService");
const {
  trackLoginFailure,
  resetLoginAttempts,
  isLoginBlocked,
  isValidEmail,
  logSecurityEvent,
} = require("../middleware/security");

const router = express.Router();

/**
 * POST /auth/login
 * Body: { email, password }
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    const clientIp = req.ip;
    const userAgent = (req.headers["user-agent"] || "").slice(0, 256);
    const emailAttempted = (email && typeof email === "string") ? email.toLowerCase().trim().slice(0, 255) : "";

    if (await isLoginBlocked(clientIp)) {
      logSecurityEvent("login_blocked", { ip: clientIp, email: emailAttempted, userAgent, timestamp: new Date().toISOString() });
      logSecurityEvent("security_alert", { reason: "multiple_failed_logins", ip: clientIp, email: emailAttempted, timestamp: new Date().toISOString() });
      return res.status(429).json({ error: "Too many failed login attempts. Please try again in 10 minutes." });
    }

    const result = await pool.query("SELECT * FROM users WHERE email = $1", [
      email.toLowerCase().trim(),
    ]);

    if (result.rows.length === 0) {
      trackLoginFailure(clientIp);
      logSecurityEvent("failed_login", { ip: clientIp, email: emailAttempted, userAgent, reason: "unknown_email", timestamp: new Date().toISOString() });
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const user = result.rows[0];

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      trackLoginFailure(clientIp);
      logSecurityEvent("failed_login", { ip: clientIp, email: emailAttempted, userAgent, reason: "invalid_password", userId: user.id, timestamp: new Date().toISOString() });
      return res.status(400).json({ error: "Invalid credentials" });
    }

    resetLoginAttempts(clientIp);

    let redirect = "/dashboard";

    if (user.role === "admin") {
      redirect = "/internal-admin-portal-93847";
    } else if (!user.email_verified) {
      redirect = "/verify-pending";
    } else if (user.subscription_status !== "active") {
      redirect = "/checkout";
    }

    req.session.regenerate((err) => {
      if (err) {
        console.error("SESSION REGENERATE ERROR:", err);
        return res.status(500).json({ error: "Server error" });
      }
      req.session.userId = user.id;
      req.session._ip = req.ip;
      req.session._ua = req.headers["user-agent"];
      req.session._lastActivity = Date.now();
      req.session._createdAt = Date.now();

      if (user.role === "admin") {
        // Extra regeneration for admin privilege escalation prevention
        req.session.regenerate((adminErr) => {
          if (adminErr) {
            console.error("ADMIN SESSION REGENERATE ERROR:", adminErr);
            return res.status(500).json({ error: "Server error" });
          }
          req.session.userId = user.id;
          req.session._ip = req.ip;
          req.session._ua = req.headers["user-agent"];
          req.session._lastActivity = Date.now();
          req.session._createdAt = Date.now();
          req.session._isAdmin = true;

          logSecurityEvent("admin_login", { userId: user.id, ip: req.ip, timestamp: new Date().toISOString() });

          res.json({
            message: "Login successful",
            redirect: redirect,
            user: {
              id: user.id,
              email: user.email,
            },
          });
        });
        return;
      }

      logSecurityEvent("login_success", { userId: user.id, ip: req.ip, timestamp: new Date().toISOString() });
      res.json({
        message: "Login successful",
        redirect: redirect,
        user: {
          id: user.id,
          email: user.email,
        },
      });
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /auth/signup
 * Body: { businessName, email, password, termsAccepted }
 */
router.post("/signup", async (req, res) => {
  try {
    const { businessName, email, password, termsAccepted } = req.body;

    if (!businessName || !email || !password) {
      return res.status(400).json({ error: "All fields are required" });
    }

    if (!termsAccepted) {
      return res.status(400).json({ error: "You must accept the Terms & Conditions" });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    if (typeof businessName !== "string" || businessName.trim().length < 1 || businessName.length > 200) {
      return res.status(400).json({ error: "Business name must be between 1 and 200 characters" });
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: "Password must be between 8 and 128 characters" });
    }

    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase().trim()]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "An account with this email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomUUID();

    const normalizedEmail = email.toLowerCase().trim();
    const userResult = await pool.query(
      `INSERT INTO users (email, password, email_verified, verification_token, subscription_status, terms_accepted, role)
       VALUES ($1, $2, false, $3, 'inactive', true, 'user')
       RETURNING id`,
      [normalizedEmail, hashedPassword, verificationToken]
    );

    const userId = userResult.rows[0].id;

    await pool.query(
      `INSERT INTO business_profiles (user_id, business_name) VALUES ($1, $2)`,
      [userId, businessName]
    );

    req.session.userId = userId;
    req.session._ip = req.ip;
    req.session._ua = req.headers["user-agent"];
    req.session._lastActivity = Date.now();
    req.session._createdAt = Date.now();

    console.log("Sending verification email to:", normalizedEmail);
    let emailSent = false;
    try {
      emailSent = await sendVerificationEmail(normalizedEmail, verificationToken);
    } catch (emailErr) {
      console.error("Verification email failed:", emailErr);
    }
    if (!emailSent) {
      console.warn("SIGNUP: Verification email was NOT delivered to:", normalizedEmail);
    }

    res.json({
      message: emailSent
        ? "Account created! Check your email to verify your address."
        : "Account created! We had trouble sending the verification email — please use the resend option on the verification page.",
      user: { id: userId, email: normalizedEmail },
      emailSent,
    });
  } catch (err) {
    console.error("SIGNUP ERROR:", err);
    res.status(500).json({ error: "Server error. Please try again." });
  }
});

/**
 * POST /auth/resend-verification
 */
router.post("/resend-verification", async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).json({ error: "Please log in first" });
    }

    const result = await pool.query(
      "SELECT email, email_verified, verification_token FROM users WHERE id = $1",
      [req.session.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = result.rows[0];

    if (user.email_verified) {
      return res.json({ message: "Email is already verified" });
    }

    let token = user.verification_token;
    if (!token) {
      token = crypto.randomUUID();
      await pool.query(
        "UPDATE users SET verification_token = $1 WHERE id = $2",
        [token, req.session.userId]
      );
    }

    const emailSent = await sendVerificationEmail(user.email, token);

    res.json({
      message: emailSent
        ? "Verification email sent! Check your inbox."
        : "We had trouble sending the email. Please check your email address and try again.",
      emailSent,
    });
  } catch (err) {
    console.error("RESEND ERROR:", err);
    res.status(500).json({ error: "Could not send email. Please try again." });
  }
});

module.exports = router;
