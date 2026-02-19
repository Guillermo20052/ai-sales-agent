const express = require("express");
const pool = require("../services/db");
const authMiddleware = require("../middleware/authMiddleware");
const { createCheckoutSession } = require("../services/stripeService");
const fs = require("fs");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
      "SELECT is_paid, email_verified, subscription_status, role FROM users WHERE id = $1",
      [userId],
    );

    if (!userResult.rows.length) {
      return res.redirect("/login.html");
    }

    const user = userResult.rows[0];
    const isAdmin = user.role === "admin";

    const isActive =
      user.role === "admin" || user.subscription_status === "active";

    if (user.role !== "admin") {
      if (!user.email_verified) {
        return res.redirect("/verify-pending");
      }

      if (!isActive) {
        return res.redirect("/checkout");
      }
    }

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
        isActive ? "Active Subscription" : "Subscription Inactive",
      )
      .replace("{{statusClass}}", isActive ? "active" : "inactive")
      .replace("{{hostedLink}}", hostedLink)
      .replace("{{embedCode}}", embedCode)
      .replace(
        "{{upgradeButton}}",
        isActive
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
        isActive
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
      )
      .replace(
        "{{refundSection}}",
        isActive
          ? `<div class="refund-section">
               <div class="refund-card">
                 <div class="refund-info">
                   <h3>Subscription Management</h3>
                   <p>Refunds are available within 7 days of subscription start. After that, your subscription continues until the end of the billing period.</p>
                 </div>
                 <button class="btn-refund" onclick="openRefundModal()">Request Refund</button>
               </div>
             </div>`
          : "",
      )
      .replace(
        "{{adminButton}}",
        isAdmin
          ? `<a href="/internal-admin-portal-93847" class="topbar-nav-link">Admin</a>`
          : "",
      );

    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
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
      "SELECT is_paid, email_verified, subscription_status, role FROM users WHERE id = $1",
      [userId],
    );

    if (!userResult.rows.length) {
      return res.redirect("/login.html");
    }

    const user = userResult.rows[0];

    const isActive =
      user.role === "admin" || user.subscription_status === "active";

    if (user.role !== "admin") {
      if (!user.email_verified) {
        return res.redirect("/verify-pending");
      }

      if (!isActive) {
        return res.redirect("/checkout");
      }
    }

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
        isActive ? "Active Subscription" : "Subscription Inactive",
      )
      .replace("{{statusClass}}", isActive ? "active" : "inactive")
      .replace(
        "{{upgradeButton}}",
        isActive
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

/**
 * =========================
 * GET /dashboard/training
 * =========================
 */
router.get("/training", authMiddleware, async (req, res) => {
  try {
    const userId = req.session.userId;

    const userResult = await pool.query(
      "SELECT email_verified, subscription_status, role FROM users WHERE id = $1",
      [userId],
    );

    if (!userResult.rows.length) return res.redirect("/login.html");
    const user = userResult.rows[0];
    if (user.role !== "admin") {
      if (!user.email_verified) return res.redirect("/verify-pending");
      if (user.subscription_status !== "active")
        return res.redirect("/checkout");
    }

    const knowledgeResult = await pool.query(
      "SELECT * FROM business_knowledge WHERE user_id = $1",
      [userId],
    );

    const k = knowledgeResult.rows[0] || {};
    const isTrained = !!(k.description || k.services || k.pricing || k.faqs);

    const statusText =
      user.subscription_status === "active"
        ? "Active Subscription"
        : "Subscription Inactive";
    const statusClass =
      user.subscription_status === "active" ? "active" : "inactive";

    let lastUpdatedText = "";
    if (k.updated_at) {
      const d = new Date(k.updated_at);
      lastUpdatedText =
        "Last updated: " +
        d.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
    }

    let html = fs.readFileSync("./views/training.html", "utf8");

    html = html
      .replace(/\{\{statusText\}\}/g, statusText)
      .replace(/\{\{statusClass\}\}/g, statusClass)
      .replace("{{description}}", escapeHtml(k.description || ""))
      .replace("{{services}}", escapeHtml(k.services || ""))
      .replace("{{pricing}}", escapeHtml(k.pricing || ""))
      .replace("{{faqs}}", escapeHtml(k.faqs || ""))
      .replace("{{restrictions}}", escapeHtml(k.restrictions || ""))
      .replace("{{website_url}}", escapeHtml(k.website_url || ""))
      .replace("{{instagram_url}}", escapeHtml(k.instagram_url || ""))
      .replace("{{facebook_url}}", escapeHtml(k.facebook_url || ""))
      .replace("{{currentTone}}", k.tone || "Professional")
      .replace("{{lastUpdated}}", lastUpdatedText)
      .replace("{{knowledgeIcon}}", isTrained ? "&#129302;" : "&#9888;")
      .replace("{{knowledgeIconClass}}", isTrained ? "trained" : "untrained")
      .replace(
        "{{knowledgeStatusText}}",
        isTrained
          ? "Your AI agent is trained with your business data"
          : "No training data yet. Fill in your business details below.",
      )
      .replace("{{knowledgeBadgeClass}}", isTrained ? "trained" : "untrained")
      .replace("{{knowledgeBadgeText}}", isTrained ? "TRAINED" : "NOT TRAINED");

    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(html);
  } catch (err) {
    console.error("TRAINING PAGE ERROR:", err);
    res.status(500).send("Server error.");
  }
});

/**
 * =========================
 * POST /dashboard/training
 * =========================
 */
router.post("/training", authMiddleware, async (req, res) => {
  try {
    const userId = req.session.userId;
    const {
      description,
      services,
      pricing,
      faqs,
      tone,
      website_url,
      instagram_url,
      facebook_url,
      restrictions,
    } = req.body;

    const existing = await pool.query(
      "SELECT id FROM business_knowledge WHERE user_id = $1",
      [userId],
    );

    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE business_knowledge SET
          description = $1, services = $2, pricing = $3, faqs = $4,
          tone = $5, website_url = $6, instagram_url = $7, facebook_url = $8,
          restrictions = $9, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $10`,
        [
          description,
          services,
          pricing,
          faqs,
          tone,
          website_url,
          instagram_url,
          facebook_url,
          restrictions,
          userId,
        ],
      );
    } else {
      await pool.query(
        `INSERT INTO business_knowledge (user_id, description, services, pricing, faqs, tone, website_url, instagram_url, facebook_url, restrictions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          userId,
          description,
          services,
          pricing,
          faqs,
          tone,
          website_url,
          instagram_url,
          facebook_url,
          restrictions,
        ],
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error("TRAINING SAVE ERROR:", err);
    res.status(500).json({ error: "Failed to save training data" });
  }
});

/**
 * =========================
 * POST /dashboard/scrape
 * =========================
 */
router.post("/scrape", authMiddleware, async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "URL is required" });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      return res.status(400).json({ error: "Invalid URL format" });
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return res
        .status(400)
        .json({ error: "Only HTTP/HTTPS URLs are allowed" });
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("172.")
    ) {
      return res.status(400).json({ error: "Internal URLs are not allowed" });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "AI-Sales-Agent-Bot/1.0" },
      follow: 3,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(400).json({
        error: "Could not fetch website (status " + response.status + ")",
      });
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      return res
        .status(400)
        .json({ error: "URL does not point to an HTML page" });
    }

    const html = await response.text();

    const $ = cheerio.load(html);
    $("script, style, noscript, nav, footer, header, iframe, svg").remove();

    let text = $("body").text();
    text = text.replace(/\s+/g, " ").trim();

    if (text.length > 5000) {
      text = text.substring(0, 5000);
    }

    if (!text || text.length < 20) {
      return res
        .status(400)
        .json({ error: "Could not extract meaningful content from website" });
    }

    res.json({ success: true, content: text });
  } catch (err) {
    if (err.name === "AbortError") {
      return res
        .status(400)
        .json({ error: "Website took too long to respond" });
    }
    console.error("SCRAPE ERROR:", err);
    res.status(500).json({ error: "Failed to scrape website" });
  }
});

