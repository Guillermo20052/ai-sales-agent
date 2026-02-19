const express = require("express");
const pool = require("../services/db");
const requireAdmin = require("../middleware/requireAdmin");
const fs = require("fs");

const router = express.Router();

router.get("/", requireAdmin, async (req, res) => {
  try {
    /* ===============================
       PLATFORM METRICS
    =============================== */

    // TOTAL USERS
    const totalUsersResult = await pool.query(
      "SELECT COUNT(*) as count FROM users",
    );
    const totalUsers = parseInt(totalUsersResult.rows[0].count);

    // ACTIVE SUBSCRIPTIONS (excluding admin)
    const activeSubsResult = await pool.query(
      "SELECT COUNT(*) as count FROM users WHERE subscription_status = 'active' AND role != 'admin'",
    );
    const activeSubscriptions = parseInt(activeSubsResult.rows[0].count);

    // TOTAL LEADS
    const totalLeadsResult = await pool.query(
      "SELECT COUNT(*) as count FROM leads",
    );
    const totalLeads = parseInt(totalLeadsResult.rows[0].count);

    /* ===============================
       REAL MRR CALCULATION
    =============================== */

    // MONTHLY SUBSCRIPTIONS
    const monthlyResult = await pool.query(
      `SELECT COALESCE(SUM(subscription_amount),0) as total
       FROM users
       WHERE subscription_status = 'active'
       AND billing_cycle = 'month'
       AND role != 'admin'`,
    );

    const monthlyMRR = parseInt(monthlyResult.rows[0].total) / 100;

    // YEARLY SUBSCRIPTIONS (normalize to monthly)
    const yearlyResult = await pool.query(
      `SELECT COALESCE(SUM(subscription_amount),0) as total
       FROM users
       WHERE subscription_status = 'active'
       AND billing_cycle = 'year'
       AND role != 'admin'`,
    );

    const yearlyMRR = parseInt(yearlyResult.rows[0].total) / 100 / 12;

    const estimatedMRR = monthlyMRR + yearlyMRR;

    /* ===============================
       LIFETIME REVENUE
    =============================== */

    const lifetimeRevenueResult = await pool.query(
      `SELECT COALESCE(SUM(lifetime_revenue),0) as total
       FROM users`,
    );

    const lifetimeRevenue = parseInt(lifetimeRevenueResult.rows[0].total) / 100;

    /* ===============================
       USER TABLE DATA
    =============================== */

    const usersResult = await pool.query(
      `SELECT u.id,
              u.email,
              u.role,
              u.subscription_status,
              u.billing_cycle,
              u.subscription_amount,
              u.email_verified,
              u.created_at,
              bp.business_name
       FROM users u
       LEFT JOIN business_profiles bp ON bp.user_id = u.id
       ORDER BY u.created_at DESC
       LIMIT 100`,
    );

    /* ===============================
       LEADS TABLE DATA
    =============================== */

    const leadsResult = await pool.query(
      `SELECT l.id,
              l.message,
              l.created_at,
              u.email as user_email,
              bp.business_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN business_profiles bp ON bp.user_id = u.id
       ORDER BY l.created_at DESC
       LIMIT 100`,
    );

    /* ===============================
       LOAD HTML TEMPLATE
    =============================== */

    let html = fs.readFileSync("./views/admin.html", "utf8");

    html = html
      .replace("{{TOTAL_USERS}}", totalUsers)
      .replace("{{ACTIVE_SUBSCRIPTIONS}}", activeSubscriptions)
      .replace("{{TOTAL_LEADS}}", totalLeads)
      .replace(
        "{{ESTIMATED_MRR}}",
        estimatedMRR.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
      )
      .replace(
        "{{LIFETIME_REVENUE}}",
        lifetimeRevenue.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
      )
      .replace(
        "{{USERS_TABLE_ROWS}}",
        usersResult.rows
          .map(
            (u) => `
        <tr>
          <td>${u.id}</td>
          <td>${u.email}</td>
          <td>${u.business_name || "—"}</td>
          <td><span class="badge badge-${u.role}">${u.role}</span></td>
          <td>
            <span class="badge badge-${u.subscription_status}">
              ${u.subscription_status}
            </span>
          </td>
          <td>
            ${
              u.subscription_amount
                ? "$" + (u.subscription_amount / 100).toLocaleString("en-US")
                : "—"
            }
          </td>
          <td>${u.billing_cycle || "—"}</td>
          <td>${u.email_verified ? "Yes" : "No"}</td>
          <td>${new Date(u.created_at).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}</td>
        </tr>
      `,
          )
          .join(""),
      )
      .replace(
        "{{LEADS_TABLE_ROWS}}",
        leadsResult.rows
          .map(
            (l) => `
        <tr>
          <td>${l.id}</td>
          <td>${l.business_name || "—"}</td>
          <td>${l.user_email || "—"}</td>
          <td class="msg-cell">
            ${(l.message || "—").substring(0, 80)}
            ${l.message && l.message.length > 80 ? "..." : ""}
          </td>
          <td>${new Date(l.created_at).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}</td>
        </tr>
      `,
          )
          .join(""),
      );

    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(html);
  } catch (err) {
    console.error("ADMIN PORTAL ERROR:", err);
    res.status(500).send("Internal server error.");
  }
});

module.exports = router;
