const { detectUserIntent } = require("./intentService");

const PRONOUN_CUES = [
  " it ",
  " this ",
  " that ",
  " these ",
  " those ",
  " it’s ",
  " its ",
  " they ",
  " them ",
  " those ",
  " this one ",
  " that one ",
];

const FILLER_WORDS = [
  "please",
  "por favor",
  "quiero",
  "i want",
  "i need",
  "can you",
  "could you",
  "would you",
  "te puedo",
  "me puedes",
  "dime",
  "help",
  "ayuda",
];

function normalizeForSearch(raw) {
  const s = String(raw || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Keep punctuation that helps retrieval like ":" and "-" but drop heavy noise.
  return s.replace(/[^\p{L}\p{N}\s\-:?.!]/gu, " ");
}

function includesPronounCue(text) {
  const lower = ` ${String(text || "").toLowerCase()} `;
  return PRONOUN_CUES.some((cue) => lower.includes(cue));
}

function resolveShortContext({ message, conversationHistory }) {
  const msg = String(message || "");
  const history = Array.isArray(conversationHistory) ? conversationHistory : [];

  // If the message is short and refers to something earlier, prepend the last user message.
  if (msg.trim().length < 80 && includesPronounCue(msg) && history.length > 0) {
    const prevUser = [...history]
      .reverse()
      .find((m) => m && m.role === "user" && typeof m.content === "string" && m.content.trim() && m.content !== msg);
    if (prevUser && prevUser.content) {
      return `${prevUser.content} ${msg}`;
    }
  }
  return msg;
}

function addIntentKeywords(intentLabel, queryText) {
  const q = String(queryText || "").toLowerCase();

  const isSpanish = /[áéíóúñ¿¡]/.test(q) || /\b(qué|que|cómo|como|dónde|donde|cuánto|cuanto|tienen|tienes|puedo|quiero|necesito|botes|cuáles|cuales)\b/.test(q);
  const isFrench = /[àâçèêëîïôùûü]/.test(q) || /\b(quel|quelle|comment|où|combien|avez|voulez)\b/.test(q);
  const isGerman = /[äöüß]/.test(q) || /\b(was|wie|wo|haben|können|welche)\b/.test(q);
  const isPortuguese = /[ãõ]/.test(q) || /\b(qual|como|onde|quanto|têm|posso|quero)\b/.test(q);

  const lang = isSpanish ? "es" : isFrench ? "fr" : isGerman ? "de" : isPortuguese ? "pt" : "en";

  const INTENT_KEYWORDS = {
    purchase: {
      en: "buy purchase order price cost",
      es: "comprar compra precio costo pedido",
      fr: "acheter achat prix commander",
      de: "kaufen Preis bestellen",
      pt: "comprar preço pedido custo",
    },
    quote: {
      en: "quote pricing cost estimate",
      es: "cotización precio presupuesto costo",
      fr: "devis tarif estimation prix",
      de: "Angebot Preis Kosten",
      pt: "cotação preço orçamento",
    },
    contact: {
      en: "contact phone email reach",
      es: "contacto teléfono correo dirección",
      fr: "contact téléphone email adresse",
      de: "Kontakt Telefon Email Adresse",
      pt: "contato telefone email endereço",
    },
    product_search: {
      en: "product catalog items available",
      es: "producto catálogo artículos disponibles",
      fr: "produit catalogue articles disponibles",
      de: "Produkt Katalog Artikel verfügbar",
      pt: "produto catálogo itens disponíveis",
    },
    service_question: {
      en: "services offered what you do",
      es: "servicios ofrecen qué hacen",
      fr: "services offerts que faites-vous",
      de: "Dienstleistungen angeboten",
      pt: "serviços oferecidos o que fazem",
    },
    general_question: {
      en: "", es: "", fr: "", de: "", pt: "",
    },
  };

  const keywords = INTENT_KEYWORDS[intentLabel] || INTENT_KEYWORDS.general_question;
  return keywords[lang] || keywords.en || "";
}

function refineQueryDeterministic({ message, conversationHistory }) {
  const intentLabel = detectUserIntent(message);

  let resolved = resolveShortContext({ message, conversationHistory });
  resolved = normalizeForSearch(resolved);

  // Remove some common filler words to improve keyword search without changing meaning.
  for (const w of FILLER_WORDS) {
    resolved = resolved.replace(new RegExp(`\\b${w}\\b`, "gi"), " ");
  }
  resolved = resolved.replace(/\s+/g, " ").trim();

  // Add lightweight intent keywords so retrieval can more reliably pull the right website sections.
  resolved = `${resolved} ${addIntentKeywords(intentLabel, resolved)}`.replace(/\s+/g, " ").trim();

  // Hard cap to avoid extremely long retrieval queries.
  const MAX_QUERY_CHARS = 220;
  if (resolved.length > MAX_QUERY_CHARS) {
    resolved = resolved.slice(0, MAX_QUERY_CHARS).trim();
  }

  return resolved || String(message || "").trim();
}

module.exports = {
  refineQueryDeterministic,
};

