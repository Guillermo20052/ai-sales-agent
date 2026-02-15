const pool = require("../services/db");

async function paymentRequired(req, res, next) {
  try {
    const userId = req.session.userId;

    // Not logged in
    if (!userId) {
      return res.status(401).json({
        error: "Authentication required.",
      });
    }

    const result = await pool.query("SELECT is_paid, role FROM users WHERE id = $1", [
      userId,
    ]);

    if (!result.rows.length) {
      return res.status(401).json({
        error: "User not found.",
      });
    }

    const user = result.rows[0];

    if (user.role === "admin") {
      return next();
    }

    if (!user.is_paid) {
      return res.status(403).json({
        error: "Active subscription required.",
        upgrade_endpoint: "/dashboard/checkout",
      });
    }

    next();
  } catch (err) {
    console.error("PAYMENT CHECK ERROR:", err);
    return res.status(500).json({
      error: "Internal server error.",
    });
  }
}

module.exports = paymentRequired;
