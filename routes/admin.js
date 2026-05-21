const express = require("express");
const pool = require("../services/db");
const requireAdmin = require("../middleware/requireAdmin");
const { isPositiveInt } = require("../middleware/security");
const fs = require("fs");
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const { logAdminAction } = require("../services/adminLogService");
const csrfProtection = require("@dr.pogodin/csurf")({ cookie: false });
const { getRuntimeMetrics } = require("../services/runtimeMetricsService");
const slaService = require("../services/slaService");

const router = express.Router();

/* =========================================
   HELPERS
   ========================================= */

function fmtUSD(cents) {
  return (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function getOverviewStats() {
  const totalUsersResult = await pool.query(
    "SELECT COUNT(*) as count FROM users WHERE role != 'admin'",
  );
  const activeSubsResult = await pool.query(
    "SELECT COUNT(*) as count FROM users WHERE subscription_status = 'active' AND role != 'admin'",
  );
  const monthlyResult = await pool.query(
    `SELECT COALESCE(SUM(subscription_amount),0) as total FROM users
     WHERE subscription_status = 'active' AND billing_cycle = 'month' AND role != 'admin'`,
  );
  const yearlyResult = await pool.query(
    `SELECT COALESCE(SUM(subscription_amount),0) as total FROM users
     WHERE subscription_status = 'active' AND billing_cycle = 'year' AND role != 'admin'`,
  );
  const lifetimeRevenueResult = await pool.query(
    "SELECT COALESCE(SUM(lifetime_revenue),0) as total FROM users",
  );

  const totalUsers = parseInt(totalUsersResult.rows[0].count);
  const activeSubscriptions = parseInt(activeSubsResult.rows[0].count);
  const monthlyMRR = parseInt(monthlyResult.rows[0].total) / 100;
  const yearlyMRR = parseInt(yearlyResult.rows[0].total) / 100 / 12;
  const estimatedMRR = monthlyMRR + yearlyMRR;
  const lifetimeRevenue = parseInt(lifetimeRevenueResult.rows[0].total) / 100;

  const arpu = activeSubscriptions > 0
    ? (estimatedMRR / activeSubscriptions)
    : 0;

  const churnResult = await pool.query(
    `SELECT COUNT(DISTINCT user_id) as count FROM refunds
     WHERE created_at >= NOW() - INTERVAL '30 days'`,
  );
  const canceledLast30 = parseInt(churnResult.rows[0].count);
  const churnRate = activeSubscriptions > 0
    ? ((canceledLast30 / (activeSubscriptions + canceledLast30)) * 100)
    : 0;

  const prevMonthStart = new Date();
  prevMonthStart.setMonth(prevMonthStart.getMonth() - 1, 1);
  prevMonthStart.setHours(0, 0, 0, 0);
  const prevMonthEnd = new Date(prevMonthStart.getFullYear(), prevMonthStart.getMonth() + 1, 0, 23, 59, 59, 999);

  const prevMonthlyResult = await pool.query(
    `SELECT COALESCE(SUM(subscription_amount),0) as total FROM users
     WHERE subscription_status = 'active' AND billing_cycle = 'month' AND role != 'admin'
       AND created_at <= $1`,
    [prevMonthEnd],
  );
  const prevYearlyResult = await pool.query(
    `SELECT COALESCE(SUM(subscription_amount),0) as total FROM users
     WHERE subscription_status = 'active' AND billing_cycle = 'year' AND role != 'admin'
       AND created_at <= $1`,
    [prevMonthEnd],
  );
  const prevMRR = parseInt(prevMonthlyResult.rows[0].total) / 100
    + parseInt(prevYearlyResult.rows[0].total) / 100 / 12;
  const growthRate = prevMRR > 0
    ? (((estimatedMRR - prevMRR) / prevMRR) * 100)
    : 0;

  return { totalUsers, activeSubscriptions, estimatedMRR, lifetimeRevenue, arpu, churnRate, growthRate };
}

/* =========================================
   JSON API ENDPOINTS
   ========================================= */

router.get("/ops-metrics", requireAdmin, async (req, res) => {
  try {
    const metrics = getRuntimeMetrics();
    const health = slaService.evaluateHealth();
    res.json({ metrics, health });
  } catch (err) {
    console.error("ADMIN OPS-METRICS ERROR:", err);
    res.status(500).json({ error: "Unable to load ops metrics." });
  }
});

router.get("/api/users", requireAdmin, async (req, res) => {
  try {
    const q = (req.query.q || "").trim().slice(0, 200);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;

    let where = "WHERE u.role != 'admin'";
    const params = [];

    if (q) {
      params.push(`%${q}%`);
      where += ` AND (u.email ILIKE $${params.length} OR bp.business_name ILIKE $${params.length} OR u.name ILIKE $${params.length})`;
    }

    params.push(limit, offset);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

    const countResult = await pool.query(
      `SELECT COUNT(*) as count
       FROM users u
       LEFT JOIN business_profiles bp ON bp.user_id = u.id
       ${where}`,
      q ? [params[0]] : [],
    );

    const usersResult = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.subscription_status,
              u.billing_cycle, u.subscription_amount, u.stripe_subscription_id,
              u.email_verified, u.lifetime_revenue, u.created_at,
              bp.business_name
       FROM users u
       LEFT JOIN business_profiles bp ON bp.user_id = u.id
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );

    res.json({
      users: usersResult.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      pages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
    });
  } catch (err) {
    console.error("ADMIN LIST USERS ERROR:", err);
    res.status(500).json({ error: "Unable to load users." });
  }
});

router.delete("/users/:id", requireAdmin, csrfProtection, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!isPositiveInt(req.params.id)) {
      client.release();
      return res.status(400).json({ error: "Invalid user ID." });
    }
    const userId = parseInt(req.params.id);
    console.log("ADMIN: Deleting user:", userId, "by admin:", req.session.userId);

    const userResult = await client.query(
      "SELECT id, email, stripe_subscription_id, role FROM users WHERE id = $1",
      [userId],
    );
    if (!userResult.rows.length) {
      client.release();
      return res.status(404).json({ error: "User not found." });
    }
    if (userResult.rows[0].role === "admin") {
      client.release();
      return res.status(403).json({ error: "Cannot delete admin account." });
    }

    const user = userResult.rows[0];

    if (user.stripe_subscription_id) {
      try {
        await stripe.subscriptions.cancel(user.stripe_subscription_id);
        console.log("ADMIN DELETE: Stripe subscription cancelled for user:", userId);
      } catch (stripeErr) {
        console.error("ADMIN DELETE: Stripe cancel error (non-fatal):", stripeErr.message);
      }
    }

    await client.query("BEGIN");

    const bpIds = await client.query(
      "SELECT id FROM business_profiles WHERE user_id = $1",
      [userId],
    );
    const businessIds = bpIds.rows.map((r) => r.id);

    if (businessIds.length > 0) {
      await client.query(
        "DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE business_id = ANY($1))",
        [businessIds],
      );
      await client.query(
        "DELETE FROM conversations WHERE business_id = ANY($1)",
        [businessIds],
      );
      await client.query(
        "DELETE FROM business_visitor_memory WHERE business_id = ANY($1)",
        [businessIds],
      );
      await client.query(
        "DELETE FROM business_website_chunks WHERE business_id = ANY($1)",
        [businessIds],
      );
      await client.query(
        "DELETE FROM business_website_pages WHERE business_id = ANY($1)",
        [businessIds],
      );
      await client.query(
        "DELETE FROM business_products WHERE business_id = ANY($1)",
        [businessIds],
      );
      await client.query(
        "DELETE FROM agent_audit_logs WHERE business_id = ANY($1)",
        [businessIds],
      );
    }

    await client.query("DELETE FROM leads WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM business_knowledge WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM business_profiles WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM users WHERE id = $1", [userId]);

    await client.query("COMMIT");

    console.log("ADMIN: Deleted user", userId, user.email, "— all cascaded data removed");
    logAdminAction({ adminUserId: req.session.userId, actionType: "delete_user", targetUserId: userId, metadata: { email: user.email } });
    res.json({ success: true, message: `Account ${user.email} deleted.` });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("ADMIN DELETE USER ERROR:", err);
    res.status(500).json({ error: "Failed to delete account." });
  } finally {
    client.release();
  }
});

