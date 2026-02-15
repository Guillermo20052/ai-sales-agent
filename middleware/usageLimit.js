const pool = require("../services/db");

const FREE_LIMIT = 20;

async function usageLimit(req, res, next) {
  try {
    const userId = req.session.userId;

    const result = await pool.query(
      "SELECT is_paid, message_count, current_period_start, role FROM users WHERE id = $1",
      [userId],
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: "User not found." });
    }

    const user = result.rows[0];

    if (user.role === "admin" || user.is_paid) {
      return next();
    }

    const now = new Date();
    const periodStart = new Date(user.current_period_start);

    // If month changed → reset usage
    if (
      now.getMonth() !== periodStart.getMonth() ||
      now.getFullYear() !== periodStart.getFullYear()
    ) {
      await pool.query(
        "UPDATE users SET message_count = 0, current_period_start = NOW() WHERE id = $1",
        [userId],
      );

      user.message_count = 0;
    }

    // Check free limit
    if (user.message_count >= FREE_LIMIT) {
      return res.status(403).json({
        error: "Free limit reached (20 messages/month). Upgrade required.",
        upgrade_endpoint: "/dashboard/checkout",
      });
    }

    // Increment usage
    await pool.query(
      "UPDATE users SET message_count = message_count + 1 WHERE id = $1",
      [userId],
    );

    next();
  } catch (err) {
    console.error("USAGE LIMIT ERROR:", err);
    res.status(500).json({ error: "Internal server error." });
  }
}

module.exports = usageLimit;
