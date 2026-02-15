const express = require("express");
const pool = require("../services/db");

const router = express.Router();

router.get("/:businessId", async (req, res) => {
  try {
    const { businessId } = req.params;

    const result = await pool.query(
      `SELECT bp.business_name, u.is_paid
       FROM business_profiles bp
       JOIN users u ON bp.user_id = u.id
       WHERE bp.id = $1`,
      [businessId],
    );

    if (result.rows.length === 0) {
      return res.status(404).send("Business not found.");
    }

    const business = result.rows[0];

    if (!business.is_paid) {
      return res.status(403).send("This AI Sales Agent is currently inactive.");
    }

    const baseUrl = process.env.BASE_URL;

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>${business.business_name} | AI Sales Agent</title>
        <meta charset="UTF-8" />
        <style>
          body {
            font-family: Arial, sans-serif;
            text-align: center;
            padding: 60px;
          }
          h1 {
            font-size: 32px;
          }
          p {
            font-size: 18px;
            color: #555;
          }
        </style>
      </head>
      <body>
        <h1>${business.business_name}</h1>
        <p>Welcome! Chat with our AI Sales Agent below 👇</p>

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
