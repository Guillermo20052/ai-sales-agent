const pool = require("../services/db");
const { logSecurityEvent } = require("./security");

const SESSION_INACTIVITY_MS = 2 * 60 * 60 * 1000; // 2 hours

function destroySession(req, res) {
  req.session.destroy(() => {
    res.clearCookie("sid", { path: "/" });
  });
}

async function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Inactivity timeout
  if (req.session._lastActivity) {
    const elapsed = Date.now() - req.session._lastActivity;
    if (elapsed > SESSION_INACTIVITY_MS) {
      logSecurityEvent("session_inactivity_timeout", { userId: req.session.userId });
      destroySession(req, res);
      return res.status(401).json({ error: "Session expired. Please log in again." });
    }
  }
  req.session._lastActivity = Date.now();

  // Session fingerprint check — if BOTH IP and user-agent changed, force logout
  if (req.session._ip && req.session._ua) {
    const ipChanged = req.session._ip !== req.ip;
    const uaChanged = req.session._ua !== req.headers["user-agent"];
    if (ipChanged && uaChanged) {
      logSecurityEvent("session_fingerprint_mismatch", {
        userId: req.session.userId,
        storedIp: req.session._ip,
        currentIp: req.ip,
      });
      destroySession(req, res);
      return res.status(401).json({ error: "Session invalid. Please log in again." });
    }
  }

  // Verify user still exists in DB
  try {
    const result = await pool.query(
      "SELECT id FROM users WHERE id = $1",
      [req.session.userId],
    );
    if (!result.rows.length) {
      logSecurityEvent("session_user_deleted", { userId: req.session.userId });
      destroySession(req, res);
      return res.status(401).json({ error: "Account not found. Please log in again." });
    }
  } catch (err) {
    console.error("AUTH MIDDLEWARE DB ERROR:", err);
    return res.status(500).json({ error: "Internal server error" });
  }

  next();
}

module.exports = requireAuth;
