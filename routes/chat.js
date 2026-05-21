const express = require("express");
const pool = require("../services/db");
const authMiddleware = require("../middleware/authMiddleware");
const usageLimit = require("../middleware/usageLimit");
const { generateSalesReply } = require("../services/aiService");
const {
  checkReplaySpam,
  AI_MESSAGE_MAX_LENGTH,
  logSecurityEvent,
  MAX_EMAIL_LENGTH,
  MAX_PHONE_LENGTH,
  MAX_LEAD_MESSAGE_LENGTH,
} = require("../middleware/security");
const {
  isPromptInjection,
  isResponseLeakingSecrets,
  SAFE_REFUSAL_MESSAGE,
  SAFE_FALLBACK_MESSAGE,
} = require("../services/aiSecurity");
const redis = require("../services/redis");

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
 * Requires login + usage control (freemium model).
 * Dashboard chat uses same schema as public agent: conversations (business_id, visitor_id) + messages (conversation_id, sender, content).
 * Tenant-scoped via business_id; visitor_id = "dashboard:{userId}" for this channel.
 */
router.post("/", authMiddleware, usageLimit, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { message } = req.body;

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return res.status(400).json({ error: "Message required" });
    }
    if (message.length > AI_MESSAGE_MAX_LENGTH) {
      return res.status(400).json({ error: "Message too long" });
    }
    if (checkReplaySpam(`chat:${userId}`, message)) {
      logSecurityEvent("ai_abuse_attempt", { type: "spam", userId, promptPreview: String(message || "").replace(/\s+/g, " ").trim().slice(0, 200), timestamp: new Date().toISOString() });
      return res.status(429).json({ error: "Too many requests" });
    }
    if (isPromptInjection(message)) {
      logSecurityEvent("blocked_prompt_injection", { userId, ip: req.ip, promptPreview: String(message || "").replace(/\s+/g, " ").trim().slice(0, 200), timestamp: new Date().toISOString() });
      logSecurityEvent("ai_abuse_attempt", { type: "prompt_injection", userId, timestamp: new Date().toISOString() });
      return res.json({ reply: SAFE_REFUSAL_MESSAGE, leadCaptured: false });
    }

    // Get business profile (tenant boundary)
    const result = await pool.query(
      "SELECT * FROM business_profiles WHERE user_id = $1",
      [userId],
    );

    const businessProfile = result.rows[0];

    if (!businessProfile) {
      return res.status(400).json({ error: "No business profile found" });
    }

    const businessId = businessProfile.id;
    const visitorId = `dashboard:${userId}`;

    const AI_HOURLY_LIMIT_PER_USER = Number(process.env.AI_HOURLY_LIMIT_PER_USER || 50);
    if (redis.REDIS_URL) {
      const userAiCount = await redis.incrementAiUsageUser(userId);
      if (userAiCount > AI_HOURLY_LIMIT_PER_USER) {
        logSecurityEvent("ai_abuse_attempt", { type: "hourly_limit", userId, count: userAiCount, limit: AI_HOURLY_LIMIT_PER_USER, timestamp: new Date().toISOString() });
        return res.status(429).json({ error: "Too many requests. Please try again later." });
      }
    }

    // Ensure a conversation exists (tenant-scoped: business_id + visitor_id)
    let convResult = await pool.query(
      "SELECT id FROM conversations WHERE business_id = $1 AND visitor_id = $2 LIMIT 1",
      [businessId, visitorId],
    );
    let convId;
    if (convResult.rows.length > 0) {
      convId = convResult.rows[0].id;
    } else {
      const insertConv = await pool.query(
        "INSERT INTO conversations (business_id, visitor_id) VALUES ($1, $2) RETURNING id",
        [businessId, visitorId],
      );
      convId = insertConv.rows[0].id;
    }

    // Fetch last 20 messages for this conversation (sender: "user" | "ai" or "assistant")
    const historyResult = await pool.query(
      `SELECT sender, content
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC
       LIMIT 20`,
      [convId],
    );
    const conversationHistory = (historyResult.rows || []).map((m) => ({
      role: m.sender === "user" ? "user" : "assistant",
      content: m.content,
    }));

    // Detect intent
    const isLeadIntent = detectHighIntent(message);

    // Extract email if user provided one
    const extractedEmail = extractEmail(message);

    // Generate AI reply with memory
    let aiReply;
    try {
      aiReply = await generateSalesReply(
        businessProfile,
        message,
        businessProfile, // using profile as knowledge object (safe fallback)
        conversationHistory,
      );
    } catch (_) {
      aiReply = SAFE_FALLBACK_MESSAGE;
    }
    if (isResponseLeakingSecrets(String(aiReply || ""))) {
      logSecurityEvent("ai_abuse_attempt", { type: "sensitive_data_request", userId, timestamp: new Date().toISOString() });
      aiReply = SAFE_FALLBACK_MESSAGE;
    }

    // Save user message
    await pool.query(
      "INSERT INTO messages (conversation_id, sender, content) VALUES ($1, 'user', $2)",
      [convId, message],
    );

    // Save assistant reply
    await pool.query(
      "INSERT INTO messages (conversation_id, sender, content) VALUES ($1, 'assistant', $2)",
      [convId, aiReply],
    );

    const extractedPhone = (message.match(/(?:\+?\d[\d\s\-()]{7,}\d)/) || [])[0] || null;
    const safeEmail = extractedEmail ? String(extractedEmail).trim().slice(0, MAX_EMAIL_LENGTH) : null;
    const safePhone = extractedPhone ? String(extractedPhone).trim().slice(0, MAX_PHONE_LENGTH) : null;
    const safeLeadMessage = String(message || "").slice(0, MAX_LEAD_MESSAGE_LENGTH);

    if (isLeadIntent || safeEmail) {
      if (safeEmail) {
        const existingLead = await pool.query(
          `SELECT id FROM leads WHERE user_id = $1 AND email = $2 LIMIT 1`,
          [userId, safeEmail],
        );

        if (existingLead.rows.length === 0) {
          await pool.query(
            `INSERT INTO leads (user_id, business_id, conversation_id, email, phone, message, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'new')
             ON CONFLICT (business_id, conversation_id, email) DO NOTHING`,
            [userId, businessProfile.id, convId, safeEmail, safePhone, safeLeadMessage],
          );
        }
      } else {
        await pool.query(
          `INSERT INTO leads (user_id, business_id, conversation_id, email, phone, message, status)
           VALUES ($1, $2, $3, NULL, $4, $5, 'new')
           ON CONFLICT (business_id, conversation_id, email) DO NOTHING`,
          [userId, businessProfile.id, convId, safePhone, safeLeadMessage],
        );
      }
    }

    res.json({
      reply: aiReply,
      leadCaptured: isLeadIntent,
    });
  } catch (err) {
    console.error("CHAT ERROR:", err);
    res.status(500).json({ error: "Database operation failed" });
  }
});

module.exports = router;
