/**
 * Strip HTML and broken attributes from text. Use before returning AI reply to the client.
 * Does not modify or reconstruct URLs; only cleans plain text.
 */
function cleanText(input) {
  if (!input || typeof input !== "string") return input;
  return input
    .replace(/<(?!\/?a[\s>])[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function detectMessageLanguage(userMessage, fallbackLanguage = "en") {
  const msg = String(userMessage || "").trim();
  if (!msg) return fallbackLanguage;
  const lower = msg.toLowerCase();

  // Script-based detection (high confidence)
  if (/[\u4e00-\u9fff]/.test(msg)) return "zh";
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(msg)) return "ja";
  if (/[\uac00-\ud7af]/.test(msg)) return "ko";
  if (/[\u0600-\u06ff]/.test(msg)) return "ar";
  if (/[\u0900-\u097f]/.test(msg)) return "hi";
  if (/[\u0400-\u04ff]/.test(msg)) return "ru";

  // Portuguese (before Spanish — shares characters but has unique ones)
  if (/[ãõ]/.test(lower)) return "pt";
  const ptCues = ["você", "obrigado", "obrigada", "não", "também", "bom dia", "boa tarde", "boa noite"];
  if (ptCues.some((c) => lower.includes(c))) return "pt";

  // Spanish
  if (/[ñ¿¡]/.test(lower)) return "es";
  const esCues = ["hola", "precio", "servicio", "productos", "quiero", "necesito", "ayuda", "gracias", "cómo", "dónde", "cuánto", "buenas", "buenos días"];
  if (esCues.some((c) => lower.includes(c))) return "es";

  // German
  if (/[äöüß]/.test(lower)) return "de";
  const deCues = ["guten tag", "danke", "bitte", "ich möchte", "wie viel", "wo ist", "haben sie", "können sie"];
  if (deCues.some((c) => lower.includes(c))) return "de";

  // French
  const frCues = ["bonjour", "merci", "s'il vous plaît", "comment", "pourquoi", "je voudrais", "combien", "bonsoir", "au revoir"];
  if (frCues.some((c) => lower.includes(c))) return "fr";
  if (/[àâæçèêëïîôœùûü]/.test(lower) && !esCues.some((c) => lower.includes(c))) return "fr";

  // Italian
  const itCues = ["buongiorno", "buonasera", "grazie", "vorrei", "quanto costa", "dov'è", "per favore", "prego", "arrivederci"];
  if (itCues.some((c) => lower.includes(c))) return "it";

  // English (positive detection)
  const enTokens = lower.split(/\s+/);
  const enCues = ["the", "is", "are", "what", "how", "where", "when", "can", "would", "please", "thank", "hello", "want", "need", "looking"];
  if (enCues.filter((c) => enTokens.includes(c)).length >= 2) return "en";

  // If uncertain, preserve whatever language the AI was using rather than defaulting to English
  return fallbackLanguage || "en";
}

function detectDesiredDepth(userMessage) {
  const msg = String(userMessage || "").toLowerCase();
  if (!msg) return "short";
  if (
    msg.includes("detailed") ||
    msg.includes("in depth") ||
    msg.includes("step by step") ||
    msg.includes("explain more") ||
    msg.includes("detallado") ||
    msg.includes("detalle") ||
    msg.includes("paso a paso")
  ) {
    return "long";
  }
  if (
    msg.includes("compare") ||
    msg.includes("difference") ||
    msg.includes("pros and cons") ||
    msg.includes("comparar") ||
    msg.includes("diferencia")
  ) {
    return "medium";
  }
  // Only extremely short messages should be classified as "short"
  return msg.length <= 40 ? "short" : "medium";
}

function applyResponseLength(reply, userMessage) {
  const text = String(reply || "").trim();
  if (!text) return text;
  const depth = detectDesiredDepth(userMessage);
  const sentenceLimit = depth === "short" ? 8 : depth === "medium" ? 11 : 12;
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (parts.length <= sentenceLimit) return text;

  let cutIndex = sentenceLimit;
  const joined = parts.slice(0, cutIndex).join(" ");
  const LIST_ITEM_RE = /^(\s*[-*•]|\s*\d+[.)]\s)/;
  const remainingPart = parts[cutIndex];
  if (remainingPart && LIST_ITEM_RE.test(remainingPart)) {
    for (let i = cutIndex; i < parts.length; i++) {
      if (!LIST_ITEM_RE.test(parts[i])) { cutIndex = i; break; }
      if (i === parts.length - 1) { cutIndex = parts.length; break; }
    }
  } else if (LIST_ITEM_RE.test(joined.split("\n").pop() || "")) {
    for (let i = cutIndex - 1; i >= 0; i--) {
      const line = parts[i];
      if (!LIST_ITEM_RE.test(line)) { cutIndex = i + 1; break; }
    }
  }

  return parts.slice(0, cutIndex).join(" ").trim();
}

function reduceRepetition(candidateReply, conversationHistory, language) {
  return String(candidateReply || "").trim();
}

/**
 * Normalize URL for comparison: trim, lowercase, strip trailing slash.
 * Returns null if invalid or not external (must start with http).
 */
function normalizeUrlForComparison(url) {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed || !trimmed.startsWith("http")) return null;
  if (/<|>|%3C|%3E/i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    let normalized = u.href;
    if (normalized.endsWith("/") && u.pathname !== "/") {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch (_) {
    return null;
  }
}

const RAW_URL_REGEX = /https?:\/\/[^\s"'<>()]+/g;

/**
 * Sanitize reply so only allowed URLs appear in links. Invalid <a href="..."> are
 * replaced with bestPageUrl (if provided) or inner text. Raw URLs in allowed set
 * are converted to clickable <a> tags; others are removed or replaced with bestPageUrl.
 * @param {string} reply - AI reply (may contain HTML anchor tags and raw URLs)
 * @param {string[]} allowedUrls - List of URLs from evidence (backend-controlled)
 * @param {string|null} [bestPageUrl] - If provided, invalid links are replaced with this URL
 * @param {string} [language] - "es" for Spanish link text ("Ver más"), else "Learn more"
 * @returns {string}
 */
function sanitizeReplyLinks(reply, allowedUrls, bestPageUrl = null, language = "en") {
  let text = String(reply || "").trim();
  if (!text) return text;

  const allowed = new Set(
    (Array.isArray(allowedUrls) ? allowedUrls : [])
      .filter((u) => u && typeof u === "string" && u.startsWith("http"))
      .map(normalizeUrlForComparison)
      .filter(Boolean),
  );

  const replaceWith =
    bestPageUrl &&
    typeof bestPageUrl === "string" &&
    bestPageUrl.startsWith("http") &&
    normalizeUrlForComparison(bestPageUrl)
      ? bestPageUrl
      : null;

  const LEARN_MORE_MAP = {
    en: "Learn more", es: "Ver más", fr: "En savoir plus", de: "Mehr erfahren",
    pt: "Saiba mais", it: "Scopri di più", zh: "了解更多", ja: "詳しくはこちら",
    ko: "자세히 보기", ar: "اعرف المزيد", ru: "Подробнее",
  };
  const HERE_MAP = {
    en: "here", es: "aquí", fr: "ici", de: "hier",
    pt: "aqui", it: "qui", zh: "这里", ja: "こちら",
    ko: "여기", ar: "هنا", ru: "здесь",
  };
  const lang = (language || "en").toLowerCase().slice(0, 2);
  const linkTextStandalone = LEARN_MORE_MAP[lang] || LEARN_MORE_MAP.en;
  const linkTextInline = HERE_MAP[lang] || HERE_MAP.en;

  function buildLink(url, label) {
    const safeUrl = String(url).replace(/&amp;/g, "&").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const safeLabel = String(label || linkTextStandalone).replace(/<[^>]*>/g, "").replace(/"/g, "").trim() || linkTextStandalone;
    return `<a href="${safeUrl}" target="_blank" rel="noopener">${safeLabel}</a>`;
  }

  function resolveUrl(url) {
    const norm = normalizeUrlForComparison(url);
    if (!norm) return null;
    if (allowed.has(norm)) return url;
    if (allowed.size > 0) {
      try {
        const urlHost = new URL(norm).hostname;
        const allowedHosts = new Set(
          [...allowed]
            .map(u => { try { return new URL(u).hostname; } catch (_) { return null; } })
            .filter(Boolean)
        );
        if (allowedHosts.has(urlHost)) return url;
      } catch (_) {}
    }
    if (replaceWith) return replaceWith;
    return null;
  }

  // PASS 1: Process existing HTML <a> tags and replace with placeholders
  const protectedLinks = [];
  function protect(tag) {
    const idx = protectedLinks.length;
    protectedLinks.push(tag);
    return `%%SAFELINK_${idx}%%`;
  }

  text = text.replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (match, href, inner) => {
    const safeInner = String(inner || "").replace(/<[^>]*>/g, "").replace(/"/g, "").trim();
    const hrefClean = String(href || "").trim();
    if (!hrefClean.startsWith("http") || /<|%3C/.test(hrefClean)) {
      return safeInner;
    }
    const resolved = resolveUrl(hrefClean);
    if (resolved) {
      return protect(buildLink(resolved, safeInner || linkTextStandalone));
    }
    if (allowed.size === 0 && hrefClean.startsWith("http")) {
      return protect(buildLink(hrefClean, safeInner || linkTextStandalone));
    }
    return safeInner;
  });

  // PASS 2: Convert markdown links [text](url) to validated HTML, then protect
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (match, mdText, url) => {
    const safeText = String(mdText || "").replace(/<[^>]*>/g, "").replace(/["']/g, "").trim() || linkTextStandalone;
    const resolved = resolveUrl(url);
    if (resolved) {
      return protect(buildLink(resolved, safeText));
    }
    return safeText;
  });

  // PASS 3: Convert remaining raw URLs — placeholders are immune since %%SAFELINK_N%% contains no http
  text = text.replace(/https?:\/\/[^\s"'<>()\]]+/g, (url, offset, full) => {
    const cleanUrl = url.replace(/[.,;:!?]+$/, "");
    const before = full.slice(Math.max(0, offset - 1), offset);
    const after = full.slice(offset + url.length, offset + url.length + 2);
    const midSentence = /\w/.test(before) && /\w/.test(after);
    const chosenLabel = midSentence ? linkTextInline : linkTextStandalone;
    const resolved = resolveUrl(cleanUrl);
    if (resolved) {
      return protect(buildLink(resolved, chosenLabel));
    }
    return "";
  });

  // Restore all protected links
  text = text.replace(/%%SAFELINK_(\d+)%%/g, (_, idx) => protectedLinks[Number(idx)] || "");

  return text.replace(/\s{2,}/g, " ").replace(/\n\s*\n\s*\n/g, "\n\n").trim();
}

module.exports = {
  detectMessageLanguage,
  applyResponseLength,
  reduceRepetition,
  sanitizeReplyLinks,
  cleanText,
};
