const express = require("express");
const pool = require("../services/db");
const authMiddleware = require("../middleware/authMiddleware");
const { createCheckoutSession } = require("../services/stripeService");
const fs = require("fs");

const router = express.Router();

/**
 * =========================
 * GET /dashboard (Main dashboard page)
 * =========================
 */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.session.userId;

    const userResult = await pool.query(
      "SELECT is_paid, email_verified, subscription_status FROM users WHERE id = $1",
      [userId],
    );

    if (!userResult.rows.length) {
      return res.redirect("/login.html");
    }

    const user = userResult.rows[0];

    if (!user.email_verified) {
      return res.redirect("/verify-pending");
    }

    if (user.subscription_status !== "active" && !user.is_paid) {
      return res.redirect("/checkout");
    }

    const isPaid = user.is_paid;

    const result = await pool.query(
      "SELECT * FROM business_profiles WHERE user_id = $1",
      [userId],
    );

    const business = result.rows[0];

    if (!business) {
      return res.status(400).send("No business profile found.");
    }

    const baseUrl = process.env.BASE_URL || "";
    const hostedLink = `${baseUrl}/b/${business.id}`;
    const embedCode = `&lt;script src="${baseUrl}/widget.js" data-business="${business.id}"&gt;&lt;/script&gt;`;

    let html = fs.readFileSync("./views/dashboard.html", "utf8");

    html = html
      .replace("{{businessName}}", business.business_name)
      .replace(
        "{{statusText}}",
        isPaid ? "Active Subscription" : "Subscription Inactive",
      )
      .replace("{{statusClass}}", isPaid ? "active" : "inactive")
      .replace("{{hostedLink}}", hostedLink)
      .replace("{{embedCode}}", embedCode)
      .replace(
        "{{upgradeButton}}",
        isPaid
          ? ""
          : `<div class="upgrade-banner">
               <div>
                 <h3>Unlock Unlimited Access</h3>
                 <p>Remove message limits and get priority support with a Pro subscription.</p>
               </div>
               <button class="btn-upgrade" onclick="window.location='/dashboard/checkout'">
                 Upgrade Now
               </button>
             </div>`,
      )
      .replace(
        "{{agentSection}}",
        isPaid
          ? `<div class="agent-live-section">
               <div class="card">
                 <div class="card-head">
                   <h2>Your AI Agent</h2>
                   <div class="live-badge"><span class="live-dot"></span>LIVE</div>
                 </div>
                 <div class="agent-content">
                   <div class="agent-row">
                     <div class="agent-field">
                       <div class="agent-label">Hosted AI Agent Link</div>
                       <div class="agent-value" id="hostedLink">${hostedLink}</div>
                     </div>
                     <button class="btn-copy" onclick="copyText('hostedLink','Link copied!')">Copy</button>
                   </div>
                   <div class="agent-row">
                     <div class="agent-field">
                       <div class="agent-label">Embed Code</div>
                       <div class="agent-value mono" id="embedCode">${embedCode}</div>
                     </div>
                     <button class="btn-copy" onclick="copyText('embedCode','Code copied!')">Copy</button>
                   </div>
                   <div class="platform-guides">
                     <div class="agent-label" style="margin-bottom:12px">Quick Install Guides</div>
                     <div class="guide-grid">
                       <div class="guide-item"><span>&#127979;</span> <strong>Shopify</strong> — Themes &rarr; Edit Code &rarr; Paste before &lt;/body&gt;</div>
                       <div class="guide-item"><span>&#127760;</span> <strong>WordPress</strong> — Appearance &rarr; Theme Editor &rarr; footer.php</div>
                       <div class="guide-item"><span>&#9734;</span> <strong>Wix</strong> — Settings &rarr; Custom Code &rarr; Add Script</div>
                       <div class="guide-item"><span>&#9670;</span> <strong>Webflow</strong> — Site Settings &rarr; Custom Code &rarr; Footer</div>
                       <div class="guide-item"><span>&#128247;</span> <strong>Instagram</strong> — Paste hosted link in your bio</div>
                       <div class="guide-item"><span>&#128205;</span> <strong>Google Business</strong> — Add hosted link to your website field</div>
                     </div>
                   </div>
                 </div>
               </div>
             </div>`
          : "",
      );

    res.send(html);
  } catch (err) {
    console.error("DASHBOARD ERROR:", err);
    res.status(500).send("Server error.");
  }
});

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

    const userResult = await pool.query(
      "SELECT is_paid, email_verified, subscription_status FROM users WHERE id = $1",
      [userId],
    );

    if (!userResult.rows.length) {
      return res.redirect("/login.html");
    }

    const user = userResult.rows[0];

    if (!user.email_verified) {
      return res.redirect("/verify-pending");
    }

    if (user.subscription_status !== "active" && !user.is_paid) {
      return res.redirect("/checkout");
    }

    const isPaid = user.is_paid;

    const result = await pool.query(
      "SELECT * FROM business_profiles WHERE user_id = $1",
      [userId],
    );

    const business = result.rows[0];

    if (!business) {
      return res.status(400).send("No business profile found.");
    }

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
