const express = require("express");
const pool = require("../services/db");
const {
  generateSalesReply,
  generateInitialGreeting,
  generateSiteHelpReply,
  hasHighBuyingIntent,
  detectPrimaryLanguage,
  getRelevantWebsiteContext,
} = require("../services/aiService");
const { getPlatformKnowledgeBlock } = require("../services/platformKnowledgeService");
const { getRelevantWebsiteContextFromPages, buildBusinessContextSummary } = require("../services/websiteContextService");
const { addGroundedDebugLog } = require("../services/groundedDebugStore");
const { getLiveNavigationContext } = require("../services/websiteNavigationService");
const { writeAuditLog } = require("../services/auditLogService");
const {
  getBusinessMemoryConfig,
  getPersistentVisitorMemory,
  buildMemoryFromConversation,
  toPromptMemory,
  savePersistentVisitorMemory,
} = require("../services/memoryService");
const { recordAgentMetric } = require("../services/runtimeMetricsService");
const {
  shouldAskCatalogNarrowing,
  getCatalogNarrowingQuestion,
  discoverCatalogUrl,
} = require("../services/catalogService");
const {
  extractLeadFields,
  shouldPromptLeadCapture,
  responseAlreadyAsksForContact,
  getLeadPrompt,
} = require("../services/leadCaptureService");
const {
  detectMessageLanguage,
  applyResponseLength,
  reduceRepetition,
  sanitizeReplyLinks,
  cleanText,
} = require("../services/agentResponseService");
const { detectUserIntent } = require("../services/intentService");
const { refineQueryDeterministic } = require("../services/queryRefinementService");
const {
  isPositiveInt,
  logSecurityEvent,
  checkReplaySpam,
  AI_MESSAGE_MAX_LENGTH,
  MAX_NAME_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_PHONE_LENGTH,
  MAX_LEAD_MESSAGE_LENGTH,
} = require("../middleware/security");
const {
  isPromptInjection,
  isResponseLeakingSecrets,
  SAFE_REFUSAL_MESSAGE,
  SAFE_FALLBACK_MESSAGE,
} = require("../services/aiSecurity");
const redis = require("../services/redis");

const router = express.Router();
const PLATFORM_BUSINESS_ID = process.env.PLATFORM_BUSINESS_ID
  ? String(process.env.PLATFORM_BUSINESS_ID).trim()
  : null;
const ENABLE_LIVE_NAV = String(process.env.AGENT_ENABLE_LIVE_NAV || "true").toLowerCase() !== "false";
const LIVE_NAV_MAX_STEPS = Number(process.env.AGENT_LIVE_NAV_MAX_STEPS || 2);
const LIVE_NAV_TIMEOUT_MS = Number(process.env.AGENT_LIVE_NAV_TIMEOUT_MS || 8000);
const LIVE_NAV_TOTAL_BUDGET_MS = Number(process.env.AGENT_LIVE_NAV_TOTAL_BUDGET_MS || 12000);
const RETRIEVAL_CACHE_TTL_MS = Number(process.env.AGENT_RETRIEVAL_CACHE_TTL_MS || 45000);
const NAV_CACHE_TTL_MS = Number(process.env.AGENT_NAV_CACHE_TTL_MS || 30000);
const AGENT_RATE_LIMIT_PER_MIN = Number(process.env.AGENT_RATE_LIMIT_PER_MIN || 40);
const EVIDENCE_STRONG_THRESHOLD = Number(process.env.AGENT_EVIDENCE_STRONG_THRESHOLD || 0.65);
const EVIDENCE_WEAK_THRESHOLD = Number(process.env.AGENT_EVIDENCE_WEAK_THRESHOLD || 0.45);
const TRACE_MODE = String(process.env.TRACE_MODE || "false").toLowerCase() === "true";

// ─── Welcome Context Lines ────────────────────────────────────────────────────

