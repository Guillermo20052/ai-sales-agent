const OpenAI = require("openai");

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  model: "gpt-4o-mini",
  temperature: 0.6,
  max_tokens: 220,
  maxHistoryMessages: 8,
  maxRawWebsiteChars: 4000,
  maxRetries: 2,
  retryDelayMs: 500,
};

const INTENT_KEYWORDS = new Set([
  "price",
  "pricing",
  "cost",
  "costs",
  "fee",
  "fees",
  "book",
  "booking",
  "appointment",
  "schedule",
  "buy",
  "purchase",
  "order",
  "sign up",
  "signup",
  "register",
  "how much",
  "get started",
  "quote",
]);

const FILLER_PATTERNS = [
  /thank you for reaching out[^.]*\./gi,
  /at .*?, we are dedicated[^.]*\./gi,
  /we are committed[^.]*\./gi,
  /i hope (this|that) helps[^.]*\./gi,
  /feel free to (ask|reach out)[^.]*\./gi,
  /please don't hesitate[^.]*\./gi,
];

// ─── OpenAI Client ────────────────────────────────────────────────────────────

let _client = null;

function getClient() {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey)
      throw new Error("OPENAI_API_KEY environment variable is not set.");
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * @param {object} profile
 * @param {string} message
 * @param {Array}  history
 */
function validateInputs(profile, message, history) {
  if (!profile?.business_name)
    throw new Error("businessProfile.business_name is required.");
  if (typeof message !== "string" || !message.trim())
    throw new Error("userMessage must be a non-empty string.");
  if (!Array.isArray(history))
    throw new Error("conversationHistory must be an array.");
}

// ─── Intent Detection ─────────────────────────────────────────────────────────

/**
 * Returns true if the message signals purchase/booking intent.
 * @param {string} message
 * @returns {boolean}
 */
function hasHighBuyingIntent(message) {
  const lower = message.toLowerCase();
  return [...INTENT_KEYWORDS].some((kw) => lower.includes(kw));
}

// ─── Website Knowledge Parser ─────────────────────────────────────────────────

/**
 * Extracts structured and raw text from website_knowledge.
 * @param {object|string|undefined} raw
 * @returns {{ structured: string, raw: string }}
 */
function parseWebsiteKnowledge(raw) {
  if (!raw) return { structured: "", raw: "" };

  try {
    const wk = typeof raw === "string" ? JSON.parse(raw) : raw;
    const structured =
      Array.isArray(wk.sections) && wk.sections.length
        ? wk.sections.map((s) => `[${s.title}]\n${s.content}`).join("\n\n")
        : "";
    const rawText =
      typeof wk.raw_text === "string"
        ? wk.raw_text.slice(0, CONFIG.maxRawWebsiteChars)
        : "";
    return { structured, raw: rawText };
  } catch (err) {
    console.warn(
      "[salesAgent] Failed to parse website_knowledge:",
      err.message,
    );
    return { structured: "", raw: "" };
  }
}

// ─── System Prompt Builder ────────────────────────────────────────────────────

/**
 * Builds a compact, prioritized system prompt.
 * @param {object} profile
 * @param {object|null} knowledge
 * @param {boolean} highIntent
 * @returns {string}
 */
function buildSystemPrompt(profile, knowledge, highIntent) {
  const { business_name } = profile;
  const { structured, raw } = parseWebsiteKnowledge(profile.website_knowledge);

  const hasManualData =
    knowledge &&
    (knowledge.description ||
      knowledge.services ||
      knowledge.pricing ||
      knowledge.faqs);

  const tone = knowledge?.tone || "professional";

  // ── Core persona ──────────────────────────────────────────────────────────
  const persona = `You are a sharp, helpful AI sales assistant for ${business_name}. You sound like a real person — not a bot.`;

  // ── Knowledge section ─────────────────────────────────────────────────────
  const knowledgeBlock = hasManualData
    ? `
## Business Knowledge (authoritative — use this first)
- Description: ${knowledge.description || "N/A"}
- Services: ${knowledge.services || "N/A"}
- Pricing: ${knowledge.pricing || "N/A"}
- FAQs: ${knowledge.faqs || "N/A"}
${knowledge.website_url ? `- Website: ${knowledge.website_url}` : ""}
${knowledge.instagram_url ? `- Instagram: ${knowledge.instagram_url}` : ""}
${knowledge.facebook_url ? `- Facebook: ${knowledge.facebook_url}` : ""}

## Website Data (use only if Business Knowledge doesn't cover the topic)
${structured || raw || "None available."}
`
    : `
## Business Snapshot
- Name: ${business_name}
- Services: ${profile.services || "Not specified"}
- Hours: ${profile.hours || "Not specified"}
- Location: ${profile.location || "Not specified"}
`;

  // ── Rules ─────────────────────────────────────────────────────────────────
  const rules = `
  ## Rules
  1. **Accuracy**: Use all available business data (manual + website) to answer intelligently.
  2. You may reasonably infer operational details if they are strongly implied by the business context.
  3. Do NOT invent specific pricing, guarantees, or services that are clearly unsupported.
  4. If something is truly unknown, say: "I'd be happy to confirm that with our team. Can I grab your email?"
  5. If the conversation drifts slightly off-topic, answer briefly and guide it back naturally.
  6. Language: Always reply in the same language as the user.
  7. Tone: ${tone}.
  ${knowledge?.restrictions ? `8. Restrictions: ${knowledge.restrictions}` : ""}
  `;

  // ── Style ─────────────────────────────────────────────────────────────────
  const style = `
## Response Style
- Max 4 sentences. No filler. No corporate speak. No restating the question.
- Sound like a knowledgeable teammate on live chat, not a form letter.
- Use bullet points only when listing 3+ options.
- Short answer → keep it short. Don't pad.
${highIntent ? "- BUYING INTENT DETECTED: Be confident. Give clear next steps. Push toward booking or collecting contact info. Don't be passive." : ""}
`;

  return [persona, knowledgeBlock, rules, style].join("\n").trim();
}

