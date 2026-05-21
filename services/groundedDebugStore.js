const MAX_LOGS = 500;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

const logs = [];

function addGroundedDebugLog(entry) {
  if (IS_PRODUCTION) return;
  if (!entry || typeof entry !== "object") return;
  logs.push({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    ...entry,
  });
  if (logs.length > MAX_LOGS) {
    logs.splice(0, logs.length - MAX_LOGS);
  }
}

function getGroundedDebugLogs(filters = {}) {
  if (IS_PRODUCTION) return [];
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
  const businessId = filters.businessId ? String(filters.businessId) : null;
  const outcome = filters.outcome ? String(filters.outcome).toLowerCase() : null;

  const filtered = logs.filter((log) => {
    if (businessId && String(log.businessId) !== businessId) return false;
    if (outcome && String(log.outcome || "").toLowerCase() !== outcome) return false;
    return true;
  });

  return filtered.slice(-limit).reverse();
}

module.exports = {
  addGroundedDebugLog,
  getGroundedDebugLogs,
};
