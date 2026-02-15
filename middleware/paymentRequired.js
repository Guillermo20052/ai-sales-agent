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

    const result = await pool.query("SELECT is_paid FROM users WHERE id = $1", [
      userId,
    ]);

    // User not found
    if (!result.rows.length) {
      return res.status(401).json({
        error: "User not found.",
      });
    }

    const isPaid = result.rows[0].is_paid;

    // Not subscribed
    if (!isPaid) {
      return res.status(403).json({
        error: "Active subscription required.",
        upgrade_endpoint: "/dashboard/checkout",
      });
    }

    // Paid → allow access
    next();
  } catch (err) {
    console.error("PAYMENT CHECK ERROR:", err);
    return res.status(500).json({
      error: "Internal server error.",
    });
  }
}

module.exports = paymentRequired;
