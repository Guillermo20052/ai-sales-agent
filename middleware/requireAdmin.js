const pool = require("../services/db");

async function requireAdmin(req, res, next) {
  try {
    if (!req.session.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const result = await pool.query(
      "SELECT role FROM users WHERE id = $1",
      [req.session.userId]
    );

    if (!result.rows.length || result.rows[0].role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    next();
  } catch (err) {
    console.error("ADMIN CHECK ERROR:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

module.exports = requireAdmin;
