const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");
const pool = require("../services/db");

const router = express.Router();

router.get("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.session.userId;

    const result = await pool.query(
      "SELECT id, business_name FROM business_profiles WHERE user_id = $1",
      [userId],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: "No business profile found." });
    }

    const business = result.rows[0];

    const baseUrl = process.env.BASE_URL;

    const embedCode = `<script src="${baseUrl}/widget.js" data-business="${business.id}"></script>`;

    const hostedPage = `${baseUrl}/b/${business.id}`;

    res.json({
      businessId: business.id,
      businessName: business.business_name,
      embedCode,
      hostedPage,
    });
  } catch (err) {
    console.error("INSTALL ROUTE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
