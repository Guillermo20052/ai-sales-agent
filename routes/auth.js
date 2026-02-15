const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const pool = require("../services/db");
const { sendVerificationEmail } = require("../services/emailService");

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

    const result = await pool.query("SELECT * FROM users WHERE email = $1", [
      email,
    ]);

    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const user = result.rows[0];

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    req.session.userId = user.id;

    let redirect = "/dashboard";

    if (!user.email_verified) {
      redirect = "/verify-pending";
    } else if (user.subscription_status !== "active" && !user.is_paid) {
      redirect = "/checkout";
    }

    res.json({
      message: "Login successful",
      redirect: redirect,
      user: {
        id: user.id,
        email: user.email,
      },
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

    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "An account with this email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomUUID();

    const userResult = await pool.query(
      `INSERT INTO users (email, password, email_verified, verification_token, subscription_status, terms_accepted)
       VALUES ($1, $2, false, $3, 'inactive', true)
       RETURNING id`,
      [email, hashedPassword, verificationToken]
    );

    const userId = userResult.rows[0].id;

    await pool.query(
      `INSERT INTO business_profiles (user_id, business_name) VALUES ($1, $2)`,
      [userId, businessName]
    );

    req.session.userId = userId;

    await sendVerificationEmail(email, verificationToken);

    res.json({
      message: "Account created! Check your email to verify your address.",
      user: { id: userId, email: email },
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

    await sendVerificationEmail(user.email, token);

    res.json({ message: "Verification email sent! Check your inbox." });
  } catch (err) {
    console.error("RESEND ERROR:", err);
    res.status(500).json({ error: "Could not send email. Please try again." });
  }
});

module.exports = router;
