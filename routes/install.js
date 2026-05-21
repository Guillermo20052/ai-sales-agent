const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");
const requireBusinessOwner = require("../middleware/requireBusinessOwner");

const router = express.Router();

router.get("/", authMiddleware, requireBusinessOwner, async (req, res) => {
  try {
    const business = req.business;
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
    res.status(500).json({ error: "Unable to load install page." });
  }
});

module.exports = router;
