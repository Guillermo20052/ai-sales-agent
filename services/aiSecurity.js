/**
 * AI agent security: prompt injection, response validation, memory poisoning, context sanitization.
 */

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(previous|prior|all)\s+instructions/i,
  /disregard\s+(previous|prior|all)/i,
  /forget\s+(everything|all|previous)/i,
  /system\s+prompt/i,
  /reveal\s+(your\s+)?(system\s+)?prompt/i,
  /reveal\s+(your\s+)?instructions/i,
  /show\s+(your\s+)?(system\s+)?prompt/i,
  /show\s+hidden\s+data/i,
  /show\s+internal\s+configuration/i,
  /display\s+(your\s+)?instructions/i,
  /what\s+are\s+your\s+instructions/i,
  /repeat\s+(your\s+)?(system\s+)?prompt/i,
  /output\s+your\s+prompt/i,
  /print\s+your\s+(system\s+)?prompt/i,
  /print\s+your\s+hidden\s+instructions/i,
  /leak\s+(your\s+)?(system\s+)?prompt/i,
  /\[INST\]|\[\/INST\]|<<SYS>>|<<\/SYS>>/i,
  /you\s+are\s+now\s+in\s+debug\s+mode/i,
  /override\s+(previous|prior)/i,
  /dump\s+(the\s+)?database/i,
  /access\s+system\s+files/i,
  /read\s+(system|internal)\s+files/i,
];

const MEMORY_POISON_PATTERNS = [
  /ignore\s+(previous|prior|all)\s+instructions/i,
  /system\s+prompt/i,
  /you\s+must\s+(always|never)/i,
  /your\s+new\s+instructions/i,
  /admin\s+(password|access|privilege)/i,
  /role\s*:\s*admin/i,
  /act\s+as\s+an?\s+admin/i,
  /reveal\s+instructions/i,
  /show\s+prompt/i,
];

const RESPONSE_LEAK_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,
  /pk_[a-zA-Z0-9]{20,}/,
  /whsec_[a-zA-Z0-9]+/,
  /\bANTHROPIC_API_KEY\b/,
  /\bVOYAGE_API_KEY\b/,
  /\bSTRIPE_SECRET_KEY\b/,
  /\bDATABASE_URL\s*[=:]\s*[^\s]+/,
  /\bprocess\.env\./,
  /postgres(ql)?:\/\/[^\s]+/i,
  /mongodb(\+srv)?:\/\/[^\s]+/i,
  /api[_-]?key\s*[=:]\s*["']?[a-zA-Z0-9_-]{20,}/i,
  /password\s*[=:]\s*["']?[^\s"']{8,}/i,
  /You are a 24\/7 customer support representative/,
  /STRICT_BUSINESS_VOICE_INSTRUCTION/,
  /buildSystemPrompt|systemPrompt\s*=/,
];

const INJECTION_IN_CONTEXT_PATTERNS = [
  /<script\b[^>]*>[\s\S]*?<\/script>/gi,
  /ignore\s+(previous|prior|all)\s+instructions/gi,
  /system\s+prompt\s*:/gi,
  /\[INST\]|\[\/INST\]|<<SYS>>|<<\/SYS>>/gi,
];

const SAFE_REFUSAL_MESSAGE = "I can only help with questions about this business. I'm not able to do that.";
const SAFE_FALLBACK_MESSAGE = "I couldn't process that. Please try asking something else about our products or services.";

function isPromptInjection(message) {
  if (!message || typeof message !== "string") return false;
  const normalized = message.trim();
  if (normalized.length < 10) return false;
  return PROMPT_INJECTION_PATTERNS.some((p) => p.test(normalized));
}

function isMemoryPoison(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.trim();
  if (t.length < 12) return false;
  return MEMORY_POISON_PATTERNS.some((p) => p.test(t));
}

function sanitizeWebsiteContext(text) {
  if (!text || typeof text !== "string") return "";
  let out = text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, "")
    .replace(/javascript\s*:/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  INJECTION_IN_CONTEXT_PATTERNS.forEach((p) => {
    out = out.replace(p, " ");
  });
  return out.replace(/\s{2,}/g, " ").trim();
}

function isResponseLeakingSecrets(response) {
  if (!response || typeof response !== "string") return false;
  return RESPONSE_LEAK_PATTERNS.some((p) => p.test(response));
}

function filterMemoryLine(line) {
  if (!line || typeof line !== "string") return false;
  const t = line.trim();
  if (t.length < 8) return false;
  return !isMemoryPoison(t);
}

module.exports = {
  isPromptInjection,
  isMemoryPoison,
  sanitizeWebsiteContext,
  isResponseLeakingSecrets,
  filterMemoryLine,
  SAFE_REFUSAL_MESSAGE,
  SAFE_FALLBACK_MESSAGE,
};
