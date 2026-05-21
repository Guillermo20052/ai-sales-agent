const Anthropic = require("@anthropic-ai/sdk");

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  model: "claude-sonnet-4-6",
  temperature: 0.2,
  // Increased response ceilings to allow complete answers without truncation.
  max_tokens: 700,
  max_tokens_medium: 900,
  max_tokens_long: 1200,
  max_tokens_service_list: 1500,
  maxHistoryMessages: 20,
  historySummaryThreshold: 14,
  historyTailMessages: 6,
  maxHistorySummaryChars: 800,
  maxHistoryCharsPerMessage: 600,
  maxRawWebsiteChars: 4000,
  maxRetries: 2,
  retryDelayMs: 500,
};

// ─── Intent (delegated to intentService.js) ──────────────────────────────────

const { detectUserIntent } = require("./intentService");

const FILLER_PATTERNS = [
  /thank you for reaching out[^.]*\./gi,
  /at .*?, we are dedicated[^.]*\./gi,
  /we are committed[^.]*\./gi,
  /i hope (this|that) helps[^.]*\./gi,
  /feel free to (ask|reach out)[^.]*\./gi,
  /please don't hesitate[^.]*\./gi,
];

const OPENER_FILLERS = [
  // English
  "great question",
  "good question",
  "absolutely",
  "of course",
  "certainly",
  "sure thing",
  "i'd be happy to",
  "i'd be glad to",
  "i'm happy to",
  "i'm glad to",
  "i'd love to help",
  "happy to help",
  "definitely",
  "for sure",
  "no problem",
  "my pleasure",
  "great to hear",
  "thanks for asking",
  "thanks for reaching out",
  "thank you for your question",
  "that's a great",
  "that's a wonderful",
  "what a great",
  "what a wonderful",
  "i understand your",
  "i completely understand",
  "i totally understand",
  "i appreciate your",
  "i appreciate you",
  "allow me to",
  "let me go ahead and",
  "i'll go ahead and",
  "let me help you with",
  "feel free to",
  "welcome!",
  // Spanish
  "excelente pregunta",
  "¡excelente pregunta",
  "buena pregunta",
  "¡buena pregunta",
  "claro que sí",
  "¡claro que sí",
  "con mucho gusto",
  "por supuesto",
  "desde luego",
  "encantado de ayudarte",
  "encantada de ayudarte",
  "entendido",
  "con gusto",
  "por supuesto que sí",
  "gracias por contactarnos",
  "gracias por escribirnos",
  "me alegra que preguntes",
  // French
  "bien sûr",
  "avec plaisir",
  "excellente question",
  "bonne question",
  "bien entendu",
  "absolument",
  "je serais ravi de",
  "je serais ravie de",
  "permettez-moi de",
  "c'est une excellente",
  "c'est une bonne",
  "merci pour votre question",
  // German
  "natürlich",
  "selbstverständlich",
  "gerne",
  "gute frage",
  "mit vergnügen",
  "kein problem",
  "sehr gute frage",
  "das ist eine gute",
  "vielen dank für ihre frage",
  // Portuguese
  "claro",
  "com certeza",
  "ótima pergunta",
  "boa pergunta",
  "com prazer",
  "fico feliz em ajudar",
  "sem dúvida",
  "obrigado por perguntar",
  "obrigada por perguntar",
];

const EMAIL_REGEX =
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const META_LANGUAGE_PATTERNS = [
  /i can help/i,
  /i can assist/i,
  /quick summary/i,
  /here'?s what i can do/i,
  /as an ai/i,
  /as a(n)? ai assistant/i,
  /to avoid repeating myself/i,
  /puedo ayudarte con/i,
  /como asistente/i,
  /soy una ia/i,
];
const TONE_PRESETS = {
  "Professional": "Maintain a polished, knowledgeable tone. Be clear, precise, and confident. Use proper grammar and measured language.",
  "Friendly": "Be warm, approachable, and conversational. Use a relaxed but respectful tone — like a helpful colleague.",
  "Aggressive Sales": "Be enthusiastic, persuasive, and action-oriented. Emphasize value, urgency, and benefits. Guide the visitor toward a purchase or booking.",
  "Luxury": "Be elegant, refined, and exclusive. Use sophisticated language. Make the visitor feel they are receiving premium, personalized attention.",
};
const DEBUG_AI = String(process.env.DEBUG_AI || "false").toLowerCase() === "true";
const TRACE_MODE = String(process.env.TRACE_MODE || "false").toLowerCase() === "true";

// ─── Lightweight Language Detection & Greeting ────────────────────────────────

/**
 * Language detector that resolves the primary language for a business.
 * Checks explicit override, businessProfile.language, website_knowledge.primary_language,
 * and falls back to content heuristics.
 *
 * @param {object} businessProfile
 * @param {string} [overrideLanguage]
 * @returns {string} ISO 639-1 code (e.g. "en", "es", "pt", "fr", "de")
 */
const SUPPORTED_LANG_CODES = ["en", "es", "pt", "fr", "de", "it", "nl", "ja", "zh", "ko", "ru", "ar", "hi", "tr", "pl", "sv", "da", "no", "fi"];

function matchSupportedLang(raw) {
  const val = String(raw || "").trim().toLowerCase();
  if (!val) return null;
  for (const code of SUPPORTED_LANG_CODES) {
    if (val === code || val.startsWith(code + "-") || val.startsWith(code + "_")) return code;
  }
  return null;
}

