const INTENT_TYPES = {
  PURCHASE: "purchase",
  QUOTE: "quote",
  CONTACT: "contact",
  PRODUCT_SEARCH: "product_search",
  SERVICE_QUESTION: "service_question",
  GENERAL_QUESTION: "general_question",
};

const PURCHASE_CUES = [
  "buy",
  "purchase",
  "order",
  "i need",
  "i want",
  "looking for",
  "looking to get",
  "quiero comprar",
  "necesito",
  "busco",
  "me interesa",
  "quisiera",
  "want to get",
  "where can i get",
  "como compro",
  "cómo compro",
  "donde compro",
  "dónde compro",
];

const QUOTE_CUES = [
  "price",
  "pricing",
  "cost",
  "how much",
  "quote",
  "estimate",
  "rates",
  "rate",
  "fee",
  "fees",
  "budget",
  "precio",
  "precios",
  "cotización",
  "cotizacion",
  "cuanto cuesta",
  "cuánto cuesta",
  "presupuesto",
  "tarifas",
  "tarifa",
];

const CONTACT_CUES = [
  "contact",
  "speak with someone",
  "speak to someone",
  "talk to someone",
  "talk to a person",
  "phone",
  "call me",
  "email me",
  "reach out",
  "representative",
  "sales rep",
  "hablar con alguien",
  "contactar",
  "contacto",
  "telefono",
  "teléfono",
  "llamar",
  "llámame",
  "llamame",
  "correo",
];

const PRODUCT_SEARCH_CUES = [
  "products",
  "catalog",
  "catalogue",
  "show me",
  "what do you sell",
  "what do you have",
  "what do you offer",
  "show products",
  "product list",
  "available",
  "productos",
  "catálogo",
  "catalogo",
  "que venden",
  "qué venden",
  "que tienen",
  "qué tienen",
  "que ofrecen",
  "qué ofrecen",
  "mostrar productos",
];

const SERVICE_QUESTION_CUES = [
  "services",
  "what do you do",
  "how does it work",
  "how do you work",
  "what can you do",
  "tell me about",
  "explain",
  "servicios",
  "que hacen",
  "qué hacen",
  "como funciona",
  "cómo funciona",
  "en que consiste",
  "en qué consiste",
];

/**
 * Detect the user's intent from their message using keyword heuristics.
 * Returns one of: purchase, quote, contact, product_search, service_question, general_question.
 */
function detectUserIntent(message) {
  const lower = String(message || "").toLowerCase();
  if (!lower) return INTENT_TYPES.GENERAL_QUESTION;

  const match = (cues) => cues.some((c) => lower.includes(c));

  if (match(PURCHASE_CUES)) return INTENT_TYPES.PURCHASE;
  if (match(QUOTE_CUES)) return INTENT_TYPES.QUOTE;
  if (match(CONTACT_CUES)) return INTENT_TYPES.CONTACT;
  if (match(PRODUCT_SEARCH_CUES)) return INTENT_TYPES.PRODUCT_SEARCH;
  if (match(SERVICE_QUESTION_CUES)) return INTENT_TYPES.SERVICE_QUESTION;

  return INTENT_TYPES.GENERAL_QUESTION;
}

module.exports = {
  detectUserIntent,
  INTENT_TYPES,
};