const WELCOME_CONTEXT = {
  ecommerce:    { en: "I can help you find the right product.", es: "Puedo ayudarte a encontrar el producto ideal.", fr: "Je peux vous aider à trouver le bon produit.", de: "Ich kann Ihnen helfen, das richtige Produkt zu finden.", pt: "Posso ajudá-lo a encontrar o produto certo.", it: "Posso aiutarti a trovare il prodotto giusto.", zh: "我可以帮您找到合适的产品。", ja: "最適な製品をお探しするお手伝いができます。", ko: "적합한 제품을 찾는 데 도움을 드릴 수 있습니다.", ar: "يمكنني مساعدتك في العثور على المنتج المناسب.", ru: "Я помогу вам найти подходящий товар." },
  restaurant:   { en: "I can tell you about our menu, hours, and reservations.", es: "Puedo contarte sobre nuestro menú, horarios y reservas.", fr: "Je peux vous renseigner sur notre menu, nos horaires et les réservations.", de: "Ich kann Ihnen von unserer Speisekarte, unseren Öffnungszeiten und Reservierungen erzählen.", pt: "Posso falar sobre nosso cardápio, horários e reservas.", it: "Posso parlarti del nostro menu, degli orari e delle prenotazioni.", zh: "我可以为您介绍我们的菜单、营业时间和预订信息。", ja: "メニュー、営業時間、ご予約についてご案内いたします。", ko: "메뉴, 영업시간, 예약에 대해 안내해 드릴 수 있습니다.", ar: "يمكنني إخبارك عن قائمة الطعام والمواعيد والحجوزات.", ru: "Я расскажу о нашем меню, часах работы и бронировании." },
  services:     { en: "I can answer questions about our services and pricing.", es: "Puedo responder preguntas sobre nuestros servicios y precios.", fr: "Je peux répondre à vos questions sur nos services et nos tarifs.", de: "Ich kann Fragen zu unseren Dienstleistungen und Preisen beantworten.", pt: "Posso responder perguntas sobre nossos serviços e preços.", it: "Posso rispondere alle domande sui nostri servizi e prezzi.", zh: "我可以回答有关我们服务和价格的问题。", ja: "サービスと料金についてのご質問にお答えします。", ko: "서비스와 가격에 대한 질문에 답변해 드릴 수 있습니다.", ar: "يمكنني الإجابة على أسئلتكم حول خدماتنا وأسعارنا.", ru: "Я отвечу на вопросы о наших услугах и ценах." },
  healthcare:   { en: "I can help with information about our services, hours, and appointments.", es: "Puedo ayudarte con información sobre nuestros servicios, horarios y citas.", fr: "Je peux vous renseigner sur nos services, nos horaires et les rendez-vous.", de: "Ich kann Ihnen Informationen zu unseren Leistungen, Öffnungszeiten und Terminen geben.", pt: "Posso ajudá-lo com informações sobre nossos serviços, horários e consultas.", it: "Posso aiutarti con informazioni su servizi, orari e appuntamenti.", zh: "我可以为您提供有关服务、时间和预约的信息。", ja: "サービス、受付時間、予約に関する情報をご案内いたします。", ko: "서비스, 시간, 예약에 대한 정보를 안내해 드릴 수 있습니다.", ar: "يمكنني مساعدتك بمعلومات عن خدماتنا ومواعيدنا والمواعيد.", ru: "Я помогу с информацией о наших услугах, графике работы и записи." },
  realestate:   { en: "I can help you explore properties and answer your questions.", es: "Puedo ayudarte a explorar propiedades y responder tus preguntas.", fr: "Je peux vous aider à découvrir nos biens et répondre à vos questions.", de: "Ich kann Ihnen bei der Immobiliensuche helfen und Ihre Fragen beantworten.", pt: "Posso ajudá-lo a explorar imóveis e responder suas perguntas.", it: "Posso aiutarti a esplorare le proprietà e rispondere alle tue domande.", zh: "我可以帮您浏览房源并回答您的问题。", ja: "物件のご案内やご質問にお答えいたします。", ko: "부동산 탐색과 질문에 도움을 드릴 수 있습니다.", ar: "يمكنني مساعدتك في استكشاف العقارات والإجابة على أسئلتك.", ru: "Я помогу вам изучить объекты недвижимости и отвечу на ваши вопросы." },
  general:      { en: "Ask me anything about our business.", es: "Pregúntame lo que quieras sobre nuestro negocio.", fr: "N'hésitez pas à me poser vos questions.", de: "Fragen Sie mich gerne alles über unser Unternehmen.", pt: "Pergunte-me qualquer coisa sobre nosso negócio.", it: "Chiedimi quello che vuoi sulla nostra attività.", zh: "欢迎咨询我们的业务相关问题。", ja: "何でもお気軽にお尋ねください。", ko: "무엇이든 편하게 물어보세요.", ar: "اسألني أي شيء عن أعمالنا.", ru: "Спрашивайте о нашем бизнесе." },
};

function getWelcomeContextLine(websiteType, lang) {
  const type = String(websiteType || "general").toLowerCase();
  const map = WELCOME_CONTEXT[type] || WELCOME_CONTEXT.general;
  return map[lang] || map.en;
}

// ─── 3-Tier Evidence Evaluation ───────────────────────────────────────────────

function evaluateEvidence(chunks, threshold = EVIDENCE_STRONG_THRESHOLD) {
  const strongChunks = chunks.filter(c => c.score >= threshold);
  const weakChunks = chunks.filter(c => c.score >= EVIDENCE_WEAK_THRESHOLD && c.score < threshold);

  if (strongChunks.length >= 2) return { mode: "grounded", evidence: strongChunks };
  if (weakChunks.length >= 1) return { mode: "soft", evidence: weakChunks };
  return { mode: "escalate", evidence: [] };
}

// ─── Force-Include Intent Keywords ────────────────────────────────────────────

const intentKeywords = {
  pricing: ["pricing", "cost", "how much", "price", "plan", "fee", "charge"],
  contact: ["contact", "phone", "email", "reach", "talk to", "speak", "call"],
  location: ["address", "where", "location", "directions", "find you"],
  faq: ["how do i", "can i", "do you", "is there", "what is"],
};

function getForceIncludePage(query, classifiedPages) {
  for (const [pageType, keywords] of Object.entries(intentKeywords)) {
    if (keywords.some(kw => query.toLowerCase().includes(kw))) {
      const match = classifiedPages.find(p => p.classification === pageType || p.page_type === pageType);
      if (match) return match;
    }
  }
  return null;
}

const ESCALATION_TEMPLATES = {
  en: (c) => `I want to make sure I get this right for you — please reach us at ${c}.`,
  es: (c) => `Quiero asegurarme de darte la información correcta. Por favor, contáctanos en ${c}.`,
  fr: (c) => `Je veux m'assurer de vous donner la bonne information — veuillez nous contacter à ${c}.`,
  de: (c) => `Ich möchte sicherstellen, dass ich Ihnen die richtige Auskunft gebe — bitte kontaktieren Sie uns unter ${c}.`,
  pt: (c) => `Quero garantir que a informação esteja correta — entre em contato conosco em ${c}.`,
  it: (c) => `Voglio assicurarmi di darti le informazioni giuste — contattaci su ${c}.`,
  zh: (c) => `我想确保为您提供准确的信息，请通过 ${c} 联系我们。`,
  ja: (c) => `正確な情報をお伝えするために、${c} までお問い合わせください。`,
  ko: (c) => `정확한 정보를 드리기 위해 ${c}(으)로 연락 부탁드립니다.`,
  ar: (c) => `أريد التأكد من تقديم المعلومات الصحيحة — يرجى التواصل معنا عبر ${c}.`,
  ru: (c) => `Хочу убедиться, что предоставлю вам точную информацию — свяжитесь с нами через ${c}.`,
};

function getEscalationMessage(lang, businessContact, extraContacts) {
  const parts = [];
  if (businessContact && businessContact !== "our team directly") parts.push(businessContact);
  if (extraContacts) {
    if (extraContacts.email) parts.push(extraContacts.email);
    if (extraContacts.phone) parts.push(extraContacts.phone);
  }
  const contact = parts.length ? parts.join(" / ") : "our team directly";
  const fn = ESCALATION_TEMPLATES[lang] || ESCALATION_TEMPLATES.en;
  return fn(contact);
}
const MAX_CACHE_SIZE = 500;
const retrievalCache = new Map();
const navigationCache = new Map();
const rateLimitBuckets = new Map();