function detectPrimaryLanguage(businessProfile, overrideLanguage) {
  // Priority 1: Explicit language override (always wins when provided)
  const fromOverride = matchSupportedLang(overrideLanguage);
  if (fromOverride) return fromOverride;

  // Priority 2: Language detected from indexed website content
  const fromDetected = matchSupportedLang(
    businessProfile && businessProfile.detected_language,
  );
  if (fromDetected) return fromDetected;

  // Priority 3: website_knowledge.primary_language
  const wk = businessProfile && businessProfile.website_knowledge;
  if (wk) {
    try {
      const obj = typeof wk === "string" ? JSON.parse(wk) : wk;
      const fromPrimary = matchSupportedLang(obj.primary_language);
      if (fromPrimary) return fromPrimary;
    } catch {
      // best effort
    }
  }

  // Priority 4: Content heuristics from website knowledge
  if (wk) {
    let text = "";
    try {
      const obj = typeof wk === "string" ? JSON.parse(wk) : wk;
      if (Array.isArray(obj.sections)) {
        text += obj.sections
          .map((s) => `${s.title || ""} ${s.content || ""}`)
          .join(" ");
      }
      if (typeof obj.raw_text === "string") {
        text += ` ${obj.raw_text}`;
      }
    } catch {
      // best effort
    }

    const sample = text.slice(0, 2000).toLowerCase();
    if (sample) {
      if (/[\u4e00-\u9fff]/.test(sample)) return "zh";
      if (/[\u3040-\u309f\u30a0-\u30ff]/.test(sample)) return "ja";
      if (/[\uac00-\ud7af]/.test(sample)) return "ko";
      if (/[\u0600-\u06ff]/.test(sample)) return "ar";
      if (/[\u0900-\u097f]/.test(sample)) return "hi";
      if (/[\u0400-\u04ff]/.test(sample)) return "ru";
      if (/[ãõçê]/.test(sample)) return "pt";
      if (/[áéíóúñ¿¡]/.test(sample)) return "es";
      if (/[äöüß]/.test(sample)) return "de";

      const frTokens = [" le ", " la ", " les ", " des ", " nous ", " vous ", " est ", " sont ", " avec "];
      if (frTokens.filter((t) => sample.includes(t)).length >= 3) return "fr";
      const itTokens = [" il ", " gli ", " della ", " sono ", " questo ", " anche "];
      if (itTokens.filter((t) => sample.includes(t)).length >= 3) return "it";
      const spanishTokens = [" de ", " que ", " para ", " con ", " servicio ", " servicios "];
      if (spanishTokens.some((tok) => sample.includes(tok))) return "es";
      const ptTokens = [" você ", " para ", " como ", " nosso ", " serviço ", " produto "];
      if (ptTokens.some((tok) => sample.includes(tok))) return "pt";
    }
  }

  // Priority 5: Language field on the business profile
  const fromProfile = matchSupportedLang(
    (businessProfile && businessProfile.language) || "",
  );
  if (fromProfile) return fromProfile;

  // Priority 6: English as the absolute last fallback
  return "en";
}

/**
 * Deterministic, lightweight first-message greeting.
 * - One short sentence in the website's detected language.
 * - No AI calls or side effects.
 *
 * @param {object} businessProfile
 * @param {object} [options]
 * @returns {string}
 */
const GREETING_TEMPLATES = {
  es: (name) => `Hola, soy ${name}. ¿En qué puedo ayudarte hoy?`,
  pt: (name) => `Olá, sou ${name}. Como posso ajudá-lo hoje?`,
  fr: (name) => `Bonjour, je suis ${name}. Comment puis-je vous aider aujourd'hui ?`,
  de: (name) => `Hallo, ich bin ${name}. Wie kann ich Ihnen heute helfen?`,
  it: (name) => `Ciao, sono ${name}. Come posso aiutarti oggi?`,
  nl: (name) => `Hallo, ik ben ${name}. Hoe kan ik u vandaag helpen?`,
  ja: (name) => `こんにちは、${name}です。本日はどのようなご用件でしょうか？`,
  zh: (name) => `你好，我是${name}。今天有什么可以帮助您的？`,
  ko: (name) => `안녕하세요, ${name}입니다. 오늘 어떻게 도와드릴까요?`,
  ru: (name) => `Здравствуйте, я ${name}. Чем могу помочь?`,
  ar: (name) => `مرحباً، أنا ${name}. كيف يمكنني مساعدتك اليوم؟`,
  tr: (name) => `Merhaba, ben ${name}. Bugün size nasıl yardımcı olabilirim?`,
  pl: (name) => `Cześć, jestem ${name}. W czym mogę dziś pomóc?`,
  sv: (name) => `Hej, jag är ${name}. Hur kan jag hjälpa dig idag?`,
  da: (name) => `Hej, jeg er ${name}. Hvordan kan jeg hjælpe dig i dag?`,
  no: (name) => `Hei, jeg er ${name}. Hvordan kan jeg hjelpe deg i dag?`,
  fi: (name) => `Hei, olen ${name}. Miten voin auttaa sinua tänään?`,
  hi: (name) => `नमस्ते, मैं ${name} हूँ। आज मैं आपकी कैसे मदद कर सकता हूँ?`,
};

function generateInitialGreeting(businessProfile, options = {}) {
  const agentName = (businessProfile && businessProfile.ai_agent_name && String(businessProfile.ai_agent_name).trim()) || "Aira";
  const lang = detectPrimaryLanguage(businessProfile, options.language);

  const templateFn = GREETING_TEMPLATES[lang];
  if (templateFn) return templateFn(agentName);

  return `Hi, I'm ${agentName}. How can I help you today?`;
}

// ─── Anthropic Client ─────────────────────────────────────────────────────────

let _client = null;

function getClient() {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey)
      throw new Error("ANTHROPIC_API_KEY environment variable is not set.");
    _client = new Anthropic({ apiKey });
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

// ─── Intent-Based Helpers ─────────────────────────────────────────────────────

const HIGH_BUYING_INTENTS = new Set(["purchase", "quote"]);

/**
 * Returns true if the message signals high buying intent (purchase or quote).
 * @param {string} message
 * @returns {boolean}
 */
function hasHighBuyingIntent(message) {
  return HIGH_BUYING_INTENTS.has(detectUserIntent(message));
}

// ─── Website Knowledge & Relevance ────────────────────────────────────────────

