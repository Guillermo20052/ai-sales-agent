const express = require("express");
const pool = require("../services/db");
const authMiddleware = require("../middleware/authMiddleware");
const usageLimit = require("../middleware/usageLimit");
const { generateSalesReply } = require("../services/openaiService");

const router = express.Router();

/**
 * Lightweight backend intent detection (fast + scalable)
 */
function detectHighIntent(message) {
  const lower = message.toLowerCase();

  return (
    lower.includes("price") ||
    lower.includes("cost") ||
    lower.includes("book") ||
    lower.includes("appointment") ||
    lower.includes("buy") ||
    lower.includes("sign up") ||
    lower.includes("how much") ||
    lower.includes("get started") ||
    lower.includes("quote") ||
    lower.includes("available") ||
    lower.includes("schedule")
  );
}

function extractEmail(text) {
  if (!text) return null;

  const match = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);

  return match ? match[0].toLowerCase() : null;
}

/**
 * POST /chat
 * Requires login + usage control (freemium model)
 */
router.post("/", authMiddleware, usageLimit, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message required" });
    }

    // Get business profile
    const result = await pool.query(
      "SELECT * FROM business_profiles WHERE user_id = $1",
      [userId],
    );

    const businessProfile = result.rows[0];

    if (!businessProfile) {
      return res.status(400).json({ error: "No business profile found" });
    }

    // 🔹 Fetch last 6 conversation messages for memory
    const historyResult = await pool.query(
      `SELECT role, content
       FROM conversations
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 6`,
      [userId],
    );

    const conversationHistory = historyResult.rows.reverse();

    // Detect intent
    const isLeadIntent = detectHighIntent(message);

    // Extract email if user provided one
    const extractedEmail = extractEmail(message);

    // 🔹 Generate AI reply with memory
    const aiReply = await generateSalesReply(
      businessProfile,
      message,
      businessProfile, // using profile as knowledge object (safe fallback)
      conversationHistory,
    );

    // 🔹 Save user message
    await pool.query(
      `INSERT INTO conversations (user_id, role, content)
       VALUES ($1, 'user', $2)`,
      [userId, message],
    );

    // 🔹 Save assistant reply
    await pool.query(
      `INSERT INTO conversations (user_id, role, content)
       VALUES ($1, 'assistant', $2)`,
      [userId, aiReply],
    );

    
    if (isLeadIntent || extractedEmail) {
      // Prevent duplicate leads with same email
      if (extractedEmail) {
        const existingLead = await pool.query(
          `SELECT id FROM leads WHERE user_id = $1 AND email = $2 LIMIT 1`,
          [userId, extractedEmail],
        );

        if (existingLead.rows.length === 0) {
          await pool.query(
            `INSERT INTO leads (user_id, message, email)
             VALUES ($1, $2, $3)`,
            [userId, message, extractedEmail],
          );

          console.log("📩 Email lead captured:", extractedEmail);
        }
      } else {
        await pool.query(
          `INSERT INTO leads (user_id, message)
           VALUES ($1, $2)`,
          [userId, message],
        );

        console.log("🚀 Intent lead captured");
      }
    }

    res.json({
      reply: aiReply,
      leadCaptured: isLeadIntent,
    });
  } catch (err) {
    console.error("CHAT ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
