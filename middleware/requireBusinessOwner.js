const pool = require("../services/db");

/**
 * Middleware that resolves the authenticated user's business_profile
 * and attaches it to req.business. Returns 403 if no business found.
 *
 * If req.params.businessId is present, also verifies it matches the
 * user's business (prevents cross-tenant access via URL manipulation).
 */
async function requireBusinessOwner(req, res, next) {
  try {
    const userId = req.session && req.session.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const result = await pool.query(
      "SELECT id, user_id, business_name, website_url FROM business_profiles WHERE user_id = $1",
      [userId],
    );

    if (!result.rows.length) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const business = result.rows[0];

    if (req.params.businessId) {
      if (Number(req.params.businessId) !== business.id) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    req.business = business;
    next();
  } catch (err) {
    console.error("BUSINESS OWNER CHECK ERROR:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

module.exports = requireBusinessOwner;