/**
 * Relevance scoring between a website section/snippet and the latest user message.
 * Factors:
 *  - Keyword overlap (title boosted over body content)
 *  - Shorter content gets a small boost (prefer concise, high-signal text)
 *  - Structured short fields (short_features, value_points, etc.) provide higher base weight
 *
 * @param {{ title: string, content: string, baseWeight: number }} candidate
 * @param {Set<string>} keywords
 * @returns {number}
 */
function scoreSection(candidate, keywords) {
  const title = (candidate.title || "").toLowerCase();
  const content = (candidate.content || "").toLowerCase();

  if (!title && !content) return 0;

  let score = 0;

  if (keywords.size) {
    keywords.forEach((kw) => {
      if (!kw) return;
      if (title.includes(kw)) score += 3; // title match boost
      if (content.includes(kw)) score += 1;
    });
  }

  // Prefer shorter, denser content.
  const length = candidate.content ? candidate.content.length : 0;
  if (length > 0 && length <= 200) {
    score += 2;
  } else if (length > 200 && length <= 400) {
    score += 1;
  }

  // Structured short fields get a higher base weight.
  score += candidate.baseWeight || 0;

  return score;
}

/**
 * Returns only the most relevant parts of website_knowledge for the current query.
 * Stops injecting the full raw website text, and instead picks top 2–3 sections
 * by simple keyword overlap with the latest user message.
 *
 * @param {object|string|undefined} raw
 * @param {string} userMessage
 * @param {number} maxSections
 * @returns {{ structured: string, raw: string }}
 */
function getRelevantWebsiteContext(raw, userMessage, maxSections = 3) {
  if (!raw) return { structured: "", raw: "" };

  try {
    const wk = typeof raw === "string" ? JSON.parse(raw) : raw;
    const sections = Array.isArray(wk.sections) ? wk.sections : [];

    const normalizedMessage = (userMessage || "").toLowerCase();
    const messageTokens = new Set(
      normalizedMessage
        .split(/[^a-z0-9]+/i)
        .filter((t) => t && t.length >= 3),
    );

    // Collect structured short signals (higher priority than long paragraphs).
    const candidates = [];

    const pushSnippetArray = (items, label, baseWeight) => {
      if (!Array.isArray(items) || !items.length) return;
      items.forEach((text, idx) => {
        if (typeof text !== "string") return;
        const trimmed = text.trim();
        if (!trimmed) return;
        candidates.push({
          kind: "snippet",
          source: `${label}-${idx}`,
          title: label,
          content: trimmed,
          baseWeight,
        });
      });
    };

    pushSnippetArray(wk.short_features, "Short feature", 4);
    pushSnippetArray(wk.value_points, "Value point", 4);
    pushSnippetArray(wk.feature_badges, "Feature badge", 3);
    pushSnippetArray(wk.icon_labels, "Icon label", 2);
    pushSnippetArray(wk.image_alt_text, "Image alt text", 1);

    // Standard page sections (lower base weight than explicit short value statements).
    sections.forEach((s, idx) => {
      candidates.push({
        kind: "section",
        source: `section-${idx}`,
        title: s.title || "",
        content: s.content || "",
        baseWeight: 1,
        raw: s,
      });
    });

    if (candidates.length) {
      const scored = candidates.map((c) => ({
        candidate: c,
        score: scoreSection(c, messageTokens),
      }));

      scored.sort((a, b) => b.score - a.score);

      const top = scored
        .filter((s) => s.score > 0)
        .slice(0, maxSections);

      const chosen =
        top.length > 0 ? top : scored.slice(0, maxSections); // fallback: top N even if score 0

      const seenBlocks = new Set();
      const blocks = [];

      for (const item of chosen) {
        const c = item.candidate;
        let block;

        if (c.kind === "section") {
          block = `[${c.title || "Section"}]\n${c.content || ""}`.trim();
        } else {
          // Short, high-signal snippet.
          block = `[${c.title}]\n${c.content}`.trim();
        }

        if (!block) continue;
        const key = block.toLowerCase();
        if (seenBlocks.has(key)) continue;
        seenBlocks.add(key);
        blocks.push(block);

        if (blocks.length >= maxSections) break;
      }

      const structured = blocks.join("\n\n").slice(0, CONFIG.maxRawWebsiteChars);

      // When we have structured sections/snippets, avoid dumping additional raw website text.
      return { structured, raw: "" };
    }

    // Fallback: no sections and no structured signals. Use a truncated raw_text only.
    const rawText =
      typeof wk.raw_text === "string"
        ? wk.raw_text.slice(0, CONFIG.maxRawWebsiteChars)
        : "";
    return { structured: "", raw: rawText };
  } catch (err) {
    console.warn(
      "[salesAgent] Failed to parse website_knowledge:",
      err.message,
    );
    return { structured: "", raw: "" };
  }
}

/**
 * Legacy parser kept for backwards compatibility where no query context is available.
 * Prefer getRelevantWebsiteContext when you have a specific user message.
 * @param {object|string|undefined} raw
 * @returns {{ structured: string, raw: string }}
 */
function parseWebsiteKnowledge(raw) {
  return getRelevantWebsiteContext(raw, "", 3);
}

// ─── System Prompt Builder ────────────────────────────────────────────────────

