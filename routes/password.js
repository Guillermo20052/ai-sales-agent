const express = require("express");
const pool = require("../services/db");
const crypto = require("crypto");
const bcrypt = require("bcrypt");

const router = express.Router();

/**
 * =========================
 * GET /password/forgot
 * Show forgot password page
 * =========================
 */
router.get("/forgot", (req, res) => {
  res.sendFile(process.cwd() + "/views/forgot-password.html");
});

/**
 * =========================
 * GET /password/reset
 * Show reset password page
 * =========================
 */
router.get("/reset", async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.redirect("/login.html");
  }

  res.sendFile(process.cwd() + "/views/reset-password.html");
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

    if (!email) {
      return res.json({ success: true });
    }

    const userResult = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [email],
    );

    if (!userResult.rows.length) {
      return res.json({ success: true });
    }

    const userId = userResult.rows[0].id;

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 30); // 30 minutes

    await pool.query(
      `INSERT INTO password_resets (user_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, token, expiresAt],
    );

    const resetLink = `${process.env.BASE_URL}/password/reset?token=${token}`;

    console.log("RESET LINK:", resetLink);

    // Later you can send this by email
    res.json({ success: true });
  } catch (err) {
    console.error("FORGOT PASSWORD ERROR:", err);
    res.status(500).json({ error: "Server error" });
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
      return res.status(400).json({ error: "Invalid request" });
    }

    const result = await pool.query(
      `SELECT * FROM password_resets
       WHERE token = $1
       AND used = false
       AND expires_at > NOW()`,
      [token],
    );

    if (!result.rows.length) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    const resetRow = result.rows[0];

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query("UPDATE users SET password = $1 WHERE id = $2", [
      hashedPassword,
      resetRow.user_id,
    ]);

    await pool.query("UPDATE password_resets SET used = true WHERE id = $1", [
      resetRow.id,
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error("RESET PASSWORD ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