/**
 * =========================
 * GET /dashboard/conversations
 * =========================
 */
router.get("/conversations", authMiddleware, async (req, res) => {
  try {
    const userId = req.session.userId;

    const userResult = await pool.query(
      "SELECT email_verified, subscription_status, role FROM users WHERE id = $1",
      [userId],
    );
    if (!userResult.rows.length) return res.redirect("/login.html");
    const user = userResult.rows[0];
    if (user.role !== "admin") {
      if (!user.email_verified) return res.redirect("/verify-pending");
      if (user.subscription_status !== "active")
        return res.redirect("/checkout");
    }

    const bpResult = await pool.query(
      "SELECT id, business_name FROM business_profiles WHERE user_id = $1",
      [userId],
    );
    const business = bpResult.rows[0];
    if (!business) return res.status(400).send("No business profile found.");

    const statusText =
      user.subscription_status === "active"
        ? "Active Subscription"
        : "Subscription Inactive";
    const statusClass =
      user.subscription_status === "active" ? "active" : "inactive";

    const convResult = await pool.query(
      `SELECT c.id, c.visitor_id, c.created_at,
        (SELECT content FROM messages WHERE conversation_id = c.id AND sender = 'user' ORDER BY created_at ASC LIMIT 1) AS first_message,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS message_count
       FROM conversations c
       WHERE c.business_id = $1
       ORDER BY c.created_at DESC
       LIMIT 10`,
      [business.id],
    );

    let html = fs.readFileSync("./views/conversations.html", "utf8");
    html = html
      .replace(/\{\{statusText\}\}/g, statusText)
      .replace(/\{\{statusClass\}\}/g, statusClass)
      .replace("{{businessName}}", business.business_name)
      .replace("{{conversationsJson}}", JSON.stringify(convResult.rows));

    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(html);
  } catch (err) {
    console.error("CONVERSATIONS PAGE ERROR:", err);
    res.status(500).send("Server error.");
  }
});