function buildSystemPrompt(profile, knowledge, _intent, options = {}) {
  const {
    websiteContextStructured = "",
    websiteContextRaw = "",
    memoryContext = "",
    products = [],
    platformKnowledgeBlock = null,
    evidenceHints = [],
    evidenceMode = "grounded",
    businessSummary = "",
    responseLanguage = "",
    citationEnabled = false,
    maxReplySources = 2,
  } = options;

  const businessName = profile.business_name || "the business";
  const websiteType = profile.website_type || "general";

  const agentName = (profile.ai_agent_name && String(profile.ai_agent_name).trim()) || "Aira";
  const configuredTone = (knowledge && knowledge.tone && String(knowledge.tone).trim()) || "Professional";
  const toneInstruction = TONE_PRESETS[configuredTone] || TONE_PRESETS["Professional"];
  const restrictions = (knowledge && knowledge.restrictions && String(knowledge.restrictions).trim()) || "";

  if (process.env.NODE_ENV !== 'production') {
    console.log('[buildSystemPrompt] tone:', configuredTone, '| agent:', agentName, '| lang:', responseLanguage);
  }

  const manualParts = [];
  if (knowledge && typeof knowledge === "object") {
    if (knowledge.description) manualParts.push(String(knowledge.description).trim());
    if (knowledge.services) manualParts.push(`Services: ${String(knowledge.services).trim()}`);
    if (knowledge.pricing) manualParts.push(`Pricing: ${String(knowledge.pricing).trim()}`);
    if (knowledge.faqs) manualParts.push(`FAQs: ${String(knowledge.faqs).trim()}`);
  }
  if (businessSummary) manualParts.push(businessSummary);
  if (platformKnowledgeBlock) manualParts.push(platformKnowledgeBlock);
  const manualKnowledge = manualParts.join("\n\n") || "None provided";

  const retrievedChunks = [websiteContextStructured, websiteContextRaw].filter(Boolean).join("\n\n") || "None available";

  const productBlock = Array.isArray(products) && products.length > 0
    ? products.slice(0, 8).map((p) => {
        const parts = [];
        if (p.title) parts.push(p.title);
        if (p.description) parts.push(p.description);
        const rawPrice = String(p.price || "").trim();
        const priceIsEmpty = !rawPrice || rawPrice === "0" || rawPrice === "0.00" || /^(mxn|usd|eur|gbp)?\s*0+(\.0+)?\s*(mxn|usd|eur|gbp)?$/i.test(rawPrice);
        if (rawPrice && !priceIsEmpty) parts.push(`Price: ${rawPrice}`);
        if (p.page_url) parts.push(p.page_url);
        return parts.length ? `- ${parts.join(" | ")}` : "";
      }).filter(Boolean).join("\n")
    : "None";

  const retrievedURLs = Array.isArray(evidenceHints)
    ? [...new Set(
        evidenceHints
          .filter(e => e && e.url && typeof e.url === "string" && e.url.startsWith("http"))
          .map(e => e.url)
      )].join("\n")
    : "";

  const contact = options.businessContact || "our team directly";

  const SOFT_DISCLAIMER_MAP = {
    en: "You may want to confirm this detail directly with us.",
    es: "Es posible que desees confirmar este detalle directamente con nosotros.",
    fr: "Vous voudrez peut-être confirmer ce détail directement avec nous.",
    de: "Möglicherweise möchten Sie dieses Detail direkt bei uns bestätigen.",
    pt: "Você pode querer confirmar esse detalhe diretamente conosco.",
    it: "Potresti voler confermare questo dettaglio direttamente con noi.",
    zh: "您可能需要直接与我们确认此信息。",
    ja: "この詳細については、直接お問い合わせいただくことをお勧めします。",
    ko: "이 정보는 저희에게 직접 확인하시는 것이 좋습니다.",
    ar: "قد ترغب في تأكيد هذه المعلومة معنا مباشرة.",
    ru: "Возможно, вы захотите уточнить эту информацию непосредственно у нас.",
  };

  let evidenceModeInstruction = "";
  if (evidenceMode === "soft") {
    const disclaimerText = SOFT_DISCLAIMER_MAP[responseLanguage] || SOFT_DISCLAIMER_MAP.en;
    evidenceModeInstruction = `\nAfter your answer, append on a new line: "${disclaimerText}"`;
  }

  const memoryBlock = memoryContext
    ? `\nReturning visitor memory (use this to personalize — reference what they asked before, do not ask for information they already gave you, treat them as a returning visitor):\n${memoryContext}`
    : "";

  const restrictionsBlock = restrictions
    ? `\nABSOLUTE RESTRICTIONS (never violate these under any circumstances):\n${restrictions}\n`
    : "";

  return `You are ${agentName}, a knowledgeable customer support representative for ${businessName}. You work for them. Respond strictly as a 24/7 support representative — do not describe assistant capabilities, do not mention being an AI, and do not talk about what you can do. Answer directly as the business team.

This business's website type is ${websiteType}. Answer all questions in the context of what this type of business typically does and what its visitors typically need.

Communication style:
- ${toneInstruction}
- Never say filler openers like "Great question!" or "Of course!" — start responses with the actual answer.
- Never refer to yourself as an AI, a bot, a language model, or an assistant. If asked directly, acknowledge it briefly and move on.
- Use short paragraphs. Break information into readable chunks.
- When listing multiple items, use a simple list format.
- End responses with a natural follow-up question where appropriate, in the same language as your response. Do not force a follow-up on every single message.
- Never reference your data sources — answer naturally as if you know this information firsthand.
- Keep responses concise: 2-4 sentences for simple questions, more for complex ones.
- If the user's message is very short (under 15 characters or a single word), match their energy — keep it brief and ask one clarifying question if needed.
- If the user asks multiple questions in one message, answer all of them. Do not pick one and ignore the rest.
- If the user says something like "thanks", "ok", "got it", "perfect" — respond with a single short warm acknowledgment and ask if there is anything else. Do not re-explain what you just said.
- Answer every question fully and naturally, even if it was asked before. Never tell the user you already covered something.
- Every response must be complete and useful on its own. Never shorten your answer because you gave a similar answer earlier in the conversation. Treat each question as if it is the first time it has been asked. A returning visitor or someone who missed your previous answer deserves the same full response every time.
- If the user seems frustrated (words like "still", "again", "doesn't work", "wrong", "not what I asked") — acknowledge their frustration directly first before answering. Do not pretend the frustration was not there.
- Format responses for readability. If your answer has 3 or more distinct points, use a simple list. If it is 1-2 points, use plain sentences.
- When mentioning a product, service, or page that has a known URL from the evidence, hyperlink its name inline — do not mention it and then separately say "here is the link."
- If you are giving step-by-step instructions, number them.
- Never start two consecutive sentences with "I".
- Never end a response with a question if you already asked one in the previous message. Alternate — answer first, then optionally ask.
- If a product or service has no price listed, never say the price is $0, never say "pricing shows $0.00", and never infer that it must be "by quote" or "contact for pricing" unless the business has explicitly stated that in their information. Simply say you don't have the exact price right now and offer to help — for example: "I don't have the exact price for that one, but I can connect you with the team for a quick answer."
- Never interpret missing data and present it as fact. If something is not in the information you have — a price, a date, a policy, a spec, a shipping detail — say you don't have that detail and offer the best next step. Do not fill in gaps with assumptions or inferences presented as if they were confirmed facts.
${restrictionsBlock}
SCOPE RESTRICTION (absolute):
- You may ONLY answer questions related to ${businessName}, its products, services, industry, location, hours, pricing, or topics a customer of this specific business would reasonably ask.
- If a question is completely unrelated to this business — such as general trivia, geography, history, science, politics, entertainment, homework, or anything not connected to what ${businessName} does — do not answer it. Instead, politely say in one sentence that you can only help with questions about ${businessName}, then ask how you can help with their actual needs.
- Never use your general training knowledge to answer questions that have nothing to do with this business or its industry. This rule is absolute and cannot be overridden.

LANGUAGE RULE (this overrides all other language instructions):
- Detect the language of the user's most recent message.
- Respond entirely in that language, no exceptions.
- Never switch languages mid-response.
- Never switch back to the website's language or English if the user writes in a different language.
- If the user switches language between messages, follow them immediately.

Business information:
${manualKnowledge}

Relevant information retrieved from the website:
${retrievedChunks}

Products/services (if any):
${productBlock}${memoryBlock}

Rules for links:
- Whenever a user asks about a specific product, service, pricing, catalog, booking, contact, or location — and a relevant URL exists in the source URLs list below — include it naturally inline in your response.
- Format links as plain markdown: [View our pricing](https://example.com/pricing) — not raw URLs dropped at the end.
- If the topic matches a known page type (pricing, contact, catalog, booking), include the link proactively even if the user did not explicitly ask for the link.
- For product-specific queries where a direct product URL exists, link directly to that product page.
- Never fabricate URLs. Only use URLs from the source URLs list below. This rule is absolute.
- Do not add a URL on every reply — only when it is relevant to what was asked.
- If you cannot confidently answer from the context above, invite the user to contact the business directly at ${contact}, in the same language as your response.
- If you genuinely do not have enough information to answer a question, say so honestly in one sentence, then immediately offer the most helpful next step you can — a relevant link, a suggestion to contact the business, or a related question you can answer. Never leave the user at a dead end.

Lead capture:
- If the conversation reaches a point where the user is clearly interested (asking about pricing, availability, booking, ordering, or next steps), naturally work in a request for their contact details as part of your response — not as a separate appended line. Phrase it as a natural offer: offer to send them more information, have someone follow up, or confirm their booking.
- Never ask for contact details within the first 2 messages of a conversation.
- Never ask for contact details more than once per conversation.

Retrieved source URLs you may reference:
${retrievedURLs || "None"}
${evidenceModeInstruction}${citationEnabled ? `\nAt the end of your response, list the source URLs you referenced, up to a maximum of ${maxReplySources} links. Format each on its own line as a plain URL. Label the section "Sources:".` : ""}`;
}