router.post("/users/:id/refund", requireAdmin, csrfProtection, async (req, res) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: "Invalid user ID." });
    const userId = parseInt(req.params.id);

    const userResult = await pool.query(
      "SELECT id, email, stripe_subscription_id, subscription_status, role FROM users WHERE id = $1",
      [userId],
    );
    if (!userResult.rows.length) {
      return res.status(404).json({ error: "User not found." });
    }
    const user = userResult.rows[0];

    if (user.role === "admin") {
      return res.status(403).json({ error: "Cannot refund admin account." });
    }
    if (user.subscription_status === "refunded") {
      return res.status(400).json({ error: "This account has already been refunded." });
    }

    const existingRefund = await pool.query(
      "SELECT id FROM refunds WHERE user_id = $1",
      [userId],
    );
    if (existingRefund.rows.length > 0) {
      return res.status(400).json({ error: "A refund has already been processed for this account." });
    }

    if (!user.stripe_subscription_id) {
      return res.status(400).json({ error: "No Stripe subscription found for this user." });
    }

    const existingBySubscription = await pool.query(
      "SELECT id FROM refunds WHERE stripe_subscription_id = $1",
      [user.stripe_subscription_id],
    );
    if (existingBySubscription.rows.length > 0) {
      return res.status(400).json({ error: "A refund has already been processed for this subscription." });
    }

    let subscription;
    try {
      subscription = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
    } catch (stripeErr) {
      return res.status(400).json({ error: "Could not retrieve subscription from Stripe." });
    }

    let latestInvoice;
    try {
      const invoiceId =
        typeof subscription.latest_invoice === "string"
          ? subscription.latest_invoice
          : subscription.latest_invoice?.id;
      if (invoiceId) {
        latestInvoice = await stripe.invoices.retrieve(invoiceId);
      }
    } catch (_) {}

    if (!latestInvoice || !latestInvoice.payment_intent) {
      return res.status(400).json({ error: "No refundable payment found for this subscription." });
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
      console.error("ADMIN REFUND: Stripe error:", refundErr.message);
      return res.status(500).json({ error: "Refund failed. Please try again." });
    }

    try {
      await stripe.subscriptions.cancel(subscription.id);
    } catch (cancelErr) {
      console.error("ADMIN REFUND: Subscription cancel error (non-fatal):", cancelErr.message);
    }

    await pool.query(
      "UPDATE users SET subscription_status = 'refunded', is_paid = false WHERE id = $1",
      [userId],
    );

    await pool.query(
      `INSERT INTO refunds (user_id, stripe_refund_id, stripe_subscription_id, amount, currency, reason, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, refund.id, subscription.id, refund.amount, refund.currency, "admin_initiated", refund.status],
    );

    console.log("ADMIN: Refund processed for user", userId, "Refund ID:", refund.id);
    logAdminAction({ adminUserId: req.session.userId, actionType: "refund", targetUserId: userId, metadata: { reason: "admin_initiated", refundId: refund.id, amount: refund.amount } });
    res.json({
      success: true,
      message: `Refund of $${(refund.amount / 100).toFixed(2)} ${refund.currency.toUpperCase()} processed for ${user.email}.`,
      refundId: refund.id,
      amount: (refund.amount / 100).toFixed(2),
      currency: refund.currency.toUpperCase(),
    });
  } catch (err) {
    console.error("ADMIN REFUND ERROR:", err);
    res.status(500).json({ error: "Failed to process refund." });
  }
});

router.get("/revenue-chart", requireAdmin, async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 12;
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
    const startTimestamp = Math.floor(startDate.getTime() / 1000);

    const buckets = {};
    for (let i = 0; i < months; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - (months - 1) + i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      buckets[key] = { month: key, revenue: 0, refunds: 0 };
    }

    let hasMore = true;
    let startingAfter = undefined;
    while (hasMore) {
      const params = { limit: 100, created: { gte: startTimestamp } };
      if (startingAfter) params.starting_after = startingAfter;

      const charges = await stripe.charges.list(params);
      for (const ch of charges.data) {
        const d = new Date(ch.created * 1000);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (buckets[key]) {
          if (ch.refunded) {
            buckets[key].refunds += ch.amount_refunded / 100;
            buckets[key].revenue += (ch.amount - ch.amount_refunded) / 100;
          } else if (ch.status === "succeeded") {
            buckets[key].revenue += ch.amount / 100;
          }
        }
      }
      hasMore = charges.has_more;
      if (hasMore && charges.data.length) {
        startingAfter = charges.data[charges.data.length - 1].id;
      }
    }

    res.json(Object.values(buckets));
  } catch (err) {
    console.error("ADMIN REVENUE CHART ERROR:", err);
    res.status(500).json({ error: "Unable to load revenue data." });
  }
});

router.get("/api/refunds", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.stripe_refund_id, r.amount, r.currency, r.reason, r.status, r.created_at,
              u.email, bp.business_name
       FROM refunds r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN business_profiles bp ON bp.user_id = r.user_id
       ORDER BY r.created_at DESC
       LIMIT 200`,
    );
    res.json({ refunds: result.rows });
  } catch (err) {
    console.error("ADMIN LIST REFUNDS ERROR:", err);
    res.status(500).json({ error: "Unable to load refunds." });
  }
});

