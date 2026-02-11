const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../services/db");

const router = express.Router();

console.log("Auth router initialized");

/**
 * POST /auth/register
 * Body: { email, password }
 */
router.post("/register", async (req, res) => {
  console.log("POST /auth/register called with:", req.body);
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert user into DB
    const result = await pool.query(
      "INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email, created_at",
      [email, hashedPassword],
    );

    res.status(201).json({
      message: "User created successfully",
      user: result.rows[0],
    });
  } catch (err) {
    console.error(err);

    if (err.code === "23505") {
      return res.status(400).json({ error: "Email already exists" });
    }

    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