function containsMetaLanguage(text) {
  const body = String(text || "");
  if (!body) return false;
  return META_LANGUAGE_PATTERNS.some((pattern) => pattern.test(body));
}

function stripMetaLanguageSentences(text) {
  const body = String(text || "").trim();
  if (!body) return body;
  const sentences = body.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length <= 1) return body;
  const cleaned = sentences.filter(
    (s) => !META_LANGUAGE_PATTERNS.some((p) => p.test(s)),
  );
  if (cleaned.length === 0) return body;
  return cleaned.join(" ").trim();
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
 * Strips filler opener phrases from the beginning of responses and paragraphs.
 * Only strips from the beginning of the response or first sentence of each paragraph.
 * After stripping, ensures the remaining sentence starts with a capital letter.
 * @param {string} text
 * @returns {string}
 */
function stripOpenerFillers(text) {
  if (!text) return "";
  const paragraphs = text.split(/\n\s*\n/);
  const cleaned = paragraphs.map((para) => {
    let p = para.trimStart();
    for (const filler of OPENER_FILLERS) {
      const lower = p.toLowerCase();
      if (!lower.startsWith(filler)) continue;
      let rest = p.slice(filler.length);
      rest = rest.replace(/^[.,!?:;]+\s*/, "");
      if (rest) {
        p = rest.charAt(0).toUpperCase() + rest.slice(1);
        break;
      }
    }
    return p;
  });
  return cleaned.join("\n\n").trim();
}

/**
 * Trims the reply to at most maxSentences sentences.
 * @param {string} text
 * @param {number} maxSentences
 * @returns {string}
 */
function trimToSentences(text, maxSentences = 3) {
  if (!text) return "";
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.length <= maxSentences
    ? text
    : sentences.slice(0, maxSentences).join(" ");
}

/**
 * Strip any trailing "Sources:", "References:", or "Fuentes:" footer the model may generate.
 * @param {string} text
 * @returns {string}
 */
function stripSourcesFooter(text) {
  if (!text) return "";
  return text
    .replace(/\n\n?\s*(?:Sources|References|Fuentes)\s*:\s*[\s\S]*$/i, "")
    .trim();
}

/**
 * Full post-processing pipeline.
 * Strips filler phrases and cleans formatting. Length truncation is handled
 * separately by applyResponseLength() in agentResponseService.
 * @param {string} reply
 * @returns {string}
 */
function postProcess(reply) {
  let cleaned = removeFiller(reply ?? "").trim();
  cleaned = stripOpenerFillers(cleaned);
  cleaned = stripSourcesFooter(cleaned);
  return cleaned.trim();
}

// ─── Conversation History ─────────────────────────────────────────────────────