router.get("/api/new-users", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DATE_TRUNC('month', created_at) AS month, COUNT(*) AS new_users
       FROM users WHERE role != 'admin'
       GROUP BY month ORDER BY month DESC LIMIT 12`,
    );
    const rows = result.rows.reverse().map((r) => ({
      month: r.month.toISOString().slice(0, 7),
      new_users: parseInt(r.new_users),
    }));
    res.json(rows);
  } catch (err) {
    console.error("ADMIN NEW USERS API ERROR:", err);
    res.status(500).json({ error: "Unable to load new users data." });
  }
});

router.get("/api/mrr-trend", requireAdmin, async (req, res) => {
  try {
    const months = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(d);
    }

    const activeUsers = await pool.query(
      `SELECT subscription_amount, billing_cycle, created_at
       FROM users
       WHERE subscription_status = 'active' AND role != 'admin'
         AND subscription_amount > 0`,
    );

    const rows = months.map((m) => {
      const monthEnd = new Date(m.getFullYear(), m.getMonth() + 1, 0, 23, 59, 59, 999);
      const key = m.toISOString().slice(0, 7);

      let mrr = 0;
      for (const u of activeUsers.rows) {
        if (new Date(u.created_at) <= monthEnd) {
          const amt = parseInt(u.subscription_amount) || 0;
          mrr += u.billing_cycle === "year" ? amt / 12 : amt;
        }
      }

      return { month: key, mrr: Math.round(mrr) / 100 };
    });

    res.json(rows);
  } catch (err) {
    console.error("ADMIN MRR TREND API ERROR:", err);
    res.status(500).json({ error: "Unable to load MRR trend data." });
  }
});

/* =========================================
   HTML PAGE HANDLERS
   ========================================= */

router.get("/", requireAdmin, async (req, res) => {
  try {
    const stats = await getOverviewStats();

    const refundCountResult = await pool.query("SELECT COUNT(*) as count FROM refunds");
    const totalRefunds = parseInt(refundCountResult.rows[0].count);
    const refundRate = stats.totalUsers > 0
      ? ((totalRefunds / stats.totalUsers) * 100).toFixed(1)
      : "0.0";

    let html = fs.readFileSync("./views/admin.html", "utf8");

    html = html
      .replace("{{TOTAL_USERS}}", stats.totalUsers)
      .replace("{{ACTIVE_SUBSCRIPTIONS}}", stats.activeSubscriptions)
      .replace("{{ESTIMATED_MRR}}", fmtUSD(stats.estimatedMRR * 100))
      .replace("{{LIFETIME_REVENUE}}", fmtUSD(stats.lifetimeRevenue * 100))
      .replace("{{TOTAL_REFUNDS}}", totalRefunds)
      .replace("{{REFUND_RATE}}", refundRate)
      .replace("{{ARPU}}", fmtUSD(stats.arpu * 100))
      .replace("{{CHURN_RATE}}", stats.churnRate.toFixed(1))
      .replace("{{GROWTH_RATE}}", stats.growthRate.toFixed(1));

    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(html);
  } catch (err) {
    console.error("ADMIN PORTAL ERROR:", err);
    res.status(500).send("Internal server error.");
  }
});

router.get("/users", requireAdmin, csrfProtection, async (req, res) => {
  try {
    let html = fs.readFileSync("./views/admin-users.html", "utf8");
    html = html.replace(/\{\{CSRF_TOKEN\}\}/g, req.csrfToken());
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(html);
  } catch (err) {
    console.error("ADMIN USERS PAGE ERROR:", err);
    res.status(500).send("Internal server error.");
  }
});

router.get("/users/:id", requireAdmin, csrfProtection, async (req, res) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).send("Invalid user ID.");
    const targetId = parseInt(req.params.id);

    if (targetId === req.session.userId) {
      return res.redirect("/internal-admin-portal-93847/users");
    }

    const userResult = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.subscription_status,
              u.billing_cycle, u.subscription_amount, u.stripe_subscription_id,
              u.lifetime_revenue, u.created_at,
              bp.id AS bp_id, bp.business_name, bp.website_url, bp.ai_agent_name
       FROM users u
       LEFT JOIN business_profiles bp ON bp.user_id = u.id
       WHERE u.id = $1`,
      [targetId],
    );
    if (!userResult.rows.length) return res.status(404).send("User not found.");
    const user = userResult.rows[0];

    if (user.role === "admin") {
      return res.redirect("/internal-admin-portal-93847/users");
    }

    const knowledgeResult = await pool.query(
      "SELECT * FROM business_knowledge WHERE user_id = $1 LIMIT 500",
      [targetId],
    );
    const knowledge = knowledgeResult.rows[0] || {};

    const leadsResult = await pool.query(
      "SELECT * FROM leads WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
      [targetId],
    );

    const convsResult = user.bp_id
      ? await pool.query(
          `SELECT c.id, c.visitor_id, m.sender AS role, m.content, m.created_at
           FROM conversations c
           LEFT JOIN LATERAL (
             SELECT sender, content, created_at
             FROM messages
             WHERE conversation_id = c.id
             ORDER BY created_at DESC
             LIMIT 1
           ) m ON true
           WHERE c.business_id = $1
           ORDER BY c.created_at DESC
           LIMIT 50`,
          [user.bp_id],
        )
      : { rows: [] };

    function esc(v) {
      return String(v || "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    function fmtDate(d) {
      return d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "\u2014";
    }

    const plan = user.subscription_amount
      ? "$" + (user.subscription_amount / 100).toLocaleString("en-US") + "/" + (user.billing_cycle === "year" ? "yr" : "mo")
      : "\u2014";
    const revenue = "$" + ((user.lifetime_revenue || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const leadsRows = leadsResult.rows.length
      ? leadsResult.rows.map((l) =>
          `<tr><td>${esc(l.email)}</td><td class="msg-cell">${esc((l.message || "").substring(0, 120))}</td><td>${fmtDate(l.created_at)}</td></tr>`
        ).join("")
      : '<tr class="empty-row"><td colspan="3">No leads found.</td></tr>';

    const convsRows = convsResult.rows.length
      ? convsResult.rows.map((c) =>
          `<tr><td>${esc(c.visitor_id)}</td><td>${esc(c.role)}</td><td class="msg-cell">${esc((c.content || "").substring(0, 120))}</td><td>${fmtDate(c.created_at)}</td></tr>`
        ).join("")
      : '<tr class="empty-row"><td colspan="4">No conversations found.</td></tr>';

    logAdminAction({ adminUserId: req.session.userId, actionType: "view_user", targetUserId: targetId, metadata: { email: user.email } });

    let html = fs.readFileSync("./views/admin-manage-user.html", "utf8");

    html = html
      .replace(/\{\{USER_ID\}\}/g, user.id)
      .replace("{{USER_EMAIL}}", esc(user.email))
      .replace("{{USER_NAME}}", esc(user.name || ""))
      .replace("{{USER_STATUS}}", esc(user.subscription_status || "inactive"))
      .replace("{{USER_PLAN}}", plan)
      .replace("{{USER_REVENUE}}", revenue)
      .replace("{{USER_CREATED}}", fmtDate(user.created_at))
      .replace("{{BP_BUSINESS_NAME}}", esc(user.business_name || ""))
      .replace("{{BP_WEBSITE_URL}}", esc(user.website_url || ""))
      .replace("{{BP_AGENT_NAME}}", esc(user.ai_agent_name || ""))
      .replace("{{BK_DESCRIPTION}}", esc(knowledge.description || ""))
      .replace("{{BK_SERVICES}}", esc(knowledge.services || ""))
      .replace("{{BK_PRICING}}", esc(knowledge.pricing || ""))
      .replace("{{BK_FAQS}}", esc(knowledge.faqs || ""))
      .replace("{{BK_TONE}}", esc(knowledge.tone || ""))
      .replace("{{BK_RESTRICTIONS}}", esc(knowledge.restrictions || ""))
      .replace("{{LEADS_ROWS}}", leadsRows)
      .replace("{{CONVERSATIONS_ROWS}}", convsRows)
      .replace(/\{\{CSRF_TOKEN\}\}/g, req.csrfToken());

    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(html);
  } catch (err) {
    console.error("ADMIN MANAGE USER ERROR:", err);
    res.status(500).send("Internal server error.");
  }
});

