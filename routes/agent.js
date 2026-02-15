const express = require("express");
const pool = require("../services/db");
const { generateSalesReply } = require("../services/openaiService");

const router = express.Router();

/**
 * POST /agent/:businessId
 * Public AI agent route (no auth)
 */
router.post("/:businessId", async (req, res) => {
  try {
    const { businessId } = req.params;
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message required" });
    }

    // Load business profile
    const result = await pool.query(
      `SELECT bp.*, u.is_paid
       FROM business_profiles bp
       JOIN users u ON bp.user_id = u.id
       WHERE bp.id = $1`,
      [businessId],
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Business not found" });
    }

    const businessProfile = result.rows[0];

    // If business subscription inactive
    if (!businessProfile.is_paid) {
      return res.status(403).json({
        error: "Agent inactive. Please contact the business owner.",
      });
    }

    // AI buying intent detection
    const intentCheckResponse = await generateSalesReply(
      businessProfile,
      `Respond ONLY with "YES" or "NO".
Does this message show strong buying intent?
Message: "${message}"`,
    );

    const isLeadIntent = intentCheckResponse.toLowerCase().includes("yes");

    // Generate AI reply
    const aiReply = await generateSalesReply(businessProfile, message);

    // Save lead
    if (isLeadIntent) {
      await pool.query(
        `INSERT INTO leads (user_id, message)
         VALUES ($1, $2)`,
        [businessProfile.user_id, message],
      );

      console.log("🚀 Lead captured for business:", businessId);
    }

    res.json({
      reply: aiReply,
    });
  } catch (err) {
    console.error("PUBLIC AGENT ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
