const { logAuditEvent } = require("./auditWriteHelper");

const SENSITIVE_META_KEYS = /password|token|secret|apiKey|api_key|credential|session|authorization/i;
function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (SENSITIVE_META_KEYS.test(k)) continue;
    out[k] = v;
  }
  return out;
}

async function logAdminAction({ adminUserId, actionType, targetUserId = null, metadata = {} }) {
  const safeMeta = sanitizeMetadata(metadata);
  await logAuditEvent(
    "admin_actions",
    ["admin_user_id", "action_type", "target_user_id", "metadata"],
    [adminUserId, actionType, targetUserId, JSON.stringify(safeMeta)],
  );
}

module.exports = { logAdminAction };