/**
 * =========================
 * GET /dashboard/conversations/:id
 * =========================
 */
router.get("/conversations/:id", authMiddleware, async (req, res) => {
  try {
    const userId = req.session.userId;
    const convId = req.params.id;

    const bpResult = await pool.query(
      "SELECT id FROM business_profiles WHERE user_id = $1",
      [userId],
    );
    if (!bpResult.rows.length)
      return res.status(403).json({ error: "Forbidden" });

    const conv = await pool.query(
      "SELECT * FROM conversations WHERE id = $1 AND business_id = $2",
      [convId, bpResult.rows[0].id],
    );
    if (!conv.rows.length)
      return res.status(404).json({ error: "Conversation not found" });

    const msgs = await pool.query(
      "SELECT sender, content, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC",
      [convId],
    );

    res.json({ conversation: conv.rows[0], messages: msgs.rows });
  } catch (err) {
    console.error("CONVERSATION DETAIL ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * =========================
 * POST /dashboard/refund
 * =========================
 */
router.post("/refund", authMiddleware, async (req, res) => {
  try {
    const userId = req.session.userId;

    const existingRefund = await pool.query(
      "SELECT id FROM refunds WHERE user_id = $1",
      [userId],
    );
    if (existingRefund.rows.length > 0) {
      return res.status(400).json({
        error: "A refund has already been processed for this account.",
      });
    }

    const userResult = await pool.query(
      "SELECT subscription_status, role FROM users WHERE id = $1",
      [userId],
    );
    if (!userResult.rows.length) {
      return res.status(400).json({ error: "User not found." });
    }
    if (
      userResult.rows[0].role !== "admin" &&
      userResult.rows[0].subscription_status !== "active"
    ) {
      return res.status(400).json({ error: "No active subscription found." });
    }

    let subscription;
    try {
      const searchResult = await stripe.subscriptions.search({
        query: `metadata['userId']:'${userId}'`,
        limit: 1,
      });

      if (!searchResult.data.length) {
        return res.status(400).json({
          error:
            "Could not find your Stripe subscription. Please contact support.",
        });
      }

      subscription = searchResult.data[0];
    } catch (searchErr) {
      console.error(
        "REFUND: Stripe subscription search error:",
        searchErr.message,
      );
      return res.status(500).json({
        error: "Could not verify subscription with payment provider.",
      });
    }

    const subStartDate = new Date(subscription.start_date * 1000);
    const now = new Date();
    const daysSinceStart = (now - subStartDate) / (1000 * 60 * 60 * 24);

    if (daysSinceStart > 7) {
      const startFormatted = subStartDate.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      return res.status(400).json({
        error: `Refund window has expired. Your subscription started on ${startFormatted}, and refunds are only available within 7 days of starting.`,
      });
    }

    let latestInvoice;
    try {
      if (typeof subscription.latest_invoice === "string") {
        latestInvoice = await stripe.invoices.retrieve(
          subscription.latest_invoice,
        );
      } else {
        latestInvoice = subscription.latest_invoice;
      }

      if (!latestInvoice || !latestInvoice.payment_intent) {
        return res.status(400).json({
          error:
            "Could not find the payment to refund. Please contact support.",
        });
      }
    } catch (invErr) {
      console.error("REFUND: Invoice retrieval error:", invErr.message);
      return res
        .status(500)
        .json({ error: "Could not retrieve payment details." });
    }

    let refund;
    try {
      refund = await stripe.refunds.create({
        payment_intent:
          typeof latestInvoice.payment_intent === "string"
            ? latestInvoice.payment_intent
            : latestInvoice.payment_intent.id,
        reason: "requested_by_customer",
      });
    } catch (refundErr) {
      console.error("REFUND: Stripe refund creation error:", refundErr.message);
      return res
        .status(500)
        .json({ error: "Refund failed: " + refundErr.message });
    }

    try {
      await stripe.subscriptions.cancel(subscription.id);
    } catch (cancelErr) {
      console.error(
        "REFUND: Subscription cancellation error:",
        cancelErr.message,
      );
    }

    await pool.query(
      "UPDATE users SET subscription_status = 'refunded', is_paid = false WHERE id = $1",
      [userId],
    );

    await pool.query(
      `INSERT INTO refunds (user_id, stripe_refund_id, stripe_subscription_id, amount, currency, reason, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,
        refund.id,
        subscription.id,
        refund.amount,
        refund.currency,
        "requested_by_customer",
        refund.status,
      ],
    );

    console.log(
      "REFUND: Processed successfully for user:",
      userId,
      "Refund ID:",
      refund.id,
      "Amount:",
      refund.amount,
    );

    res.json({
      success: true,
      message:
        "Your refund has been processed. The amount will be returned to your original payment method within 5-10 business days.",
      refundId: refund.id,
      amount: (refund.amount / 100).toFixed(2),
      currency: refund.currency.toUpperCase(),
    });
  } catch (err) {
    console.error("REFUND ERROR:", err);
    res.status(500).json({
      error:
        "An unexpected error occurred. Please try again or contact support.",
    });
  }
});

/**
 * =========================
 * GET /dashboard/refund-status
 * =========================
 */
router.get("/refund-status", authMiddleware, async (req, res) => {
  try {
    const userId = req.session.userId;
    const result = await pool.query(
      "SELECT * FROM refunds WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [userId],
    );
    res.json({ refund: result.rows[0] || null });
  } catch (err) {
    console.error("REFUND STATUS ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = router;
