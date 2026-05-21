const pool = require("../services/db");
const { logSecurityEvent } = require("./security");

const ADMIN_INACTIVITY_MS = 30 * 60 * 1000; // 30 minutes for admins

function destroySession(req, res) {
  req.session.destroy(() => {
    res.clearCookie("sid", { path: "/" });
  });
}

async function requireAdmin(req, res, next) {
  try {
    if (!req.session.userId) {
      if (req.headers.accept && req.headers.accept.includes("application/json")) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      return res.redirect("/login.html");
    }

    // Admin inactivity timeout (stricter)
    if (req.session._lastActivity) {
      const elapsed = Date.now() - req.session._lastActivity;
      if (elapsed > ADMIN_INACTIVITY_MS) {
        logSecurityEvent("admin_session_inactivity_timeout", { userId: req.session.userId });
        destroySession(req, res);
        if (req.headers.accept && req.headers.accept.includes("application/json")) {
          return res.status(401).json({ error: "Admin session expired. Please log in again." });
        }
        return res.redirect("/login.html");
      }
    }
    req.session._lastActivity = Date.now();

    // Session fingerprint check
    if (req.session._ip && req.session._ua) {
      const ipChanged = req.session._ip !== req.ip;
      const uaChanged = req.session._ua !== req.headers["user-agent"];
      if (ipChanged && uaChanged) {
        logSecurityEvent("admin_session_fingerprint_mismatch", {
          userId: req.session.userId,
          storedIp: req.session._ip,
          currentIp: req.ip,
        });
        destroySession(req, res);
        if (req.headers.accept && req.headers.accept.includes("application/json")) {
          return res.status(401).json({ error: "Session invalid. Please log in again." });
        }
        return res.redirect("/login.html");
      }
    }

    const result = await pool.query(
      "SELECT role FROM users WHERE id = $1",
      [req.session.userId]
    );

    if (!result.rows.length) {
      logSecurityEvent("admin_session_user_deleted", { userId: req.session.userId });
      destroySession(req, res);
      if (req.headers.accept && req.headers.accept.includes("application/json")) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      return res.redirect("/login.html");
    }

    if (result.rows[0].role !== "admin") {
      if (req.headers.accept && req.headers.accept.includes("application/json")) {
        return res.status(403).json({ error: "Forbidden" });
      }
      return res.redirect("/");
    }

    next();
  } catch (err) {
    console.error("ADMIN CHECK ERROR:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

module.exports = requireAdmin;
