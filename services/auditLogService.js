const pool = require("./db");
const { logAuditEvent } = require("./auditWriteHelper");

async function writeAuditLog(event) {
  if (!event || typeof event !== "object") return;
  const eventType = String(event.eventType || "").trim();
  if (!eventType) return;

  await logAuditEvent(
    "agent_audit_logs",
    ["event_type", "actor_user_id", "business_id", "conversation_id", "visitor_id", "outcome", "details_json", "created_at"],
    [
      eventType,
      event.actorUserId || null,
      event.businessId || null,
      event.conversationId || null,
      event.visitorId || null,
      event.outcome || null,
      JSON.stringify(event.details || {}),
      new Date(),
    ],
  );
}

async function getAuditLogs(filters = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
  const where = [];
  const params = [];

  if (filters.businessId) {
    params.push(filters.businessId);
    where.push(`business_id = $${params.length}`);
  }
  if (filters.eventType) {
    params.push(filters.eventType);
    where.push(`event_type = $${params.length}`);
  }
  if (filters.outcome) {
    params.push(filters.outcome);
    where.push(`outcome = $${params.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);

  const result = await pool.query(
    `SELECT id, event_type, actor_user_id, business_id, conversation_id, visitor_id, outcome, details_json, created_at
     FROM agent_audit_logs
     ${whereSql}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return result.rows || [];
}

module.exports = {
  writeAuditLog,
  getAuditLogs,
};