router.post("/api/users/:id/profile", requireAdmin, csrfProtection, async (req, res) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: "Invalid user ID." });
    const targetId = parseInt(req.params.id);

    const userCheck = await pool.query("SELECT role FROM users WHERE id = $1", [targetId]);
    if (!userCheck.rows.length) return res.status(404).json({ error: "User not found." });
    if (userCheck.rows[0].role === "admin") return res.status(403).json({ error: "Cannot edit admin." });

    const { business_name, website_url, ai_agent_name, description, services, pricing, faqs, tone, restrictions } = req.body;

    await pool.query(
      `UPDATE business_profiles SET business_name = $1, website_url = $2, ai_agent_name = $3 WHERE user_id = $4`,
      [business_name || "", website_url || "", ai_agent_name || "", targetId],
    );

    const existing = await pool.query("SELECT id FROM business_knowledge WHERE user_id = $1", [targetId]);
    if (existing.rows.length) {
      await pool.query(
        `UPDATE business_knowledge
         SET description = $1, services = $2, pricing = $3, faqs = $4, tone = $5, restrictions = $6, updated_at = NOW()
         WHERE user_id = $7`,
        [description || "", services || "", pricing || "", faqs || "", tone || "", restrictions || "", targetId],
      );
    } else {
      await pool.query(
        `INSERT INTO business_knowledge (user_id, description, services, pricing, faqs, tone, restrictions)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [targetId, description || "", services || "", pricing || "", faqs || "", tone || "", restrictions || ""],
      );
    }

    logAdminAction({ adminUserId: req.session.userId, actionType: "edit_profile", targetUserId: targetId, metadata: { business_name: business_name || "" } });
    res.json({ success: true, message: "Profile updated." });
  } catch (err) {
    console.error("ADMIN UPDATE PROFILE ERROR:", err);
    res.status(500).json({ error: "Failed to update profile." });
  }
});

router.get("/revenue", requireAdmin, async (req, res) => {
  try {
    const stats = await getOverviewStats();
    let html = fs.readFileSync("./views/admin-revenue.html", "utf8");

    html = html
      .replace("{{ACTIVE_SUBSCRIPTIONS}}", stats.activeSubscriptions)
      .replace("{{ESTIMATED_MRR}}", fmtUSD(stats.estimatedMRR * 100))
      .replace("{{LIFETIME_REVENUE}}", fmtUSD(stats.lifetimeRevenue * 100));

    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(html);
  } catch (err) {
    console.error("ADMIN REVENUE PAGE ERROR:", err);
    res.status(500).send("Internal server error.");
  }
});

router.get("/refunds", requireAdmin, async (req, res) => {
  try {
    const countResult = await pool.query("SELECT COUNT(*) as count FROM refunds");
    const totalResult = await pool.query("SELECT COALESCE(SUM(amount),0) as total FROM refunds");

    let html = fs.readFileSync("./views/admin-refunds.html", "utf8");

    html = html
      .replace("{{REFUND_COUNT}}", parseInt(countResult.rows[0].count))
      .replace("{{TOTAL_REFUNDED}}", fmtUSD(parseInt(totalResult.rows[0].total)));

    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(html);
  } catch (err) {
    console.error("ADMIN REFUNDS PAGE ERROR:", err);
    res.status(500).send("Internal server error.");
  }
});

router.get("/admin-logs", requireAdmin, async (req, res) => {
  try {
    const logsResult = await pool.query(
      `SELECT a.id, a.action_type, a.target_user_id, a.metadata, a.created_at,
              u.email AS admin_email
       FROM admin_actions a
       JOIN users u ON u.id = a.admin_user_id
       ORDER BY a.created_at DESC
       LIMIT 200`,
    );

    function esc(v) {
      return String(v || "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    function fmtDate(d) {
      return d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "\u2014";
    }

    const rows = logsResult.rows.length
      ? logsResult.rows.map((r) => {
          const meta = typeof r.metadata === "string" ? r.metadata : JSON.stringify(r.metadata || {});
          return `<tr><td>${esc(r.admin_email)}</td><td>${esc(r.action_type)}</td><td>${r.target_user_id ?? "\u2014"}</td><td class="msg-cell">${esc(meta)}</td><td>${fmtDate(r.created_at)}</td></tr>`;
        }).join("")
      : '<tr class="empty-row"><td colspan="5">No admin actions recorded yet.</td></tr>';

    let html = fs.readFileSync("./views/admin-logs.html", "utf8");
    html = html.replace("{{LOG_ROWS}}", rows);

    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(html);
  } catch (err) {
    console.error("ADMIN LOGS PAGE ERROR:", err);
    res.status(500).send("Internal server error.");
  }
});

router.get("/agent-logs", requireAdmin, async (req, res) => {
  try {
    const where = [];
    const params = [];
    const limit = 100;

    if (req.query.business_id && isPositiveInt(req.query.business_id)) {
      params.push(parseInt(req.query.business_id, 10));
      where.push(`business_id = $${params.length}`);
    }
    if (req.query.conversation_id && isPositiveInt(req.query.conversation_id)) {
      params.push(parseInt(req.query.conversation_id, 10));
      where.push(`conversation_id = $${params.length}`);
    }
    if (req.query.event_type && String(req.query.event_type).trim()) {
      params.push(String(req.query.event_type).trim().slice(0, 100));
      where.push(`event_type = $${params.length}`);
    }
    if (req.query.date_from && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date_from))) {
      params.push(String(req.query.date_from) + "T00:00:00.000Z");
      where.push(`created_at >= $${params.length}::timestamptz`);
    }
    if (req.query.date_to && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date_to))) {
      params.push(String(req.query.date_to) + "T23:59:59.999Z");
      where.push(`created_at <= $${params.length}::timestamptz`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    params.push(limit);

    const result = await pool.query(
      `SELECT id, business_id, conversation_id, event_type, outcome, details_json, created_at
       FROM agent_audit_logs
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    );

    function esc(v) {
      return String(v ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    function fmtDate(d) {
      return d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "\u2014";
    }

    const rows = result.rows.length
      ? result.rows.map((r) => {
          const details = r.details_json != null ? (typeof r.details_json === "string" ? r.details_json : JSON.stringify(r.details_json)) : "";
          const convId = r.conversation_id != null ? r.conversation_id : "";
          const convCell = convId
            ? `<a href="/internal-admin-portal-93847/agent-logs?conversation_id=${encodeURIComponent(convId)}">${esc(convId)}</a>`
            : "\u2014";
          return `<tr><td>${fmtDate(r.created_at)}</td><td>${r.business_id ?? "\u2014"}</td><td>${convCell}</td><td>${esc(r.event_type)}</td><td>${esc(r.outcome ?? "")}</td><td class="msg-cell">${esc(details.slice(0, 500))}${details.length > 500 ? "…" : ""}</td></tr>`;
        }).join("")
      : '<tr class="empty-row"><td colspan="6">No agent audit logs found.</td></tr>';

    let html = fs.readFileSync("./views/admin-agent-logs.html", "utf8");
    html = html
      .replace("{{LOG_ROWS}}", rows)
      .replace(/\{\{FILTER_BUSINESS_ID\}\}/g, esc(req.query.business_id || ""))
      .replace(/\{\{FILTER_CONVERSATION_ID\}\}/g, esc(req.query.conversation_id || ""))
      .replace(/\{\{FILTER_EVENT_TYPE\}\}/g, esc(req.query.event_type || ""))
      .replace(/\{\{FILTER_DATE_FROM\}\}/g, esc(req.query.date_from || ""))
      .replace(/\{\{FILTER_DATE_TO\}\}/g, esc(req.query.date_to || ""));

    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(html);
  } catch (err) {
    console.error("ADMIN AGENT LOGS PAGE ERROR:", err);
    res.status(500).send("Internal server error.");
  }
});

router.post("/users/:id/impersonate", requireAdmin, csrfProtection, async (req, res) => {
  try {
    if (!isPositiveInt(req.params.id)) return res.status(400).json({ error: "Invalid user ID." });
    const targetId = parseInt(req.params.id);
    if (targetId === req.session.userId) return res.status(400).json({ error: "Cannot impersonate yourself." });

    const result = await pool.query("SELECT id, email, role FROM users WHERE id = $1", [targetId]);
    if (!result.rows.length) return res.status(404).json({ error: "User not found." });
    if (result.rows[0].role === "admin") return res.status(403).json({ error: "Cannot impersonate admin accounts." });

    logAdminAction({ adminUserId: req.session.userId, actionType: "impersonate_user", targetUserId: targetId, metadata: { email: result.rows[0].email } });

    req.session.adminImpersonatorId = req.session.userId;
    req.session.userId = targetId;

    res.redirect("/dashboard");
  } catch (err) {
    console.error("ADMIN IMPERSONATE ERROR:", err);
    res.status(500).json({ error: "Failed to impersonate user." });
  }
});

module.exports = router;