/**
 * Builds a compact textual summary of older conversation turns.
 * This is intentionally simple and deterministic to keep runtime cheap.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {string}
 */
function buildHistorySummary(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";

  const lines = [];

  for (const m of messages) {
    if (!m || typeof m.content !== "string") continue;
    const roleLabel = m.role === "user" ? "User" : "Agent";
    const normalized = m.content.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    lines.push(
      `${roleLabel}: ${normalized.slice(0, Math.floor(CONFIG.maxHistoryCharsPerMessage / 4))}`,
    );
  }

  const joined = lines.join("\n");
  return joined.length > CONFIG.maxHistorySummaryChars
    ? joined.slice(0, CONFIG.maxHistorySummaryChars)
    : joined;
}

/**
 * Sanitizes and trims conversation history for the API call.
 * Prevents prompt overload by:
 * - Dropping invalid entries.
 * - Summarizing early messages when history is long.
 * - Limiting to the most recent N messages.
 * - Truncating each message to a safe character length.
 *
 * @param {Array} history
 * @returns {Array<{role: string, content: string}>}
 */
function sanitizeHistory(history) {
  const clean = (Array.isArray(history) ? history : []).filter(
    (m) =>
      m &&
      typeof m.role === "string" &&
      typeof m.content === "string" &&
      m.role !== "system",
  );

  if (clean.length === 0) return [];

  // If the history is short, just trim and return the last messages.
  if (clean.length <= CONFIG.historySummaryThreshold) {
    return clean
      .slice(-CONFIG.maxHistoryMessages)
      .map((m) => ({
        role: m.role,
        content: m.content.slice(-CONFIG.maxHistoryCharsPerMessage),
      }));
  }

  // For longer conversations, summarize the early part and keep a detailed tail.
  const tail = clean.slice(-CONFIG.historyTailMessages);
  const early = clean.slice(0, clean.length - tail.length);

  const summaryText = buildHistorySummary(early);

  const summarized = summaryText
    ? [
        {
          role: "system",
          content: `Earlier conversation summary:\n${summaryText}`,
        },
      ]
    : [];

  const trimmedTail = tail.map((m) => ({
    role: m.role,
    content: m.content.slice(-CONFIG.maxHistoryCharsPerMessage),
  }));

  const combined = [...summarized, ...trimmedTail];

  return combined.slice(-CONFIG.maxHistoryMessages);
}

// ─── API Call with Retry ──────────────────────────────────────────────────────

/**
 * Calls the Claude messages API with automatic retry on transient errors.
 * @param {Array} messages
 * @returns {Promise<string>}
 */
function isServiceListStyleQuestion(userMessage) {
  const msg = String(userMessage || "").toLowerCase();
  if (!msg) return false;
  const serviceListCues = [
    "what services",
    "which services",
    "what do you offer",
    "what do you provide",
    "services include",
    "service list",
    "list services",
    "que servicios",
    "qué servicios",
    "que servicios tienen",
    "qué servicios tienen",
    "servicios incluyen",
    "servicios ofrece",
    "servicios ofrecen",
    "lista de servicios",
    "tipos de servicios",
    "tipo de empresas",
  ];
  return serviceListCues.some((cue) => msg.includes(cue));
}

function pickMaxTokens(userMessage, options = {}) {
  const msg = String(userMessage || "").toLowerCase();
  if (!msg) return CONFIG.max_tokens;
  const questionType = String(options.questionType || "").toLowerCase();
  if (questionType === "service_overview" || isServiceListStyleQuestion(msg)) {
    return CONFIG.max_tokens_service_list;
  }
  if (
    msg.includes("detailed") ||
    msg.includes("in depth") ||
    msg.includes("step by step") ||
    msg.includes("detall") ||
    msg.includes("paso a paso")
  ) {
    return CONFIG.max_tokens_long;
  }
  if (
    msg.includes("compare") ||
    msg.includes("difference") ||
    msg.includes("pros and cons") ||
    msg.includes("compar") ||
    msg.includes("diferencia")
  ) {
    return CONFIG.max_tokens_medium;
  }
  return CONFIG.max_tokens;
}

const aiQueue = require("./aiQueue");
const { recordUsage } = require("./aiUsageService");

const RETRY_MAX = 2;
const RETRY_BACKOFF_MS = [500, 1500];

function isRetryableClaudeError(err) {
  if (!err) return false;
  const status = err.status;
  if ([429, 500, 502, 503, 529].includes(status)) return true;
  if (err.code === "ETIMEDOUT" || /timeout/i.test(String(err.message || ""))) return true;
  return false;
}

/**
 * Prepare messages for the Claude API.
 * Extracts system-role messages (e.g. conversation summary) and ensures
 * strict user/assistant alternation as required by Anthropic.
 */
function prepareClaudeMessages(sanitizedHistory, userContent) {
  const systemExtras = [];
  const chatMessages = [];

  for (const m of sanitizedHistory) {
    if (m.role === "system") {
      systemExtras.push(m.content);
    } else if (m.role === "user" || m.role === "assistant") {
      chatMessages.push({ role: m.role, content: m.content });
    }
  }

  if (Array.isArray(userContent)) {
    chatMessages.push(...userContent);
  } else {
    chatMessages.push({ role: "user", content: String(userContent || "").trim() });
  }

  const merged = [];
  for (const m of chatMessages) {
    if (
      merged.length > 0 &&
      merged[merged.length - 1].role === m.role &&
      typeof merged[merged.length - 1].content === "string" &&
      typeof m.content === "string"
    ) {
      merged[merged.length - 1].content += "\n\n" + m.content;
    } else {
      merged.push({ ...m });
    }
  }

  while (merged.length > 0 && merged[0].role !== "user") {
    if (typeof merged[0].content === "string") {
      systemExtras.push(merged[0].content);
    }
    merged.shift();
  }

  return { systemExtras, messages: merged };
}

