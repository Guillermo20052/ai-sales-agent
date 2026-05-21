const express = require("express");
const pool = require("../services/db");
const {
  enqueueTrainingJob,
  getTrainingJob,
  hasActiveTrainingJob,
} = require("../services/trainingQueueService");
const { writeAuditLog } = require("../services/auditLogService");
const authMiddleware = require("../middleware/authMiddleware");
const requireBusinessOwner = require("../middleware/requireBusinessOwner");
const { createCheckoutSession } = require("../services/stripeService");
const { isPositiveInt, billingLimiter, trainingLimiter } = require("../middleware/security");
const fs = require("fs");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const Stripe = require("stripe");
const bcrypt = require("bcrypt");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const REFUND_WINDOW_DAYS = 3;

/**
 * Check if user is within the refund window (3 days of latest invoice payment).
 * Used to gate refund requests and for admin/logging. Does not perform refund.
 * @param {number} userId
 * @returns {Promise<{ eligible: boolean, reason?: string, paidAt?: Date }>}
 */
async function checkRefundEligibility(userId) {
  try {
    const searchResult = await stripe.subscriptions.search({
      query: `metadata['userId']:'${userId}'`,
      limit: 1,
    });
    if (!searchResult.data.length) {
      return { eligible: false, reason: "No subscription found." };
    }
    const subscription = searchResult.data[0];
    let latestInvoice = subscription.latest_invoice;
    if (typeof latestInvoice === "string") {
      latestInvoice = await stripe.invoices.retrieve(latestInvoice);
    }
    if (!latestInvoice || latestInvoice.status !== "paid") {
      return { eligible: false, reason: "No paid invoice found." };
    }
    const paidAtMs =
      (latestInvoice.status_transitions?.paid_at || latestInvoice.created) * 1000;
    const paidAt = new Date(paidAtMs);
    const now = new Date();
    const daysSincePaid = (now - paidAt) / (1000 * 60 * 60 * 24);
    const eligible = daysSincePaid <= REFUND_WINDOW_DAYS;
    const reason = eligible
      ? undefined
      : `Refund window has expired. Payment was ${Math.floor(daysSincePaid)} days ago; refunds are only available within ${REFUND_WINDOW_DAYS} days of billing.`;
    if (process.env.NODE_ENV !== "production") {
      console.log("REFUND ELIGIBILITY:", { userId, eligible, reason, paidAt: paidAt.toISOString() });
    }
    return { eligible, reason, paidAt };
  } catch (err) {
    console.error("REFUND ELIGIBILITY CHECK ERROR:", err.message);
    return { eligible: false, reason: "Could not verify eligibility." };
  }
}

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

    const isImpersonating = !!req.session.adminImpersonatorId;

    if (isAdmin && !isImpersonating) {
      return res.redirect("/internal-admin-portal-93847");
    }

    const isActive = user.subscription_status === "active";

    if (!user.email_verified) {
      return res.redirect("/verify-pending");
    }

    if (!isActive) {
      return res.redirect("/checkout");
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
      .replace("{{businessName}}", escapeHtml(business.business_name || ""))
      .replace(
        "{{statusText}}",
        isActive ? "Active Subscription" : "Subscription Inactive",
      )
      .replace("{{statusClass}}", isActive ? "active" : "inactive")
      .replace("{{hostedLink}}", escapeHtml(hostedLink || ""))
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
                   <p>Refunds are available within 3 days of billing. After that, payments are non-refundable. You may cancel anytime to prevent future billing.</p>
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
      )
      .replace(
        "{{impersonationBanner}}",
        isImpersonating
          ? `<div class="impersonation-banner"><span>You are viewing this account as an admin.</span><form method="POST" action="/admin/stop-impersonation"><button type="submit">Stop Impersonation</button></form></div>`
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
      `SELECT id, name, email, phone, message, COALESCE(status, 'new') AS status, conversation_id, created_at
       FROM leads WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [userId],
    );

    const leads = result.rows;
    const totalLeads = leads.length;
    let contacted = 0;
    let newLeads = 0;
    for (const l of leads) {
      if (l.status === "contacted") contacted++;
      else newLeads++;
    }

    res.json({ totalLeads, contacted, newLeads, leads });
  } catch (err) {
    console.error("LEADS ERROR:", err);
    res.status(500).json({ error: "Database operation failed" });
  }
});

router.post("/leads/:id/contacted", authMiddleware, async (req, res) => {
  try {
    const userId = req.session.userId;
    const leadId = req.params.id;
    if (!isPositiveInt(leadId)) {
      return res.status(400).json({ error: "Invalid lead ID." });
    }

    const result = await pool.query(
      "UPDATE leads SET status = 'contacted' WHERE id = $1 AND user_id = $2 RETURNING id",
      [leadId, userId],
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Lead not found." });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("LEAD STATUS UPDATE ERROR:", err);
    res.status(500).json({ error: "Failed to update lead status." });
  }
});

/**
 * =========================
 * POST /dashboard/checkout
 * =========================
 */
router.post("/checkout", billingLimiter, authMiddleware, async (req, res) => {
  try {
    const userId = req.session.userId;

    const checkoutUrl = await createCheckoutSession(userId);

    res.json({ url: checkoutUrl });
  } catch (err) {
    console.error("CHECKOUT ERROR:", err);
    res.status(500).json({ error: "Unable to create checkout session." });
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
      .replace("{{businessName}}", escapeHtml(business.business_name || ""))
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

    let k = {};
    try {
      const knowledgeResult = await pool.query(
        "SELECT * FROM business_knowledge WHERE user_id = $1 LIMIT 500",
        [userId],
      );
      k = knowledgeResult.rows[0] || {};
    } catch (knowledgeErr) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("TRAINING: business_knowledge not available:", knowledgeErr.message);
      }
    }
    let bp = {};
    try {
      const bpResult = await pool.query(
        `SELECT id, ai_agent_name, memory_enabled, memory_retention_days,
                strict_grounded_enabled, live_nav_enabled, citation_enabled, max_reply_sources,
                website_url, website_last_trained_at
         FROM business_profiles WHERE user_id = $1`,
        [userId],
      );
      bp = bpResult.rows[0] || {};
    } catch (bpErr) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("TRAINING: business_profiles not available:", bpErr.message);
      }
    }
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
      .replace("{{aiAgentName}}", escapeHtml((bp.ai_agent_name && String(bp.ai_agent_name).trim()) || "Aira"))
      .replace("{{restrictions}}", escapeHtml(k.restrictions || ""))
      .replace("{{website_url}}", escapeHtml(bp.website_url || k.website_url || ""))
      .replace("{{websiteIndexedAt}}", bp.website_last_trained_at ? new Date(bp.website_last_trained_at).toISOString() : "")
      .replace("{{instagram_url}}", escapeHtml(k.instagram_url || ""))
      .replace("{{facebook_url}}", escapeHtml(k.facebook_url || ""))
      .replace("{{currentTone}}", k.tone || "Professional")
      .replace(/\{\{strictGroundedChecked\}\}/g, bp.strict_grounded_enabled === false ? "" : "checked")
      .replace(/\{\{liveNavChecked\}\}/g, bp.live_nav_enabled === false ? "" : "checked")
      .replace(/\{\{citationChecked\}\}/g, bp.citation_enabled === false ? "" : "checked")
      .replace(/\{\{memoryChecked\}\}/g, bp.memory_enabled ? "checked" : "")
      .replace(/\{\{memoryRetentionDays\}\}/g, String(bp.memory_retention_days || 30))
      .replace(/\{\{maxReplySources\}\}/g, String(bp.max_reply_sources || 2))
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
      .replace("{{knowledgeBadgeText}}", isTrained ? "TRAINED" : "NOT TRAINED")
      .replace("{{websiteIndexedBadgeClass}}", bp.website_last_trained_at ? "trained" : "untrained")
      .replace("{{websiteIndexedBadgeText}}", bp.website_last_trained_at ? "INDEXED \u2713" : "NOT INDEXED")
      .replace(/\{\{businessId\}\}/g, String(bp.id || ""));

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
      ai_agent_name,
      strict_grounded_enabled,
      live_nav_enabled,
      citation_enabled,
      max_reply_sources,
      memory_enabled,
      memory_retention_days,
    } = req.body;

    const existing = await pool.query(
      "SELECT id FROM business_knowledge WHERE user_id = $1 LIMIT 1",
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

    const agentName = (ai_agent_name && String(ai_agent_name).trim()) || null;
    const strictEnabled = strict_grounded_enabled !== false;
    const liveNavEnabled = live_nav_enabled !== false;
    const citationEnabled = citation_enabled !== false;
    const memoryEnabled = !!memory_enabled;
    const maxSources = Math.min(Math.max(Number(max_reply_sources) || 2, 1), 5);
    const retentionDays = Math.min(Math.max(Number(memory_retention_days) || 30, 1), 365);
    await pool.query(
      `UPDATE business_profiles
       SET website_url = $1,
           ai_agent_name = $2,
           strict_grounded_enabled = $3,
           live_nav_enabled = $4,
           citation_enabled = $5,
           max_reply_sources = $6,
           memory_enabled = $7,
           memory_retention_days = $8
       WHERE user_id = $9`,
      [
        website_url || null,
        agentName || "Aira",
        strictEnabled,
        liveNavEnabled,
        citationEnabled,
        maxSources,
        memoryEnabled,
        retentionDays,
        userId,
      ],
    ).catch(() => {});

    const businessResult = await pool.query(
      "SELECT id FROM business_profiles WHERE user_id = $1 LIMIT 1",
      [userId],
    ).catch(() => ({ rows: [] }));
    const businessId = businessResult.rows[0]?.id || null;
    await writeAuditLog({
      eventType: "settings_updated",
      actorUserId: userId,
      businessId,
      outcome: "success",
      details: {
        strict_grounded_enabled: strictEnabled,
        live_nav_enabled: liveNavEnabled,
        citation_enabled: citationEnabled,
        max_reply_sources: maxSources,
        memory_enabled: memoryEnabled,
        memory_retention_days: retentionDays,
      },
    });

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
router.post("/scrape", trainingLimiter, authMiddleware, async (req, res) => {
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
      "SELECT id, business_name FROM business_profiles WHERE user_id = $1 LIMIT 50",
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
      .replace("{{businessName}}", escapeHtml(business.business_name || ""))
      .replace("{{conversationsJson}}", JSON.stringify(convResult.rows).replace(/<\/script>/gi, "<\\/script>"));

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
router.get("/conversations/:id", authMiddleware, requireBusinessOwner, async (req, res) => {
  try {
    const convId = req.params.id;
    if (!isPositiveInt(convId)) {
      return res.status(400).json({ error: "Invalid conversation ID." });
    }

    const conv = await pool.query(
      "SELECT * FROM conversations WHERE id = $1 AND business_id = $2",
      [convId, req.business.id],
    );
    if (!conv.rows.length)
      return res.status(404).json({ error: "Conversation not found" });

    const msgs = await pool.query(
      "SELECT sender, content, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 500",
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
router.post("/refund", billingLimiter, authMiddleware, async (req, res) => {
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

    const passwordConfirm = req.body.passwordConfirm;
    if (!passwordConfirm || typeof passwordConfirm !== "string") {
      return res.status(401).json({ error: "Password confirmation required." });
    }
    const pwdResult = await pool.query("SELECT password FROM users WHERE id = $1", [userId]);
    if (!pwdResult.rows.length) {
      return res.status(400).json({ error: "User not found." });
    }
    const passwordMatch = await bcrypt.compare(passwordConfirm, pwdResult.rows[0].password);
    if (!passwordMatch) {
      return res.status(401).json({ error: "Password confirmation required." });
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

    const existingBySubscription = await pool.query(
      "SELECT id FROM refunds WHERE stripe_subscription_id = $1",
      [subscription.id],
    );
    if (existingBySubscription.rows.length > 0) {
      return res.status(400).json({
        error: "A refund has already been processed for this subscription.",
      });
    }

    const eligibility = await checkRefundEligibility(userId);
    if (!eligibility.eligible) {
      console.log("REFUND: Denied —", eligibility.reason);
      return res.status(400).json({
        error:
          eligibility.reason ||
          "Refunds are only available within 3 days of your billing date.",
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
        .json({ error: "Refund failed. Please try again." });
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

/**
 * Build description, services, pricing, faqs from website trainer result
 */
function buildTrainingFieldsFromKnowledge(knowledge) {
  const raw = (knowledge.raw_text || "").trim().substring(0, 15000);
  const sections = knowledge.sections || [];
  const descParts = [];
  let services = "";
  let pricing = "";
  let faqs = "";

  const lower = (s) => (s || "").toLowerCase();
  for (const s of sections) {
    const title = (s.title || "").trim();
    const content = (s.content || "").trim();
    const t = lower(title);
    if (t.includes("pric") || t.includes("cost") || t.includes("rate") || t.includes("fee")) {
      pricing += (pricing ? "\n\n" : "") + (title ? title + "\n\n" : "") + content;
    } else if (t.includes("faq") || t.includes("question") || t.includes("answer")) {
      faqs += (faqs ? "\n\n" : "") + (title ? title + "\n\n" : "") + content;
    } else if (t.includes("service") || t.includes("offer") || t.includes("product") || t.includes("what we")) {
      services += (services ? "\n\n" : "") + (title ? title + "\n\n" : "") + content;
    } else {
      descParts.push(title ? title + "\n\n" + content : content);
    }
  }

  const description = raw || descParts.join("\n\n") || "";
  if (!services && descParts.length) services = descParts.slice(0, 3).join("\n\n");
  if (!pricing && description.length > 500) pricing = description.substring(0, 2000);
  return { description: description || raw, services, pricing, faqs };
}

/**
 * =========================
 * POST /dashboard/training/import-from-website
 * Single crawl pipeline: crawlWebsite → store business_website_pages + products.
 * Does NOT overwrite business_knowledge (manual fields). Keeps website_knowledge for backward compat.
 * =========================
 */
router.post("/training/import-from-website", trainingLimiter, authMiddleware, requireBusinessOwner, async (req, res) => {
  try {
    const userId = req.session.userId;
    let { url } = req.body || {};

    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "Please enter a website URL." });
    }
    url = url.trim();
    if (!url) {
      return res.status(400).json({ error: "Please enter a website URL." });
    }
    if (!url.startsWith("http")) url = "https://" + url;

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      return res.status(400).json({ error: "Please enter a valid website URL." });
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
      return res.status(400).json({ error: "Internal URLs are not allowed. Use your public website URL." });
    }

    const businessId = req.business.id;

    if (hasActiveTrainingJob(businessId)) {
      return res.status(429).json({ error: "Too many requests" });
    }

    const job = enqueueTrainingJob({
      userId,
      businessId,
      url,
    });
    await pool.query(
      "UPDATE business_profiles SET website_training_status = $1, website_url = $2 WHERE id = $3",
      ["queued", url, businessId],
    ).catch(() => {});
    res.status(202).json({
      success: true,
      queued: true,
      jobId: job.id,
      message: "Website indexing started. Poll job status endpoint for completion.",
    });
  } catch (err) {
    console.error("IMPORT FROM WEBSITE ERROR:", err);
    res.status(500).json({
      error: "Import failed. Please try again.",
    });
  }
});

/**
 * =========================
 * POST /dashboard/training/website-train
 * Uses same crawl pipeline as import-from-website (crawlWebsite → store pages + products).
 * =========================
 */
router.post("/training/website-train", trainingLimiter, authMiddleware, requireBusinessOwner, async (req, res) => {
  try {
    const userId = req.session.userId;
    const business = req.business;
    const urlFromBody = req.body && req.body.url ? String(req.body.url).trim() : null;
    const url = urlFromBody && urlFromBody.startsWith("http") ? urlFromBody : (urlFromBody ? "https://" + urlFromBody : null) || business.website_url;

    if (!url) {
      return res.status(400).json({ error: "No website URL set. Enter a URL in the Website URL field and try again." });
    }

    if (hasActiveTrainingJob(business.id)) {
      return res.status(429).json({ error: "Too many requests" });
    }

    const job = enqueueTrainingJob({
      userId,
      businessId: business.id,
      url,
    });
    await pool.query(
      "UPDATE business_profiles SET website_training_status = $1 WHERE id = $2",
      ["queued", business.id],
    ).catch(() => {});
    res.status(202).json({
      success: true,
      queued: true,
      jobId: job.id,
    });
  } catch (err) {
    console.error("WEBSITE TRAIN ERROR:", err);
    try {
      const businessId = req.business ? req.business.id : null;
      if (businessId) {
        await pool.query(
          "UPDATE business_profiles SET website_training_status = $1 WHERE id = $2",
          ["failed", businessId],
        );
      }
    } catch (resetErr) {
      console.error("Could not reset training status:", resetErr.message);
    }
    res.status(500).json({
      error: "Website training failed. Check the URL and try again.",
    });
  }
});

router.get("/training/jobs/:jobId", authMiddleware, requireBusinessOwner, async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const job = getTrainingJob(jobId);
    if (!job) return res.status(404).json({ error: "Job not found." });

    if (Number(job.payload.businessId) !== Number(req.business.id)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    res.json({
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      result: job.result,
      error: job.status === "failed" ? "Job failed." : undefined,
    });
  } catch (err) {
    console.error("TRAINING JOB FETCH ERROR:", err);
    res.status(500).json({ error: "Database operation failed" });
  }
});

/**
 * =========================
 * GET /dashboard/training/auto-fill
 * Returns suggested description, services, pricing, faqs from business_website_pages.
 * Does NOT save; user must click Save to persist.
 * =========================
 */
router.get("/training/auto-fill", authMiddleware, requireBusinessOwner, async (req, res) => {
  try {
    const { getAutoFillFromPages } = require("../services/websiteContextService");
    const data = await getAutoFillFromPages(req.business.id);
    res.json(data);
  } catch (err) {
    console.error("AUTO-FILL ERROR:", err);
    res.status(500).json({ error: "Could not generate auto-fill. Index your website first." });
  }
});

module.exports = router;
