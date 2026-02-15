const express = require("express");
const pool = require("../services/db");
const requireAdmin = require("../middleware/requireAdmin");
const fs = require("fs");

const router = express.Router();

router.get("/", requireAdmin, async (req, res) => {
  try {
    const totalUsersResult = await pool.query("SELECT COUNT(*) as count FROM users");
    const totalUsers = parseInt(totalUsersResult.rows[0].count);

    const activeSubsResult = await pool.query(
      "SELECT COUNT(*) as count FROM users WHERE subscription_status = 'active' AND role != 'admin'"
    );
    const activeSubscriptions = parseInt(activeSubsResult.rows[0].count);

    const totalLeadsResult = await pool.query("SELECT COUNT(*) as count FROM leads");
    const totalLeads = parseInt(totalLeadsResult.rows[0].count);

    const mrrResult = await pool.query(
      "SELECT COUNT(*) as count FROM users WHERE subscription_status = 'active' AND role != 'admin'"
    );
    const estimatedMRR = parseInt(mrrResult.rows[0].count) * 50;

    const usersResult = await pool.query(
      `SELECT u.id, u.email, u.role, u.subscription_status, u.email_verified, u.created_at,
              bp.business_name
       FROM users u
       LEFT JOIN business_profiles bp ON bp.user_id = u.id
       ORDER BY u.created_at DESC
       LIMIT 100`
    );

    const leadsResult = await pool.query(
      `SELECT l.id, l.name, l.email, l.phone, l.message, l.created_at,
              bp.business_name
       FROM leads l
       LEFT JOIN business_profiles bp ON bp.id = l.business_id
       ORDER BY l.created_at DESC
       LIMIT 100`
    );

    let html = fs.readFileSync("./views/admin.html", "utf8");

    html = html
      .replace("{{TOTAL_USERS}}", totalUsers)
      .replace("{{ACTIVE_SUBSCRIPTIONS}}", activeSubscriptions)
      .replace("{{TOTAL_LEADS}}", totalLeads)
      .replace("{{ESTIMATED_MRR}}", estimatedMRR.toLocaleString("en-US"))
      .replace("{{USERS_TABLE_ROWS}}", usersResult.rows.map(u => `
        <tr>
          <td>${u.id}</td>
          <td>${u.email}</td>
          <td>${u.business_name || "—"}</td>
          <td><span class="badge badge-${u.role}">${u.role}</span></td>
          <td><span class="badge badge-${u.subscription_status}">${u.subscription_status}</span></td>
          <td>${u.email_verified ? "Yes" : "No"}</td>
          <td>${new Date(u.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
        </tr>
      `).join(""))
      .replace("{{LEADS_TABLE_ROWS}}", leadsResult.rows.map(l => `
        <tr>
          <td>${l.id}</td>
          <td>${l.name || "—"}</td>
          <td>${l.email || "—"}</td>
          <td>${l.phone || "—"}</td>
          <td>${l.business_name || "—"}</td>
          <td class="msg-cell">${(l.message || "—").substring(0, 80)}${l.message && l.message.length > 80 ? "..." : ""}</td>
          <td>${new Date(l.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
        </tr>
      `).join(""));

    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(html);
  } catch (err) {
    console.error("ADMIN PORTAL ERROR:", err);
    res.status(500).send("Internal server error.");
  }
});

module.exports = router;
