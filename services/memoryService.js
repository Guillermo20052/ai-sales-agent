const pool = require("./db");
const { isMemoryPoison, filterMemoryLine } = require("./aiSecurity");

let _logSecurityEvent;
try {
  _logSecurityEvent = require("../middleware/security").logSecurityEvent;
} catch (_) {}
function logSecurityEvent(eventType, details) {
  if (typeof _logSecurityEvent === "function") _logSecurityEvent(eventType, details);
}

const MAX_MEMORY_CHARS = 1500;
const MAX_MEMORY_FACTS = 10;

function clampRetentionDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 30;
  return Math.min(Math.max(Math.floor(n), 1), 365);
}

function getBusinessMemoryConfig(businessProfile) {
  const defaultEnabled =
    String(process.env.AGENT_MEMORY_DEFAULT_ENABLED || "false").toLowerCase() ===
    "true";
  const defaultRetention = clampRetentionDays(
    process.env.AGENT_MEMORY_DEFAULT_RETENTION_DAYS || 30,
  );

  const dbEnabled =
    typeof businessProfile?.memory_enabled === "boolean"
      ? businessProfile.memory_enabled
      : null;
  const dbRetention =
    businessProfile?.memory_retention_days != null
      ? clampRetentionDays(businessProfile.memory_retention_days)
      : null;

  return {
    enabled: dbEnabled == null ? defaultEnabled : dbEnabled,
    retentionDays: dbRetention == null ? defaultRetention : dbRetention,
  };
}

