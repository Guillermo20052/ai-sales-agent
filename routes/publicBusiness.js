const express = require("express");
const pool = require("../services/db");
const { isPositiveInt } = require("../middleware/security");

const router = express.Router();

router.get("/:businessId", async (req, res) => {
  try {
    const { businessId } = req.params;
    if (!isPositiveInt(businessId)) {
      return res.status(400).send("Invalid business ID.");
    }

    const result = await pool.query(
      `SELECT bp.business_name, bp.ai_agent_name, u.is_paid, u.subscription_status
       FROM business_profiles bp
       JOIN users u ON bp.user_id = u.id
       WHERE bp.id = $1`,
      [businessId],
    );

    if (result.rows.length === 0) {
      return res.status(404).send("Business not found.");
    }

    const business = result.rows[0];
    const businessName = (business.business_name || "Our Team").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const accentColor = (business.accent_color || "#6366f1").replace(/[^#a-fA-F0-9]/g, "") || "#6366f1";

    const isActive =
      business.subscription_status === "active" || Boolean(business.is_paid);
    if (!isActive) {
      return res.status(403).send("This AI Sales Agent is currently inactive.");
    }

    const baseUrl = process.env.BASE_URL || "";

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${businessName} | Chat</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
        <style>
          * { box-sizing: border-box; }
          body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            margin: 0;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 40px 24px;
            background: #0a0a0b;
            color: #fafafa;
            -webkit-font-smoothing: antialiased;
          }
          .hero {
            text-align: center;
            max-width: 480px;
          }
          .hero h1 {
            font-size: 28px;
            font-weight: 700;
            color: #fafafa;
            margin: 0 0 8px 0;
            letter-spacing: -0.02em;
          }
          .hero p {
            font-size: 16px;
            color: #a1a1aa;
            margin: 0 0 24px 0;
            line-height: 1.5;
          }
          .hero .accent {
            color: ${accentColor};
          }
          .chat-hint {
            font-size: 14px;
            color: #71717a;
            margin-top: 16px;
          }
        </style>
      </head>
      <body>
        <div class="hero">
          <h1>${businessName}</h1>
          <p>Welcome! Chat with our AI assistant below.</p>
          <p class="chat-hint">Click the button to open the chat.</p>
        </div>
        <script>window.AI_AGENT_CONFIG = { businessName: ${JSON.stringify(business.business_name || "Our Team")}, accentColor: ${JSON.stringify(accentColor)}, agentName: ${JSON.stringify((business.ai_agent_name && String(business.ai_agent_name).trim()) || "Aira")} };</script>
        <script src="${baseUrl}/widget.js" data-business="${businessId}"></script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("PUBLIC PAGE ERROR:", err);
    res.status(500).send("Server error.");
  }
});

module.exports = router;