// ─── Response Post-Processing ─────────────────────────────────────────────────

/**
 * Strips filler phrases from the model's reply.
 * @param {string} text
 * @returns {string}
 */
function removeFiller(text) {
  if (!text) return "";
  return FILLER_PATTERNS.reduce(
    (t, pattern) => t.replace(pattern, ""),
    text,
  ).trim();
}

/**
 * Trims the reply to at most maxSentences sentences.
 * @param {string} text
 * @param {number} maxSentences
 * @returns {string}
 */
function trimToSentences(text, maxSentences = 4) {
  if (!text) return "";
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.length <= maxSentences
    ? text
    : sentences.slice(0, maxSentences).join(" ");
}

/**
 * Full post-processing pipeline.
 * @param {string} reply
 * @returns {string}
 */
function postProcess(reply) {
  return trimToSentences(removeFiller(reply ?? ""), 4).trim();
}

// ─── Conversation History ─────────────────────────────────────────────────────

/**
 * Sanitizes and trims conversation history for the API call.
 * @param {Array} history
 * @returns {Array<{role: string, content: string}>}
 */
function sanitizeHistory(history) {
  return history
    .filter(
      (m) => m && typeof m.role === "string" && typeof m.content === "string",
    )
    .slice(-CONFIG.maxHistoryMessages);
}

// ─── API Call with Retry ──────────────────────────────────────────────────────

/**
 * Calls the OpenAI chat completions API with automatic retry on transient errors.
 * @param {Array} messages
 * @returns {Promise<string>}
 */
async function callOpenAI(messages) {
  const client = getClient();
  let lastError;

  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: CONFIG.model,
        temperature: CONFIG.temperature,
        max_tokens: CONFIG.max_tokens,
        messages,
      });
      return response.choices[0].message.content ?? "";
    } catch (err) {
      lastError = err;
      const isRetryable = err.status === 429 || err.status >= 500;
      if (!isRetryable || attempt === CONFIG.maxRetries) break;
      const delay = CONFIG.retryDelayMs * 2 ** attempt;
      console.warn(
        `[salesAgent] Retrying OpenAI call (attempt ${attempt + 1}) after ${delay}ms…`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Generate a sales-optimized AI reply.
 *
 * @param {object} businessProfile - Profile row from your DB.
 * @param {string} userMessage     - Latest message from the user.
 * @param {object|null} knowledge  - Manual training data (description, services, pricing, faqs, …).
 * @param {Array}  conversationHistory - Prior messages [{role, content}, …].
 * @returns {Promise<string>} The assistant's reply.
 */
async function generateSalesReply(
  businessProfile,
  userMessage,
  knowledge = null,
  conversationHistory = [],
) {
  // ── 1. Validate ────────────────────────────────────────────────────────────
  validateInputs(businessProfile, userMessage, conversationHistory);

  // ── 2. Intent detection ────────────────────────────────────────────────────
  const highIntent = hasHighBuyingIntent(userMessage);

  // ── 3. Build prompt ────────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(
    businessProfile,
    knowledge,
    highIntent,
  );

  // ── 4. Assemble messages ───────────────────────────────────────────────────
  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "system",
      content:
        "Detect the user's language. Reply ONLY in that language. Never switch.",
    },
    ...sanitizeHistory(conversationHistory),
    { role: "user", content: userMessage.trim() },
  ];

  // ── 5. Call API ────────────────────────────────────────────────────────────
  const raw = await callOpenAI(messages);

  // ── 6. Post-process ────────────────────────────────────────────────────────
  return postProcess(raw);
}

module.exports = {
  generateSalesReply,
  // Exported for unit testing:
  hasHighBuyingIntent,
  buildSystemPrompt,
  postProcess,
  sanitizeHistory,
};
