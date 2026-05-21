const pool = require("./db");

const LARGE_CATALOG_THRESHOLD = Number(
  process.env.AGENT_LARGE_CATALOG_THRESHOLD || 12,
);

function normalizeTokens(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9áéíóúñü]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function detectCatalogIntent(message) {
  const m = String(message || "").toLowerCase();
  if (!m) return false;
  const cues = [
    "products",
    "catalog",
    "options",
    "services",
    "what do you have",
    "what do you sell",
    "what do you offer",
    "show me",
    "list",
    "available",
    "offerings",
    "productos",
    "catalogo",
    "catálogo",
    "opciones",
    "servicios",
    "que tienen",
    "qué tienen",
    "que venden",
    "qué venden",
    "que ofrecen",
    "qué ofrecen",
    "mostrar",
  ];
  return cues.some((c) => m.includes(c));
}

function hasSpecificQualifier(message) {
  const tokens = normalizeTokens(message);
  if (tokens.length < 3) return false;
  const generic = new Set([
    "product",
    "products",
    "service",
    "services",
    "show",
    "list",
    "all",
    "have",
    "sell",
    "offer",
    "catalog",
    "options",
    "offerings",
    "precio",
    "precios",
    "producto",
    "productos",
    "servicio",
    "servicios",
    "catalogo",
    "catálogo",
    "mostrar",
    "lista",
    "todos",
    "tienen",
    "venden",
    "ofrecen",
  ]);
  const specificCount = tokens.filter((t) => !generic.has(t)).length;
  return specificCount >= 2;
}

function shouldAskCatalogNarrowing(message, totalProducts) {
  if (Number(totalProducts) < LARGE_CATALOG_THRESHOLD) return false;
  if (!detectCatalogIntent(message)) return false;
  return !hasSpecificQualifier(message);
}

/**
 * Discover the best catalog/product-listing URL from crawled pages.
 * Looks for pages whose URL or title suggests a product or service listing.
 * Falls back to the business website_url if nothing specific is found.
 */
async function discoverCatalogUrl(businessId, fallbackWebsiteUrl) {
  try {
    const result = await pool.query(
      `SELECT url, title FROM business_website_pages
       WHERE business_id = $1
       ORDER BY importance_score DESC NULLS LAST
       LIMIT 50`,
      [businessId],
    );
    const catalogPatterns = /\/(products|catalog|shop|store|services|offerings|tienda|productos|catalogo|servicios)(\/|$|\?)/i;
    const titlePatterns = /\b(products|catalog|shop|store|services|offerings|tienda|productos|catálogo|catalogo|servicios)\b/i;
    for (const row of (result.rows || [])) {
      if (catalogPatterns.test(row.url || "")) return row.url;
    }
    for (const row of (result.rows || [])) {
      if (titlePatterns.test(row.title || "")) return row.url;
    }
  } catch (_) {}
  return fallbackWebsiteUrl || null;
}

const CATALOG_NARROWING_TEMPLATES = {
  en: { with: (url) => `We have many options available. You can browse the full catalog here:\n${url}\n\nWhat type of product or service are you looking for? That way I can recommend something specific.`, without: "We have many options available. What type of product or service are you looking for? That way I can recommend something specific." },
  es: { with: (url) => `Tenemos muchas opciones disponibles. Puedes explorar el catálogo completo aquí:\n${url}\n\n¿Qué tipo de producto o servicio estás buscando? Así puedo recomendarte algo más específico.`, without: "Tenemos muchas opciones disponibles. ¿Qué tipo de producto o servicio estás buscando? Así puedo recomendarte algo más específico." },
  fr: { with: (url) => `Nous avons de nombreuses options disponibles. Vous pouvez parcourir le catalogue complet ici :\n${url}\n\nQuel type de produit ou service recherchez-vous ? Je pourrai ainsi vous recommander quelque chose de précis.`, without: "Nous avons de nombreuses options disponibles. Quel type de produit ou service recherchez-vous ? Je pourrai ainsi vous recommander quelque chose de précis." },
  de: { with: (url) => `Wir haben viele Optionen verfügbar. Den vollständigen Katalog finden Sie hier:\n${url}\n\nWelche Art von Produkt oder Dienstleistung suchen Sie? So kann ich Ihnen etwas Passendes empfehlen.`, without: "Wir haben viele Optionen verfügbar. Welche Art von Produkt oder Dienstleistung suchen Sie? So kann ich Ihnen etwas Passendes empfehlen." },
  pt: { with: (url) => `Temos muitas opções disponíveis. Você pode explorar o catálogo completo aqui:\n${url}\n\nQue tipo de produto ou serviço você está procurando? Assim posso recomendar algo mais específico.`, without: "Temos muitas opções disponíveis. Que tipo de produto ou serviço você está procurando? Assim posso recomendar algo mais específico." },
  it: { with: (url) => `Abbiamo molte opzioni disponibili. Puoi sfogliare il catalogo completo qui:\n${url}\n\nChe tipo di prodotto o servizio stai cercando? Così posso consigliarti qualcosa di specifico.`, without: "Abbiamo molte opzioni disponibili. Che tipo di prodotto o servizio stai cercando? Così posso consigliarti qualcosa di specifico." },
  zh: { with: (url) => `我们有很多选项可供选择。您可以在此浏览完整目录：\n${url}\n\n您在寻找哪种产品或服务？这样我可以为您推荐更具体的选择。`, without: "我们有很多选项可供选择。您在寻找哪种产品或服务？这样我可以为您推荐更具体的选择。" },
  ja: { with: (url) => `多くの選択肢をご用意しています。カタログ全体はこちらからご覧いただけます：\n${url}\n\nどのような商品やサービスをお探しですか？具体的なおすすめをご案内いたします。`, without: "多くの選択肢をご用意しています。どのような商品やサービスをお探しですか？具体的なおすすめをご案内いたします。" },
  ko: { with: (url) => `다양한 옵션이 있습니다. 전체 카탈로그는 여기에서 확인하실 수 있습니다:\n${url}\n\n어떤 종류의 제품이나 서비스를 찾고 계신가요? 더 구체적으로 추천해 드리겠습니다.`, without: "다양한 옵션이 있습니다. 어떤 종류의 제품이나 서비스를 찾고 계신가요? 더 구체적으로 추천해 드리겠습니다." },
  ar: { with: (url) => `لدينا العديد من الخيارات المتاحة. يمكنك تصفح الكتالوج الكامل هنا:\n${url}\n\nما نوع المنتج أو الخدمة التي تبحث عنها؟ حتى أتمكن من تقديم توصية أكثر تحديداً.`, without: "لدينا العديد من الخيارات المتاحة. ما نوع المنتج أو الخدمة التي تبحث عنها؟ حتى أتمكن من تقديم توصية أكثر تحديداً." },
  ru: { with: (url) => `У нас много доступных вариантов. Полный каталог можно посмотреть здесь:\n${url}\n\nКакой тип продукта или услуги вы ищете? Так я смогу порекомендовать что-то конкретное.`, without: "У нас много доступных вариантов. Какой тип продукта или услуги вы ищете? Так я смогу порекомендовать что-то конкретное." },
};

function getCatalogNarrowingQuestion(language, catalogUrl) {
  const tmpl = CATALOG_NARROWING_TEMPLATES[language] || CATALOG_NARROWING_TEMPLATES.en;
  return catalogUrl ? tmpl.with(catalogUrl) : tmpl.without;
}

module.exports = {
  shouldAskCatalogNarrowing,
  getCatalogNarrowingQuestion,
  discoverCatalogUrl,
  LARGE_CATALOG_THRESHOLD,
};