function shouldUseLiveNavigation(message) {
  const lower = String(message || "").toLowerCase();
  if (!lower) return false;
  const triggers = [
    "check website",
    "on your website",
    "from your site",
    "latest",
    "current",
    "now",
    "today",
    "link",
    "page",
    "where can i find",
    "clientes",
    "empresas",
    "casos de exito",
    "casos de éxito",
    "han trabajado",
    "con quien",
  ];
  return triggers.some((t) => lower.includes(t));
}

function fromCache(cache, key, ttlMs) {
  const row = cache.get(key);
  if (!row) return null;
  if (Date.now() - row.ts > ttlMs) {
    cache.delete(key);
    return null;
  }
  return row.value;
}

function toCache(cache, key, value) {
  cache.set(key, { ts: Date.now(), value });
  if (cache.size > MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

const AGENT_VISITOR_LIMIT_PER_MIN = 30;

function checkAgentRateLimit(businessId, visitorKey) {
  const key = `${businessId}:${visitorKey}`;
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key) || [];
  const recent = bucket.filter((t) => now - t < 60_000);
  if (recent.length >= AGENT_VISITOR_LIMIT_PER_MIN) {
    rateLimitBuckets.set(key, recent);
    return false;
  }
  recent.push(now);
  rateLimitBuckets.set(key, recent);
  if (rateLimitBuckets.size > MAX_CACHE_SIZE) {
    const firstKey = rateLimitBuckets.keys().next().value;
    rateLimitBuckets.delete(firstKey);
  }
  return true;
}


function getRequestLanguage(req, businessProfile, userMessage) {
  const messageLang = detectMessageLanguage(userMessage || "", "");
  if (messageLang) return messageLang;
  return detectPrimaryLanguage(businessProfile);
}

function traceLog(payload) {
  if (!TRACE_MODE) return;
  try {
    console.log("TRACE_MODE", payload);
  } catch (_) {
    // best effort
  }
}


function selectRelevantPage(evidence, userIntent) {
  if (!Array.isArray(evidence) || evidence.length === 0) return null;

  const intentToPageTypes = {
    contact: ["contact"],
    quote: ["contact"],
    purchase: ["contact"],
    service_question: ["services"],
    product_search: ["product", "catalog"],
    general_question: null,
  };

  const preferredTypes = intentToPageTypes[userIntent] || null;
  if (preferredTypes) {
    const match = evidence.find(
      (e) => e?.url && preferredTypes.includes(String(e.pageType || "").toLowerCase()),
    );
    if (match) return match.url;

    // For services: if no pageType "services", prefer URLs/excerpts about services (not catalog).
    if (userIntent === "service_question") {
      const serviceCues = ["servicio", "services", "que hacemos", "qué hacemos", "what we do", "nuestros servicios"];
      const byServiceRelevance = evidence.filter((e) => {
        if (!e?.url) return false;
        const u = String(e.url).toLowerCase();
        const ex = String(e.excerpt || "").toLowerCase();
        return serviceCues.some((c) => u.includes(c) || ex.includes(c));
      });
      if (byServiceRelevance.length > 0) return byServiceRelevance[0].url;
      const aboutPage = evidence.find(
        (e) => e?.url && String(e.pageType || "").toLowerCase() === "about",
      );
      if (aboutPage) return aboutPage.url;
    }
  }

  return evidence[0]?.url || null;
}

function scoreProductsByRelevance(products, userMessage) {
  if (!products || products.length === 0) return [];

  const message = userMessage.toLowerCase();
  const tokens = message.split(/\s+/).filter(Boolean);

  return products
    .map((p) => {
      let score = 0;

      const title = (p.title || "").toLowerCase();
      const desc = (p.description || "").toLowerCase();

      for (const token of tokens) {
        if (title.includes(token)) score += 2;
        if (desc.includes(token)) score += 1;
      }

      return { ...p, _relevanceScore: score };
    })
    .sort((a, b) => b._relevanceScore - a._relevanceScore);
}

const productEmbeddingCache = new Map();
const PRODUCT_EMBEDDING_TTL_MS = 24 * 60 * 60 * 1000;

async function scoreProductsSemantic(products, userMessage) {
  if (!products || products.length === 0) return [];

  const clientModule = require("../services/websiteContextService");
  const getEmbedding = clientModule.getEmbedding;
  const getEmbeddingBatch = clientModule.getEmbeddingBatch;
  const cosineSimilarity = clientModule.cosineSimilarity;
  const getEmbeddingClient = clientModule.getEmbeddingClient;

  if (
    !getEmbeddingClient ||
    !getEmbedding ||
    !getEmbeddingBatch ||
    !cosineSimilarity
  ) {
    return products.map((p) => ({ ...p, similarity: 0 }));
  }

  const client = getEmbeddingClient();
  if (!client) return products.map((p) => ({ ...p, similarity: 0 }));

  const msgEmbedding = await getEmbedding(userMessage);
  if (!Array.isArray(msgEmbedding) || msgEmbedding.length === 0) {
    return products.map((p) => ({ ...p, similarity: 0 }));
  }

  const now = Date.now();
  const uncachedIndices = [];
  const embeddings = new Array(products.length);

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const cacheKey = `${p.page_url || p.title || i}`;
    const cached = productEmbeddingCache.get(cacheKey);
    if (cached && now - cached.ts < PRODUCT_EMBEDDING_TTL_MS) {
      embeddings[i] = cached.vec;
    } else {
      uncachedIndices.push(i);
    }
  }

  if (uncachedIndices.length > 0) {
    const uncachedInputs = uncachedIndices.map(
      (i) => `${products[i].title || ""} ${products[i].description || ""}`.trim(),
    );
    const batchResults = await getEmbeddingBatch(uncachedInputs);
    for (let j = 0; j < uncachedIndices.length; j++) {
      const idx = uncachedIndices[j];
      const vec = batchResults[j];
      embeddings[idx] = vec;
      if (Array.isArray(vec)) {
        const p = products[idx];
        const cacheKey = `${p.page_url || p.title || idx}`;
        productEmbeddingCache.set(cacheKey, { ts: now, vec });
        if (productEmbeddingCache.size > MAX_CACHE_SIZE) {
          const firstKey = productEmbeddingCache.keys().next().value;
          productEmbeddingCache.delete(firstKey);
        }
      }
    }
  }

  return products
    .map((p, i) => {
      const prodEmbedding = embeddings[i];
      const semantic =
        Array.isArray(prodEmbedding) && prodEmbedding.length === msgEmbedding.length
          ? cosineSimilarity(msgEmbedding, prodEmbedding)
          : 0;
      return { ...p, similarity: semantic };
    })
    .sort((a, b) => b.similarity - a.similarity);
}

