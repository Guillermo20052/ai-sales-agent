const express = require("express");
const pool = require("../services/db");
const { generateSalesReply } = require("../services/openaiService");

const router = express.Router();

router.post("/:businessId", async (req, res) => {
  try {
    const { businessId } = req.params;
    const { message, conversationId, visitorId } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message required" });
    }

    const result = await pool.query(
      `SELECT bp.*, u.is_paid, u.subscription_status
       FROM business_profiles bp
       JOIN users u ON bp.user_id = u.id
       WHERE bp.id = $1`,
      [businessId],
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Business not found" });
    }

    const businessProfile = result.rows[0];

    if (businessProfile.subscription_status !== "active") {
      return res.status(403).json({
        error: "Agent inactive. Please contact the business owner.",
      });
    }

    const knowledgeResult = await pool.query(
      "SELECT * FROM business_knowledge WHERE user_id = $1",
      [businessProfile.user_id],
    );
    const knowledge = knowledgeResult.rows[0] || null;

    let convId = conversationId;
    if (!convId) {
      const convResult = await pool.query(
        "INSERT INTO conversations (business_id, visitor_id) VALUES ($1, $2) RETURNING id",
        [businessId, visitorId || null],
      );
      convId = convResult.rows[0].id;
    }

    await pool.query(
      "INSERT INTO messages (conversation_id, sender, content) VALUES ($1, 'user', $2)",
      [convId, message],
    );

    const intentCheckResponse = await generateSalesReply(
      businessProfile,
      `Respond ONLY with "YES" or "NO".
Does this message show strong buying intent?
Message: "${message}"`,
      knowledge,
    );

    const isLeadIntent = intentCheckResponse.toLowerCase().includes("yes");

    const aiReply = await generateSalesReply(businessProfile, message, knowledge);

    await pool.query(
      "INSERT INTO messages (conversation_id, sender, content) VALUES ($1, 'ai', $2)",
      [convId, aiReply],
    );

    if (isLeadIntent) {
      await pool.query(
        "INSERT INTO leads (user_id, message) VALUES ($1, $2)",
        [businessProfile.user_id, message],
      );
    }

    res.json({
      reply: aiReply,
      conversationId: convId,
    });
  } catch (err) {
    console.error("PUBLIC AGENT ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
