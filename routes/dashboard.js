const express = require("express");
const pool = require("../services/db");
const authMiddleware = require("../middleware/authMiddleware");
const { createCheckoutSession } = require("../services/stripeService");
const fs = require("fs");

const router = express.Router();

/**
 * =========================
 * GET /dashboard/leads
 * =========================
 */
router.get("/leads", authMiddleware, async (req, res) => {
  try {
    const userId = req.session.userId;

    const result = await pool.query(
      "SELECT * FROM leads WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    );

    res.json({
      totalLeads: result.rows.length,
      leads: result.rows,
    });
  } catch (err) {
    console.error("LEADS ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * =========================
 * POST /dashboard/checkout
 * =========================
 */
router.post("/checkout", authMiddleware, async (req, res) => {
  try {
    const userId = req.session.userId;

    const checkoutUrl = await createCheckoutSession(userId);

    res.json({ url: checkoutUrl });
  } catch (err) {
    console.error("CHECKOUT ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * =========================
 * GET /dashboard/install
 * =========================
 */
router.get("/install", authMiddleware, async (req, res) => {
  try {
    const userId = req.session.userId;

    // Get business profile
    const result = await pool.query(
      "SELECT * FROM business_profiles WHERE user_id = $1",
      [userId],
    );

    const business = result.rows[0];

    if (!business) {
      return res.status(400).send("No business profile found.");
    }

    // Get subscription status
    const userResult = await pool.query(
      "SELECT is_paid FROM users WHERE id = $1",
      [userId],
    );

    const isPaid = userResult.rows[0]?.is_paid;

    const baseUrl = process.env.BASE_URL;

    let html = fs.readFileSync("./views/install.html", "utf8");

    html = html
      .replace("{{businessName}}", business.business_name)
      .replace("{{hostedPage}}", `${baseUrl}/b/${business.id}`)
      .replace(
        "{{embedCode}}",
        `<script src="${baseUrl}/widget.js" data-business="${business.id}"></script>`,
      )
      .replace(
        "{{statusText}}",
        isPaid ? "Active Subscription" : "Subscription Inactive",
      )
      .replace("{{statusClass}}", isPaid ? "active" : "inactive")
      .replace(
        "{{upgradeButton}}",
        isPaid
          ? ""
          : `<div class="upgrade-card">
               <div class="upgrade-info">
                 <h3>Unlock Unlimited Access</h3>
                 <p>Remove message limits and get priority support with a Pro subscription.</p>
               </div>
               <button class="btn-upgrade" onclick="window.location='/dashboard/checkout'">
                 Upgrade Now
               </button>
             </div>`,
      );

    res.send(html);
  } catch (err) {
    console.error("INSTALL ERROR:", err);
    res.status(500).send("Server error.");
  }
});

module.exports = router;