/* ========= SITE-WIDE HELP AGENT (must be before :businessId) ========= */

/**
 * GET /agent/site-help/welcome
 * Welcome message for the site help widget (shown on every page).
 */
router.get("/site-help/welcome", (req, res) => {
  res.json({
    welcomeMessage: "Hi, I'm YIGO. How can I help you today?",
  });
});

/**
 * POST /agent/site-help
 * Body: { message, history?: [{ role, content }] }
 * Returns: { reply }
 */
router.post("/site-help", async (req, res) => {
  try {
    const siteHelpKey = process.env.SITE_HELP_API_KEY;
    if (siteHelpKey && req.headers["x-site-help-key"] !== siteHelpKey) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { message, history } = req.body || {};
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Message required" });
    }
    if (message.length > AI_MESSAGE_MAX_LENGTH) {
      return res.status(400).json({ error: "Message too long" });
    }
    if (isPromptInjection(message)) {
      logSecurityEvent("blocked_prompt_injection", { ip: req.ip, endpoint: "/agent/site-help", promptPreview: String(message || "").replace(/\s+/g, " ").trim().slice(0, 200), timestamp: new Date().toISOString() });
      return res.json({ reply: SAFE_REFUSAL_MESSAGE });
    }
    const historyCapped = (Array.isArray(history) ? history : []).slice(-20);
    let reply = await generateSiteHelpReply(message.trim(), historyCapped);
    if (isResponseLeakingSecrets(String(reply || ""))) {
      logSecurityEvent("ai_abuse_attempt", { type: "sensitive_data_request", ip: req.ip, endpoint: "/agent/site-help", timestamp: new Date().toISOString() });
      reply = SAFE_FALLBACK_MESSAGE;
    }
    res.json({ reply });
  } catch (err) {
    if (err && err.code === "AI_QUEUE_FULL") {
      return res.status(503).json({ error: "Service temporarily busy. Please try again shortly." });
    }
    console.error("SITE HELP ERROR:", err.message || err);
    res
      .status(500)
      .json({ error: "Something went wrong. Please try again." });
  }
});

/* ========= PUBLIC BUSINESS AGENT (widget on /b/:id) ========= */

/**
 * GET /agent/:businessId/welcome
 * Returns the initial greeting for the chat widget (AI first message).
 * Public agent conversations are scoped by business_id.
 */
router.get("/:businessId/welcome", async (req, res) => {
  try {
    const { businessId } = req.params;
    if (!isPositiveInt(businessId)) {
      return res.status(400).json({ error: "Invalid business ID" });
    }

    const result = await pool.query(
      `SELECT bp.*, u.is_paid, u.subscription_status
       FROM business_profiles bp
       JOIN users u ON bp.user_id = u.id
       WHERE bp.id = $1`,
      [businessId],
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Not found" });
    }

    const businessProfile = result.rows[0];

    if (businessProfile.subscription_status !== "active") {
      return res.status(404).json({ error: "Not found" });
    }

    const websiteLanguage = detectPrimaryLanguage(businessProfile);
    const greeting = generateInitialGreeting(businessProfile, { language: websiteLanguage });
    const contextLine = getWelcomeContextLine(businessProfile.website_type, websiteLanguage);
    const welcomeMessage = contextLine ? `${greeting} ${contextLine}` : greeting;
    res.json({
      welcomeMessage,
      businessName: businessProfile.business_name || null,
    });
  } catch (err) {
    console.error("AGENT WELCOME ERROR:", err);
    try {
      const { businessId } = req.params;
      const fallbackResult = await pool.query(
        "SELECT detected_language, language FROM business_profiles WHERE id = $1",
        [businessId],
      );
      if (fallbackResult.rows.length) {
        const lang = fallbackResult.rows[0].detected_language || fallbackResult.rows[0].language || "en";
        const fallbackGreeting = generateInitialGreeting({ ai_agent_name: "Aira", detected_language: lang, language: lang });
        return res.json({ welcomeMessage: fallbackGreeting });
      }
    } catch (_) {
      // DB also failed, fall through to English default
    }
    res.json({ welcomeMessage: "Hi, how can I help you today?" });
  }
});