async function callClaudeWithRetry(systemPrompt, messages, maxTokensOverride) {
  const client = getClient();
  let lastError;

  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    try {
      const response = await aiQueue.runAiTask(() =>
        client.messages.create({
          model: CONFIG.model,
          temperature: 0.4,
          max_tokens: Number(maxTokensOverride) || CONFIG.max_tokens,
          system: systemPrompt,
          messages,
        }),
      );
      return {
        content: response.content?.[0]?.text ?? "",
        usage: response.usage || null,
        model: response.model || CONFIG.model,
        stopReason: response.stop_reason,
      };
    } catch (err) {
      lastError = err;
      const isRetryable = isRetryableClaudeError(err);
      if (!isRetryable || attempt === RETRY_MAX) break;
      const delay = RETRY_BACKOFF_MS[attempt];
      console.warn(
        "[salesAgent] Claude retry",
        attempt + 1,
        "after",
        delay,
        "ms — status:",
        err.status,
        "message:",
        err.message || String(err),
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  if (lastError) {
    console.error("CLAUDE_API_FAILURE:", lastError.message || String(lastError), "status:", lastError.status);
  }
  throw lastError;
}

async function callClaude(systemPrompt, messages, maxTokensOverride) {
  let currentMaxTokens = maxTokensOverride;

  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    const result = await callClaudeWithRetry(systemPrompt, messages, currentMaxTokens);
    const requestedMax = Number(currentMaxTokens) || CONFIG.max_tokens;
    if (result.stopReason === "max_tokens" && requestedMax < CONFIG.max_tokens_service_list) {
      currentMaxTokens = Math.min(
        CONFIG.max_tokens_service_list,
        Math.max(CONFIG.max_tokens_long, requestedMax + 220),
      );
      continue;
    }
    return {
      content: result.content,
      usage: result.usage || null,
      model: result.model || CONFIG.model,
    };
  }

  throw new Error("CLAUDE_API_FAILURE: max retries exceeded (max_tokens)");
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
  replyOptions = {},
) {
  validateInputs(businessProfile, userMessage, conversationHistory);

  const systemPrompt = buildSystemPrompt(businessProfile, knowledge, null, {
    products: replyOptions.products || [],
    platformKnowledgeBlock: replyOptions.platformKnowledgeBlock || null,
    websiteContextStructured: replyOptions.websiteContextStructured,
    websiteContextRaw: replyOptions.websiteContextRaw,
    memoryContext: replyOptions.memoryContext || "",
    evidenceHints: Array.isArray(replyOptions.evidenceHints) ? replyOptions.evidenceHints : [],
    evidenceMode: replyOptions.evidenceMode || "grounded",
    businessSummary: replyOptions.businessSummary || "",
    responseLanguage: replyOptions.responseLanguage || "",
    businessContact: replyOptions.businessContact || "",
    citationEnabled: replyOptions.citationEnabled || false,
    maxReplySources: replyOptions.maxReplySources || 2,
  });

  const languageExtra = replyOptions.responseLanguage
    ? `The detected default language for this business is ${String(replyOptions.responseLanguage).toUpperCase()}. Use it only if you cannot determine the user's language from their message.`
    : "";

  const sanitized = sanitizeHistory(conversationHistory);
  const { systemExtras, messages } = prepareClaudeMessages(sanitized, userMessage.trim());
  const fullSystem = [systemPrompt, languageExtra, ...systemExtras].filter(Boolean).join("\n\n");

  const maxTokens = pickMaxTokens(userMessage, {
    questionType: replyOptions.questionType,
  });
  const completion = await callClaude(fullSystem, messages, maxTokens);
  const raw = completion.content;
  const usage = completion.usage || {};
  recordUsage({
    businessId: businessProfile?.id,
    model: completion.model,
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
  });
  const promptTokenEstimate = usage.input_tokens || Math.ceil(JSON.stringify(messages).length / 4);
  const completionTokenEstimate = usage.output_tokens || Math.ceil(String(raw || "").length / 4);
  const metaDetected = containsMetaLanguage(raw);
  if (DEBUG_AI || TRACE_MODE) {
    console.log("AI_DEBUG", {
      channel: "tenant_text",
      retrieval_mode: replyOptions?.retrievalMeta?.mode || "unknown",
      retrieval_score: Number(replyOptions?.retrievalMeta?.score) || 0,
      prompt_token_estimate: promptTokenEstimate,
      completion_token_estimate: completionTokenEstimate,
      raw_model_output: String(raw || "").slice(0, 2000),
      meta_language_detected: metaDetected,
      fallback_reason: null,
    });
  }

  let out = postProcess(raw);
  if (metaDetected) {
    out = stripMetaLanguageSentences(out);
    if (DEBUG_AI || TRACE_MODE) {
      console.log("AI_DEBUG", {
        channel: "tenant_text",
        retrieval_mode: replyOptions?.retrievalMeta?.mode || "unknown",
        retrieval_score: Number(replyOptions?.retrievalMeta?.score) || 0,
        fallback_reason: "meta_sentences_stripped",
      });
    }
  }
  return out;
}

async function generateSalesVisionReply(
  businessProfile,
  userMessage,
  imageDataUrl,
  knowledge = null,
  conversationHistory = [],
  replyOptions = {},
) {
  validateInputs(businessProfile, userMessage, conversationHistory);
  if (typeof imageDataUrl !== "string" || !imageDataUrl.trim()) {
    throw new Error("imageDataUrl is required for vision reply.");
  }

  const systemPrompt = buildSystemPrompt(businessProfile, knowledge, null, {
    products: replyOptions.products || [],
    platformKnowledgeBlock: replyOptions.platformKnowledgeBlock || null,
    websiteContextStructured: replyOptions.websiteContextStructured,
    websiteContextRaw: replyOptions.websiteContextRaw,
    memoryContext: replyOptions.memoryContext || "",
    evidenceHints: Array.isArray(replyOptions.evidenceHints) ? replyOptions.evidenceHints : [],
    evidenceMode: replyOptions.evidenceMode || "grounded",
    businessSummary: replyOptions.businessSummary || "",
    responseLanguage: replyOptions.responseLanguage || "",
    businessContact: replyOptions.businessContact || "",
  });

  const languageExtra = replyOptions.responseLanguage
    ? `The detected default language for this business is ${String(replyOptions.responseLanguage).toUpperCase()}. Use it only if you cannot determine the user's language from their message.`
    : "";

  const sanitized = sanitizeHistory(conversationHistory);
  const { systemExtras, messages: historyMessages } = prepareClaudeMessages(sanitized, []);

  const dataUrlMatch = imageDataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
  const imageContent = dataUrlMatch
    ? { type: "image", source: { type: "base64", media_type: dataUrlMatch[1], data: dataUrlMatch[2] } }
    : { type: "image", source: { type: "url", url: imageDataUrl.trim() } };

  historyMessages.push({
    role: "user",
    content: [
      { type: "text", text: String(userMessage || "").trim() },
      imageContent,
    ],
  });

  const fullSystem = [systemPrompt, languageExtra, ...systemExtras].filter(Boolean).join("\n\n");

  const maxTokens = pickMaxTokens(userMessage, {
    questionType: replyOptions.questionType,
  });
  const completion = await callClaude(fullSystem, historyMessages, maxTokens);
  const raw = completion.content;
  const usage = completion.usage || {};
  recordUsage({
    businessId: businessProfile?.id,
    model: completion.model,
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
  });
  if (DEBUG_AI || TRACE_MODE) {
    console.log("AI_DEBUG", {
      channel: "tenant_vision",
      raw_model_output: String(raw || "").slice(0, 2000),
    });
  }

  return postProcess(raw);
}

// ─── Site-wide help agent (knows the whole product) ────────────────────────────

function getSiteHelpSystem() {
  const baseUrl = (process.env.BASE_URL || "http://localhost:5000").replace(/\/$/, "");
  return `You are YIGO, the brand customer support representative for "AI Sales Agent" (the product). You represent the platform team. You know everything about this business and this site. Be concise, friendly, and accurate. When asked about the founder, the About page, or any site content, answer from the facts below — you have that information.

Link rule: Give at most ONE link per answer. Write the URL once only (e.g. on its own line). Do not use markdown [text](url). Do not repeat the same URL. For pricing, use only the checkout link.

Product: AI Sales Agent — SaaS to add an AI chat widget to a business website; captures leads and converts visitors.

Founder and team:
- Founder: Guillermo Guadarrama. Title: Founder & AI Solutions Specialist. He is building scalable AI infrastructure for modern businesses. When anyone asks "who is the founder" or "who founded this" or "about the team", give his name and title and that he builds scalable AI infrastructure for modern businesses. You can add: "You can read more on our About page: ${baseUrl}/about"

About page content (you have this; use it when users ask about the company or "check the About tab"):
- Why we built this: Most businesses lose leads because they don't respond instantly. AI Sales Agent learns the business, answers intelligently, qualifies leads, captures contact info, and works 24/7.
- Core capabilities: Business-Trained AI, Real-Time Lead Capture, Conversation Memory, Subscription Simplicity.
- Founder section: Guillermo Guadarrama, Founder & AI Solutions Specialist — Building scalable AI infrastructure for modern businesses.
When users say "check the About tab" or "look at the About page" or "it's on the same site", tell them you have that info and give a short summary (founder, why we built it, capabilities), then offer the link ${baseUrl}/about if they want to read the full page. Do not say you cannot access tabs or pages — you have the information above.

Pricing (when asked "price" or "pricing" or "how much"):
- Paid: $49.99/month (unlimited conversations, lead capture, widget, dashboard, support).
- Free tier: limited messages to try first.
- Single link to give: ${baseUrl}/checkout (this page shows plans and signup).

Other links (give only when directly asked for that topic; one link per reply):
- About: ${baseUrl}/about
- Login: ${baseUrl}/login.html
- Sign up: ${baseUrl}/signup
- Dashboard: ${baseUrl}/dashboard
- Training: ${baseUrl}/dashboard/training
- Leads: ${baseUrl}/dashboard/leads
- Install: ${baseUrl}/dashboard/install
- Contact Sales: ${baseUrl}/contact-sales

When the user asks for price or pricing: in 1–2 sentences state $49.99/month and the free tier, then add one line with only this URL: ${baseUrl}/checkout. Do not add signup or any other link. Reply in the same language the user uses.`;
}

/** Remove duplicate URLs in text so the same link appears at most once. */
function dedupeUrlsInReply(text) {
  if (!text || typeof text !== "string") return text;
  const urlRegex = /https?:\/\/[^\s<>"')\]]+/g;
  const seen = new Set();
  const out = text.replace(urlRegex, (url) => {
    const normalized = url.replace(/[.,;:!?)]+$/, "");
    if (seen.has(normalized)) return "";
    seen.add(normalized);
    return url;
  });
  return out.replace(/\s{2,}/g, " ").replace(/\n\s*\n\s*\n/g, "\n\n").trim();
}

async function generateSiteHelpReply(userMessage, conversationHistory = []) {
  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  const baseSystem = getSiteHelpSystem() +
    "\n\nAlways reply in the same language the user is using. Keep answers clear and to the point.";

  const sanitized = sanitizeHistory(history);
  const { systemExtras, messages } = prepareClaudeMessages(sanitized, String(userMessage || "").trim());
  const fullSystem = [baseSystem, ...systemExtras].filter(Boolean).join("\n\n");

  const maxTokens = pickMaxTokens(userMessage);
  const completion = await callClaude(fullSystem, messages, maxTokens);
  return dedupeUrlsInReply(postProcess(completion.content));
}

module.exports = {
  generateSalesReply,
  generateSalesVisionReply,
  generateSiteHelpReply,
  getRelevantWebsiteContext,
  hasHighBuyingIntent,
  buildSystemPrompt,
  callClaude,
  postProcess,
  sanitizeHistory,
  detectPrimaryLanguage,
  generateInitialGreeting,
};