async function getPersistentVisitorMemory(businessId, visitorId, config) {
  if (!config?.enabled || !businessId || !visitorId) return "";
  const retentionDays = clampRetentionDays(config.retentionDays);
  try {
    const result = await pool.query(
      `SELECT memory_text
       FROM business_visitor_memory
       WHERE business_id = $1
         AND visitor_id = $2
         AND updated_at >= NOW() - ($3::text || ' days')::interval
       LIMIT 1`,
      [businessId, visitorId, String(retentionDays)],
    );
    return String(result.rows[0]?.memory_text || "").trim();
  } catch (_) {
    return "";
  }
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_RE = /(?:\+?\d[\d\s\-()]{7,}\d)/;
const NAME_RE = /(?:(?:[Mm]y name is|[Ii]['']m|[Mm]e llamo|[Ss]oy)\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/;

function extractFactsFromMessage(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw || raw.length < 5) return [];
  const facts = [];

  const emailMatch = raw.match(EMAIL_RE);
  if (emailMatch) facts.push(`contact_email: ${emailMatch[0]}`);
  const phoneMatch = raw.match(PHONE_RE);
  if (phoneMatch) facts.push(`contact_phone: ${phoneMatch[0].trim()}`);
  const nameMatch = raw.match(NAME_RE);
  if (nameMatch) facts.push(`visitor_name: ${nameMatch[1]}`);

  const pricingCues = /\b(pric|cost|how much|quote|presupuesto|precio|cotizaci)/i;
  const bookingCues = /\b(book|reserv|appointment|schedul|cita|reserva)/i;
  const productCues = /\b(interested in|looking for|want to buy|need|busco|quiero|necesito)\b/i;
  const availCues = /\b(avail|in stock|open|hora|horario|when can)/i;

  if (pricingCues.test(raw)) facts.push(`asked_about: pricing`);
  if (bookingCues.test(raw)) facts.push(`asked_about: booking`);
  if (availCues.test(raw)) facts.push(`asked_about: availability`);

  const productMatch = raw.match(productCues);
  if (productMatch) {
    const after = raw.slice(productMatch.index + productMatch[0].length).trim();
    const snippet = after.split(/[.!?,;]/)[0].trim().slice(0, 80);
    if (snippet.length >= 3) facts.push(`interest: ${snippet}`);
  }

  return facts;
}

function extractOutcomeFromAssistant(text) {
  const raw = String(text || "").toLowerCase();
  if (/\b(reach us at|contact us|contáctanos|contacte)\b/.test(raw)) return "outcome: escalated_to_contact";
  if (/\b(email|correo|e-mail).*\b(team|equipo|send)\b/.test(raw)) return "outcome: lead_captured";
  return null;
}

function buildMemoryFromConversation(previousMemory, historyMessages) {
  const prior = String(previousMemory || "").trim();
  const messages = Array.isArray(historyMessages) ? historyMessages : [];

  const priorFacts = prior ? prior.split(" | ").map((s) => s.trim()).filter(Boolean) : [];

  const newFacts = [];
  for (const m of messages) {
    if (!m || typeof m.content !== "string") continue;
    if (m.role === "user") {
      const extracted = extractFactsFromMessage(m.content);
      for (const f of extracted) {
        if (!newFacts.includes(f)) newFacts.push(f);
      }
    }
    if (m.role === "assistant") {
      const outcome = extractOutcomeFromAssistant(m.content);
      if (outcome && !newFacts.includes(outcome)) newFacts.push(outcome);
    }
  }

  const merged = [];
  const seen = new Set();
  const specificPrefixes = ["contact_email:", "contact_phone:", "visitor_name:", "interest:"];
  const allFacts = [...priorFacts, ...newFacts];

  for (const fact of allFacts) {
    const key = fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(fact.slice(0, 180));
  }

  if (merged.length > MAX_MEMORY_FACTS) {
    const specific = merged.filter((f) => specificPrefixes.some((p) => f.startsWith(p)));
    const generic = merged.filter((f) => !specificPrefixes.some((p) => f.startsWith(p)));
    const remaining = MAX_MEMORY_FACTS - specific.length;
    const kept = [...specific, ...generic.slice(-Math.max(remaining, 0))].slice(-MAX_MEMORY_FACTS);
    const compact = kept.join(" | ");
    return compact.length > MAX_MEMORY_CHARS ? compact.slice(-MAX_MEMORY_CHARS) : compact;
  }

  const compact = merged.join(" | ");
  return compact.length > MAX_MEMORY_CHARS ? compact.slice(-MAX_MEMORY_CHARS) : compact;
}

function toPromptMemory(memoryText, options = {}) {
  const maxFacts = Math.max(1, Number(options.maxFacts || 4));
  const maxChars = Math.max(80, Number(options.maxChars || 420));
  const raw = String(memoryText || "").trim();
  if (!raw) return "";
  const pieces = raw
    .split("|")
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const deduped = [];
  for (const p of pieces) {
    const key = p.toLowerCase();
    if (!deduped.some((x) => x.toLowerCase() === key)) {
      deduped.push(p);
    }
    if (deduped.length >= maxFacts) break;
  }
  const compact = deduped.join(" | ");
  return compact.length > maxChars ? compact.slice(0, maxChars).trim() : compact;
}

async function savePersistentVisitorMemory(
  businessId,
  visitorId,
  memoryText,
  config,
) {
  if (!config?.enabled || !businessId || !visitorId) return;
  let memory = String(memoryText || "").trim();
  if (!memory) return;
  if (isMemoryPoison(memory)) {
    logSecurityEvent("malicious_training_input", { businessId, visitorId, context: "memory_poison" });
    const pieces = memory.split("|").map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
    memory = pieces.filter(filterMemoryLine).slice(-MAX_MEMORY_FACTS).join(" | ").slice(-MAX_MEMORY_CHARS);
    if (!memory) return;
  }
  const retentionDays = clampRetentionDays(config.retentionDays);
  try {
    await pool.query(
      `INSERT INTO business_visitor_memory (business_id, visitor_id, memory_text, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (business_id, visitor_id)
       DO UPDATE SET memory_text = EXCLUDED.memory_text, updated_at = NOW()`,
      [businessId, visitorId, memory],
    );
    await pool.query(
      `DELETE FROM business_visitor_memory
       WHERE business_id = $1
         AND updated_at < NOW() - ($2::text || ' days')::interval`,
      [businessId, String(retentionDays)],
    );
  } catch (_) {
    // best effort only
  }
}

module.exports = {
  getBusinessMemoryConfig,
  getPersistentVisitorMemory,
  buildMemoryFromConversation,
  toPromptMemory,
  savePersistentVisitorMemory,
};