router.post("/:businessId", async (req, res) => {
  const reqStart = Date.now();
  try {
    const { businessId } = req.params;
    if (!isPositiveInt(businessId)) {
      return res.status(400).json({ error: "Invalid business ID" });
    }
    const { message, conversationId, visitorId } = req.body;

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return res.status(400).json({ error: "Message required" });
    }
    if (message.length > AI_MESSAGE_MAX_LENGTH) {
      return res.status(400).json({ error: "Message too long" });
    }
    if (conversationId !== undefined && conversationId !== null && !isPositiveInt(conversationId)) {
      return res.status(400).json({ error: "Invalid conversation ID" });
    }
    const visitorKey = visitorId || req.ip || "anon";
    if (!checkAgentRateLimit(businessId, visitorKey)) {
      logSecurityEvent("suspicious_activity", { type: "rapid_endpoint_usage", ip: req.ip, businessId, visitorId: visitorId || null, endpoint: "/agent", timestamp: new Date().toISOString() });
      return res.status(429).json({ error: "Too many requests" });
    }
    if (checkReplaySpam(`${businessId}:${visitorKey}`, message)) {
      logSecurityEvent("ai_abuse_attempt", { type: "spam", visitorId: visitorId || null, businessId, ip: req.ip, promptPreview: String(message || "").replace(/\s+/g, " ").trim().slice(0, 200), timestamp: new Date().toISOString() });
      return res.status(429).json({ error: "Too many requests" });
    }
    if (isPromptInjection(message)) {
      logSecurityEvent("blocked_prompt_injection", { ip: req.ip, businessId, visitorId: visitorId || null, promptPreview: String(message || "").replace(/\s+/g, " ").trim().slice(0, 200), timestamp: new Date().toISOString() });
      logSecurityEvent("ai_abuse_attempt", { type: "prompt_injection", visitorId: visitorId || null, businessId, ip: req.ip, timestamp: new Date().toISOString() });
      return res.json({ reply: SAFE_REFUSAL_MESSAGE, conversationId: null });
    }

    let businessProfile = null;
    if (redis.REDIS_URL) {
      try {
        businessProfile = await redis.cacheGet("bp:" + businessId);
      } catch (_) {}
    }
    if (!businessProfile) {
      const result = await pool.query(
        `SELECT bp.*, u.is_paid, u.subscription_status
         FROM business_profiles bp
         JOIN users u ON bp.user_id = u.id
         WHERE bp.id = $1`,
        [businessId],
      );
      if (!result.rows.length) {
        return res.status(404).json({ error: "Not found" });
      }
      businessProfile = result.rows[0];
      if (redis.REDIS_URL) {
        redis.cacheSet("bp:" + businessId, businessProfile, 45).catch(() => {});
      }
    }
    if (!businessProfile) {
      return res.status(404).json({ error: "Not found" });
    }
    const liveNavForBusiness =
      typeof businessProfile.live_nav_enabled === "boolean"
        ? businessProfile.live_nav_enabled
        : ENABLE_LIVE_NAV;

    if (businessProfile.subscription_status !== "active") {
      return res.status(404).json({ error: "Not found" });
    }

    // Run independent DB queries in parallel for speed
    const [knowledgeResult, convIdResolved, productsData] = await Promise.all([
      pool.query("SELECT * FROM business_knowledge WHERE user_id = $1 LIMIT 1", [businessProfile.user_id]),
      (async () => {
        let cid = conversationId;
        if (cid) {
          const existingConv = await pool.query(
            `SELECT id, updated_at, created_at
             FROM conversations
             WHERE id = $1 AND business_id = $2`,
            [cid, businessId],
          );
          if (!existingConv.rows.length) {
            cid = null;
          } else {
            const lastActivity = new Date(
              existingConv.rows[0].updated_at || existingConv.rows[0].created_at
            );
            const ageMs = Date.now() - lastActivity.getTime();
            const STALE_MS = 60 * 60 * 1000;
            if (ageMs > STALE_MS) {
              cid = null;
            }
          }
        }
        if (!cid) {
          const convResult = await pool.query(
            "INSERT INTO conversations (business_id, visitor_id) VALUES ($1, $2) RETURNING id",
            [businessId, visitorId || null],
          );
          cid = convResult.rows[0].id;
        }
        return cid;
      })(),
      (async () => {
        let prods = [];
        let total = 0;
        if (redis.REDIS_URL) {
          try {
            const cached = await redis.cacheGet("products:" + businessId);
            if (cached && Array.isArray(cached.products)) {
              return { products: cached.products, totalProductCount: Number(cached.totalProductCount) || 0 };
            }
          } catch (_) {}
        }
        try {
          const countResult = await pool.query(
            "SELECT COUNT(*)::int AS count FROM business_products WHERE business_id = $1",
            [businessId],
          );
          total = Number(countResult.rows?.[0]?.count) || 0;
          const productsResult = await pool.query(
            "SELECT title, description, price, image_url, page_url FROM business_products WHERE business_id = $1 ORDER BY id LIMIT 120",
            [businessId],
          );
          prods = productsResult.rows || [];
          if (redis.REDIS_URL) {
            redis.cacheSet("products:" + businessId, { products: prods, totalProductCount: total }, 60).catch(() => {});
          }
        } catch (_) {}
        return { products: prods, totalProductCount: total };
      })(),
    ]);

    const knowledge = knowledgeResult.rows[0] || null;
    const effectiveWebsiteUrl = businessProfile.website_url || knowledge?.website_url || null;
    let convId = convIdResolved;
    let products = productsData.products;
    let totalProductCount = productsData.totalProductCount;

    // Load history BEFORE inserting the current user message to avoid race condition
    const [historyResult, persistentMemory] = await Promise.all([
      pool.query(
        `SELECT sender, content FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [convId],
      ),
      getPersistentVisitorMemory(Number(businessId), visitorId || null, getBusinessMemoryConfig(businessProfile)),
    ]);

    pool.query(
      "INSERT INTO messages (conversation_id, sender, content) VALUES ($1, 'user', $2)",
      [convId, message],
    ).catch(() => {});

    const conversationHistory = (historyResult.rows || [])
      .reverse()
      .slice(-20)
      .map((m) => ({
        role: m.sender === "ai" ? "assistant" : "user",
        content: m.content,
      }));

    function dedupeRepeatedQuestions(history, currentMessage) {
      if (!Array.isArray(history) || history.length === 0) return history;

      const currentNorm = String(currentMessage || "")
        .toLowerCase()
        .replace(/[^a-z0-9áéíóúñüàâçèêëîïôùûü\s]/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

      function normalize(text) {
        return String(text || "")
          .toLowerCase()
          .replace(/[^a-z0-9áéíóúñüàâçèêëîïôùûü\s]/gi, " ")
          .replace(/\s+/g, " ")
          .trim();
      }

      function similarity(a, b) {
        const aTokens = new Set(a.split(" ").filter(t => t.length > 2));
        const bTokens = new Set(b.split(" ").filter(t => t.length > 2));
        if (!aTokens.size || !bTokens.size) return 0;
        let overlap = 0;
        for (const t of aTokens) { if (bTokens.has(t)) overlap++; }
        return overlap / Math.max(aTokens.size, bTokens.size);
      }

      const cleaned = [];
      let i = 0;
      while (i < history.length) {
        const msg = history[i];
        if (msg.role === "user") {
          const norm = normalize(msg.content);
          const sim = similarity(norm, currentNorm);
          if (sim >= 0.8) {
            i++;
            if (i < history.length && history[i].role === "assistant") {
              i++;
            }
            continue;
          }
        }
        cleaned.push(msg);
        i++;
      }
      return cleaned;
    }

    const cleanedHistory = dedupeRepeatedQuestions(conversationHistory, message);

    // Phase 1 (deterministic): refine the user question for better retrieval,
    // without adding extra AI calls (no hallucination risk).
    const retrievalQuery = refineQueryDeterministic({ message, conversationHistory });

    const scoredProducts = await scoreProductsSemantic(products, retrievalQuery);
    const filteredProducts = scoredProducts
      .filter((p) => p.similarity >= 0.1)
      .slice(0, 5)
      .map(({ similarity, ...rest }) => rest);

    const memoryPromptContext = toPromptMemory(persistentMemory, {
      maxFacts: 8,
      maxChars: 800,
    });
    const sessionLanguage = getRequestLanguage(req, businessProfile, message);

    if (shouldAskCatalogNarrowing(message, totalProductCount)) {
      const catalogUrl = await discoverCatalogUrl(Number(businessId), businessProfile.website_url);
      const narrowingReply = getCatalogNarrowingQuestion(sessionLanguage, catalogUrl);
      pool.query(
        "INSERT INTO messages (conversation_id, sender, content) VALUES ($1, 'ai', $2)",
        [convId, narrowingReply],
      ).catch(() => {});
      recordAgentMetric("agent", {
        outcome: "grounded",
        latencyMs: Date.now() - reqStart,
        estimatedPromptChars: String(message || "").length,
        retrievalCacheHit: false,
      });
      return res.json({
        reply: narrowingReply,
        conversationId: convId,
      });
    }

    const isPlatformBusiness = PLATFORM_BUSINESS_ID && String(businessId) === PLATFORM_BUSINESS_ID;
    let websiteContext = { structured: "", raw: "", evidence: [], retrieval: {} };
    let retrievalCacheHit = false;
    try {
      const retrievalKey = `${businessId}:${String(retrievalQuery || "").trim().toLowerCase()}`;
      const cached = fromCache(retrievalCache, retrievalKey, RETRIEVAL_CACHE_TTL_MS);
      if (cached) {
        retrievalCacheHit = true;
        websiteContext = cached;
      } else {
        websiteContext = await getRelevantWebsiteContextFromPages(Number(businessId), retrievalQuery, 5);
        toCache(retrievalCache, retrievalKey, websiteContext);
      }
    } catch (_) {
      // leave websiteContext empty; blob fallback below may fill it
    }
    if (
      !(String(websiteContext.structured || "").trim()) &&
      !(String(websiteContext.raw || "").trim()) &&
      businessProfile.website_knowledge
    ) {
      try {
        const blobContext = getRelevantWebsiteContext(
          businessProfile.website_knowledge,
          retrievalQuery,
          5,
        );
        if (blobContext && (blobContext.structured || blobContext.raw)) {
          websiteContext.structured = blobContext.structured || "";
          websiteContext.raw = blobContext.raw || "";
        }
      } catch (_) {
        // keep existing empty context
      }
    }
    const retrievalTopScore = Number(websiteContext?.retrieval?.topScore) || 0;
    const manualFactsAvailable = Boolean(
      knowledge &&
      (knowledge.description ||
        knowledge.services ||
        knowledge.pricing ||
        knowledge.faqs ||
        knowledge.restrictions),
    );
    const retrievalIsWeak = retrievalTopScore < EVIDENCE_WEAK_THRESHOLD && !manualFactsAvailable;

    let liveNavStats = { used: false, reason: "disabled" };
    if (liveNavForBusiness && (shouldUseLiveNavigation(message) || retrievalIsWeak) && effectiveWebsiteUrl) {
      try {
        const navKey = `${businessId}:${String(retrievalQuery || "").trim().toLowerCase()}:${
          effectiveWebsiteUrl || ""
        }`;
        const cached = fromCache(navigationCache, navKey, NAV_CACHE_TTL_MS);
        const navContext =
          cached ||
          (await getLiveNavigationContext({
            businessId: Number(businessId),
            query: retrievalQuery,
            websiteUrl: effectiveWebsiteUrl,
            maxSteps: LIVE_NAV_MAX_STEPS,
            timeoutMs: LIVE_NAV_TIMEOUT_MS,
            totalBudgetMs: LIVE_NAV_TOTAL_BUDGET_MS,
          }));
        if (!cached) toCache(navigationCache, navKey, navContext);
        liveNavStats = navContext.stats || liveNavStats;
        if (navContext.structured) {
          websiteContext.structured = [
            websiteContext.structured || "",
            navContext.structured,
          ]
            .filter(Boolean)
            .join("\n\n---\n\n")
            .slice(0, 6000);
        }
        if (Array.isArray(navContext.evidence) && navContext.evidence.length > 0) {
          websiteContext.evidence = [
            ...(websiteContext.evidence || []),
            ...navContext.evidence,
          ];
        }
      } catch (_) {
        liveNavStats = { used: false, reason: "error" };
      }
    }

    const userIntent = detectUserIntent(message);

    const evidence = Array.isArray(websiteContext.evidence)
      ? websiteContext.evidence.map((e) => {
          const url = e && e.url;
          if (!url || typeof url !== "string" || !url.trim().startsWith("http")) {
            return { ...e, url: null };
          }
          return { ...e, url: url.trim() };
        })
      : [];
    if (manualFactsAvailable) {
      evidence.push({
        sourceId: "manual_knowledge",
        url: null,
        pageType: "manual",
        score: 1,
        excerpt: "Manual business knowledge provided by owner",
      });
    }
    if (filteredProducts.length > 0) {
      evidence.push({
        sourceId: "product_catalog",
        url: null,
        pageType: "products",
        score: 1,
        excerpt: "Business product catalog rows",
      });
    }

    // Force-include page by intent keywords
    let classifiedPages = [];
    try {
      const cpResult = await pool.query(
        "SELECT url, page_type, title, cleaned_content FROM business_website_pages WHERE business_id = $1 AND page_type IN ('pricing', 'contact', 'faq', 'about', 'services', 'product', 'location') LIMIT 20",
        [businessId],
      );
      classifiedPages = cpResult.rows || [];
    } catch (_) {}

    const forceIncludePage = getForceIncludePage(retrievalQuery, classifiedPages);
    if (forceIncludePage) {
      const alreadyIncluded = evidence.some(e => e.url === forceIncludePage.url);
      if (!alreadyIncluded && forceIncludePage.cleaned_content) {
        const fiContent = String(forceIncludePage.cleaned_content).trim().slice(0, 2000);
        if (fiContent) {
          websiteContext.structured = `[${forceIncludePage.page_type}] ${forceIncludePage.title || forceIncludePage.url}\n${fiContent}\n\n---\n\n${websiteContext.structured || ""}`;
          evidence.unshift({
            sourceId: "force_include",
            url: forceIncludePage.url,
            pageType: forceIncludePage.page_type,
            score: 2,
            excerpt: fiContent.slice(0, 260),
          });
        }
      }
    }

    let bestPageUrl = selectRelevantPage(evidence, userIntent);
    if (!bestPageUrl || !bestPageUrl.startsWith("http")) {
      bestPageUrl = null;
    }

    const contactEvidence = evidence.find(e => e.pageType === "contact" && e.url);
    const businessContact = contactEvidence
      ? contactEvidence.url
      : effectiveWebsiteUrl || "our team directly";

    const evidenceCount = evidence.length;
    const contextLength = String(websiteContext?.structured || "").length;
    traceLog({
      channel: "tenant_text",
      businessId,
      question: message,
      retrievalMode: websiteContext?.retrieval?.mode || "none",
      topRetrievalScore: retrievalTopScore,
      evidenceCount,
      contextLength,
    });

    // 3-tier evidence evaluation (per-business threshold)
    const cleanedEvidence = evidence.map(e => {
      if (!e) return e;
      const url = e.url;
      if (!url || typeof url !== 'string' || !url.trim().startsWith('http') || /</.test(url)) {
        return { ...e, url: null };
      }
      return e;
    });
    const strictGrounded = businessProfile.strict_grounded_enabled !== false;
    const strongThreshold = strictGrounded ? EVIDENCE_STRONG_THRESHOLD : 0.35;
    const { mode: evidenceMode } = evaluateEvidence(cleanedEvidence, strongThreshold);

    if (evidenceMode === "escalate" && !manualFactsAvailable) {
      const knowledgeBlob = [knowledge?.description, knowledge?.services, knowledge?.faqs].filter(Boolean).join(" ");
      const emailMatch = knowledgeBlob.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
      const phoneMatch = knowledgeBlob.match(/(?:\+?\d[\d\s\-()]{7,}\d)/);
      const escalationReply = getEscalationMessage(sessionLanguage, businessContact, {
        email: emailMatch ? emailMatch[0] : null,
        phone: phoneMatch ? phoneMatch[0] : null,
      });
      writeAuditLog({
        eventType: "agent_response",
        businessId: Number(businessId),
        conversationId: convId,
        visitorId: visitorId || null,
        outcome: "escalate",
        details: { channel: "text", reason: "insufficient_evidence" },
      });
      recordAgentMetric("agent", { outcome: "escalate", latencyMs: Date.now() - reqStart });
      addGroundedDebugLog({
        businessId,
        conversationId: convId,
        outcome: "escalate",
        reason: "insufficient_evidence",
        retrievalTopScore,
        evidenceCount,
        retrievalMode: websiteContext?.retrieval?.mode || "none",
      });
      pool.query(
        "INSERT INTO messages (conversation_id, sender, content) VALUES ($1, 'ai', $2)",
        [convId, escalationReply],
      ).catch(() => {});
      return res.json({
        reply: escalationReply,
        conversationId: convId,
      });
    }

    let businessSummary = "";
    try {
      businessSummary = await buildBusinessContextSummary(Number(businessId), businessProfile, knowledge);
    } catch (_) {}

    const replyOptions = {
      products: filteredProducts,
      platformKnowledgeBlock: isPlatformBusiness ? getPlatformKnowledgeBlock() : null,
      websiteContextStructured: websiteContext.structured,
      websiteContextRaw: websiteContext.raw,
      memoryContext: memoryPromptContext,
      evidenceHints: cleanedEvidence,
      evidenceMode,
      businessSummary,
      responseLanguage: sessionLanguage,
      businessContact,
      citationEnabled: businessProfile.citation_enabled === true,
      maxReplySources: Number(businessProfile.max_reply_sources) || 2,
      retrievalMeta: {
        mode: websiteContext?.retrieval?.mode || "none",
        score: retrievalTopScore,
        contextLength,
      },
    };

    const AI_HOURLY_LIMIT_PER_BUSINESS = Number(process.env.AI_HOURLY_LIMIT_PER_BUSINESS || 500);
    let businessAiCount = 0;
    if (redis.REDIS_URL) {
      businessAiCount = await redis.incrementAiUsageBusiness(businessId);
      if (businessAiCount > AI_HOURLY_LIMIT_PER_BUSINESS) {
        logSecurityEvent("ai_abuse_attempt", { type: "hourly_limit", businessId, count: businessAiCount, limit: AI_HOURLY_LIMIT_PER_BUSINESS, timestamp: new Date().toISOString() });
        return res.status(429).json({ error: "Too many requests. Please try again later." });
      }
    }

    let aiReply;
    try {
      aiReply = await generateSalesReply(
        businessProfile,
        message,
        knowledge,
        cleanedHistory,
        replyOptions,
      );
    } catch (err) {
      if (err && err.code === "AI_QUEUE_FULL") {
        return res.status(503).json({ error: "Service temporarily busy. Please try again shortly." });
      }
      console.error("PUBLIC AGENT ERROR:", err.message || err);
      aiReply = getEscalationMessage(sessionLanguage, businessContact);
    }

    let finalReply = aiReply;
    writeAuditLog({
      eventType: "agent_response",
      businessId: Number(businessId),
      conversationId: convId,
      visitorId: visitorId || null,
      outcome: evidenceMode,
      details: { channel: "text", evidenceMode, evidenceCount },
    });
    addGroundedDebugLog({
      businessId,
      conversationId: convId,
      outcome: evidenceMode,
      reason: "evaluated",
      retrievalTopScore,
      evidenceCount,
      retrievalMode: websiteContext?.retrieval?.mode || "none",
    });

    if (process.env.NODE_ENV !== "production") {
      console.log("AGENT_GROUNDED_LOG", {
        businessId,
        evidenceCount,
        retrievalTopScore,
        evidenceMode,
        retrievalMode: websiteContext?.retrieval?.mode || "none",
        liveNavUsed: !!liveNavStats.used,
        liveNavReason: liveNavStats.reason,
        liveNavVisited: liveNavStats.visitedCount || 0,
      });
    }
    finalReply = applyResponseLength(finalReply, message);
    finalReply = reduceRepetition(finalReply, cleanedHistory, sessionLanguage);
    if (isResponseLeakingSecrets(String(finalReply || ""))) {
      logSecurityEvent("ai_abuse_attempt", { type: "sensitive_data_request", visitorId: visitorId || null, businessId, ip: req.ip, timestamp: new Date().toISOString() });
      finalReply = SAFE_FALLBACK_MESSAGE;
    }

    const allowedUrls = (cleanedEvidence || [])
      .map((e) => e && e.url)
      .filter((u) => u && typeof u === "string" && u.startsWith("http"));
    if (Array.isArray(filteredProducts)) {
      for (const p of filteredProducts) {
        if (p.page_url && typeof p.page_url === "string" && p.page_url.startsWith("http")) {
          if (!allowedUrls.includes(p.page_url)) {
            allowedUrls.push(p.page_url);
          }
        }
      }
    }
    for (const page of classifiedPages) {
      if (page.url && typeof page.url === "string" && page.url.startsWith("http")) {
        if (!allowedUrls.includes(page.url)) {
          allowedUrls.push(page.url);
        }
      }
    }
    if (process.env.NODE_ENV !== 'production') {
      const suspiciousUrls = allowedUrls.filter(u => /<|%3C/.test(u));
      if (suspiciousUrls.length > 0) console.warn('[sanitizeReplyLinks] HTML in allowedUrls:', suspiciousUrls);
      if (bestPageUrl && /<|%3C/.test(bestPageUrl)) console.warn('[sanitizeReplyLinks] HTML in bestPageUrl:', bestPageUrl);
    }
    finalReply = sanitizeReplyLinks(finalReply, allowedUrls, bestPageUrl, sessionLanguage);
    finalReply = cleanText(finalReply);

    const isLeadIntent = hasHighBuyingIntent(message);
    const leadFields = extractLeadFields(message);
    const shouldPromptLead = shouldPromptLeadCapture(message, conversationHistory);
    if (shouldPromptLead && !responseAlreadyAsksForContact(finalReply)) {
      const leadPrompt = getLeadPrompt(sessionLanguage, !!leadFields.email);
      if (leadPrompt && !finalReply.toLowerCase().includes(leadPrompt.toLowerCase())) {
        finalReply = `${finalReply}\n\n${leadPrompt}`.trim();
      }
    }

    // Save AI message, memory, and leads in background (don't block response)
    pool.query(
      "INSERT INTO messages (conversation_id, sender, content) VALUES ($1, 'ai', $2)",
      [convId, finalReply],
    ).catch(() => {});
    pool.query(
      "UPDATE conversations SET updated_at = NOW() WHERE id = $1",
      [convId],
    ).catch(() => {});

    const memoryText = buildMemoryFromConversation(
      persistentMemory,
      [...cleanedHistory, { role: "user", content: message }, { role: "assistant", content: finalReply }],
    );
    savePersistentVisitorMemory(
      Number(businessId),
      visitorId || null,
      memoryText,
      getBusinessMemoryConfig(businessProfile),
    ).catch(() => {});

    if (isLeadIntent || leadFields.email || leadFields.phone) {
      (async () => {
        try {
          const dupCheck = await pool.query(
            `SELECT id FROM leads WHERE business_id = $1 AND (email = $2 OR conversation_id = $3) LIMIT 1`,
            [Number(businessId), leadFields.email, convId],
          );
          if (dupCheck.rows.length === 0) {
            const name = (leadFields.name && String(leadFields.name).trim().slice(0, MAX_NAME_LENGTH)) || null;
            const email = (leadFields.email && String(leadFields.email).trim().slice(0, MAX_EMAIL_LENGTH)) || null;
            const phone = (leadFields.phone && String(leadFields.phone).trim().slice(0, MAX_PHONE_LENGTH)) || null;
            const leadMessage = String(message || "").slice(0, MAX_LEAD_MESSAGE_LENGTH);
            await pool.query(
              `INSERT INTO leads (user_id, business_id, conversation_id, name, email, phone, message, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'new')
               ON CONFLICT (business_id, conversation_id, email) DO NOTHING`,
              [businessProfile.user_id, Number(businessId), convId, name, email, phone, leadMessage],
            );
          }
        } catch (_) {}
      })();
    }

    const estimatedPromptChars =
      String(message || "").length +
      String(websiteContext?.structured || "").length +
      String(websiteContext?.raw || "").length +
      conversationHistory.reduce((sum, h) => sum + String(h.content || "").length, 0);
    recordAgentMetric("agent", {
      outcome: "grounded",
      latencyMs: Date.now() - reqStart,
      estimatedPromptChars,
      retrievalCacheHit,
    });
    traceLog({
      channel: "tenant_text",
      businessId,
      question: message,
      retrievalMode: websiteContext?.retrieval?.mode || "none",
      topRetrievalScore: retrievalTopScore,
      contextLength,
      finalPromptLengthEstimate:
        estimatedPromptChars + String(memoryPromptContext || "").length,
      postProcessingResult: finalReply.slice(0, 400),
      fallbackTriggered: false,
    });

    if (!res.headersSent) {
      res.json({
        reply: finalReply,
        conversationId: convId,
      });
    }
  } catch (err) {
    writeAuditLog({
      eventType: "agent_response",
      businessId: req.params?.businessId ? Number(req.params.businessId) : null,
      visitorId: req.body?.visitorId || null,
      outcome: "error",
      details: { channel: "text", message: err.message || "unknown_error" },
    });
    recordAgentMetric("agent", { error: true, latencyMs: Date.now() - reqStart });
    console.error("PUBLIC AGENT ERROR:", err);

    if (!res.headersSent) {
      res.status(500).json({ error: "Something went wrong. Please try again." });
    }
  }
});

module.exports = router;
