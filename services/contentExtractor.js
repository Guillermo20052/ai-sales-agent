/**
 * Content extraction: main content area, JSON-LD, business info, heuristics.
 * Generic — no hardcoded selectors; works for any business site.
 */

const cheerio = require("cheerio");
const { URL } = require("url");

const PRICE_REGEX = /(\$|USD|MXN|€|EUR)\s*[\d,]+(?:\.\d{2})?|\$[\d,]+(?:\.\d{2})?|[\d,]+\s*(?:USD|MXN|€|EUR)/gi;
const JUNK_PATTERNS = /\b(privacy|cookie|terms|conditions|legal|disclaimer)\b/i;
const MIN_MEANINGFUL_LENGTH = 30;
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_CLEANED_CONTENT_CHARS = 5000;
const MIN_BODY_LENGTH_JS_RENDERED = 500;

/**
 * Clean extracted content: whitespace, dedupe, junk filter, length limit.
 * Improved: limit to MAX_DESCRIPTION_CHARS (2000).
 */
function cleanExtractedContent(text) {
  if (!text || typeof text !== "string") return "";
  let s = text
    .replace(/\s+/g, " ")
    .replace(/\n\s*\n/g, "\n\n")
    .trim();
  if (s.length < MIN_MEANINGFUL_LENGTH) return "";
  if (JUNK_PATTERNS.test(s)) return "";

  const paragraphs = s
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= MIN_MEANINGFUL_LENGTH && !JUNK_PATTERNS.test(p));
  const seen = new Set();
  const unique = [];
  for (const p of paragraphs) {
    const key = p.slice(0, 80).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  const joined = unique.join("\n\n").trim();
  return joined.length > MAX_DESCRIPTION_CHARS ? joined.substring(0, MAX_DESCRIPTION_CHARS) : joined;
}

/**
 * Parse JSON-LD scripts and extract Product, Service, Offer, LocalBusiness.
 * @param {string} html
 * @param {string} pageUrl - base URL for resolving relative image/url
 * @returns {Array<{ name?: string, description?: string, price?: string, image?: string, url?: string, sku?: string, brand?: string }>}
 */
function extractJsonLd(html, pageUrl) {
  const results = [];
  if (!html || typeof html !== "string") return results;

  const $ = cheerio.load(html, { decodeEntities: true });
  const baseOrigin = (() => {
    try {
      return new URL(pageUrl).origin;
    } catch {
      return "";
    }
  })();

  function resolveUrl(val) {
    if (!val || typeof val !== "string") return null;
    if (val.startsWith("http")) return val;
    try {
      return new URL(val, baseOrigin).href;
    } catch {
      return val;
    }
  }

  function normalize(item) {
    if (!item || typeof item !== "object") return null;
    const name = item.name || item.title || null;
    const description = item.description || null;
    let price = null;
    let image = (item.image && (Array.isArray(item.image) ? item.image[0] : item.image)) || null;
    if (typeof image === "object" && image && image.url) image = image.url;
    if (typeof image === "string") image = resolveUrl(image);

    if (item.offers && typeof item.offers === "object") {
      const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
      const first = offers[0];
      if (first && (first.price !== undefined || first.lowPrice !== undefined)) {
        const p = first.price ?? first.lowPrice;
        if (typeof p === "number") price = String(p);
        else if (typeof p === "string") price = p;
      }
    }
    if (item.price !== undefined && price == null) {
      if (typeof item.price === "number") price = String(item.price);
      else if (typeof item.price === "string") price = item.price;
    }

    const url = item.url ? resolveUrl(item.url) : pageUrl;
    const sku = item.sku || null;
    const brand = typeof item.brand === "object" && item.brand && item.brand.name
      ? item.brand.name
      : (typeof item.brand === "string" ? item.brand : null);

    if (!name && !description && !price && !image) return null;
    return { name, description, price, image, url, sku, brand };
  }

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html();
    if (!raw) return;
    try {
      let data = JSON.parse(raw.trim());
      if (Array.isArray(data)) {
        data.forEach((d) => {
          const type = (d["@type"] || "").toLowerCase();
          if (["product", "service", "offer", "localbusiness"].some((t) => type.includes(t))) {
            const n = normalize(d);
            if (n) results.push(n);
          }
          if (d["@graph"] && Array.isArray(d["@graph"])) {
            d["@graph"].forEach((g) => {
              const gt = (g["@type"] || "").toLowerCase();
              if (["product", "service", "offer", "localbusiness"].some((t) => gt.includes(t))) {
                const n = normalize(g);
                if (n) results.push(n);
              }
            });
          }
        });
      } else {
        const type = (data["@type"] || "").toLowerCase();
        if (["product", "service", "offer", "localbusiness"].some((t) => type.includes(t))) {
          const n = normalize(data);
          if (n) results.push(n);
        }
        if (data["@graph"] && Array.isArray(data["@graph"])) {
          data["@graph"].forEach((g) => {
            const gt = (g["@type"] || "").toLowerCase();
            if (["product", "service", "offer", "localbusiness"].some((t) => gt.includes(t))) {
              const n = normalize(g);
              if (n) results.push(n);
            }
          });
        }
      }
    } catch {
      // ignore invalid JSON
    }
  });

  return results;
}

/**
 * Find main content container: main, article, or largest text block.
 * Removes nav, footer, sidebar; scores by text density.
 */
function extractMainContent($) {
  const $body = $("body");
  if (!$body.length) return "";

  $body.find("script, style, noscript, nav, footer, [role='navigation'], [role='contentinfo'], aside, .sidebar, .sidebar-wrapper, .nav, .footer, header nav").remove();

  let best = "";
  let bestLen = 0;

  const candidates = $body.find("main, article, [role='main'], .main, .content, .post-content, #content, #main");
  if (candidates.length) {
    candidates.each((_, el) => {
      const text = $(el).text().replace(/\s+/g, " ").trim();
      if (text.length > bestLen && text.length >= 50) {
        bestLen = text.length;
        best = text;
      }
    });
  }

  if (best) return best;

  const sections = $body.find("div, section");
  sections.each((_, el) => {
    const $el = $(el);
    const text = $el.text().replace(/\s+/g, " ").trim();
    const childTextLen = $el.find("div, section").length
      ? $el.find("div, section").text().length
      : 0;
    const ownText = text.length - childTextLen;
    if (ownText > bestLen && text.length >= 100) {
      bestLen = text.length;
      best = text;
    }
  });

  if (best) return best;
  return $body.text().replace(/\s+/g, " ").trim();
}

/**
 * Heuristic title: h1, h2, og:title, title tag.
 */
function extractTitle($) {
  const h1 = $("h1").first().text().trim();
  if (h1 && h1.length > 2 && h1.length < 200) return h1;
  const h2 = $("h2").first().text().trim();
  if (h2 && h2.length > 2 && h2.length < 200) return h2;
  const og = $('meta[property="og:title"]').attr("content");
  if (og && og.trim().length > 2 && og.length < 200) return og.trim();
  const title = $("title").text().trim();
  if (title && title.length > 2 && title.length < 200) return title;
  return null;
}

/**
 * Heuristic description: meta description, then main content (cleaned).
 */
function extractDescription($, mainContent) {
  const meta = $('meta[name="description"]').attr("content");
  if (meta && meta.trim().length > 10) {
    const cleaned = cleanExtractedContent(meta);
    return (cleaned || meta.trim()).substring(0, MAX_DESCRIPTION_CHARS);
  }
  if (mainContent) {
    const cleaned = cleanExtractedContent(mainContent);
    return cleaned ? cleaned.substring(0, MAX_DESCRIPTION_CHARS) : null;
  }
  const paragraphs = $("p").slice(0, 5).map((_, el) => $(el).text().trim()).get();
  const combined = paragraphs.filter(Boolean).join("\n\n");
  const cleaned = cleanExtractedContent(combined);
  return cleaned ? cleaned.substring(0, MAX_DESCRIPTION_CHARS) : null;
}

/**
 * Heuristic image: og:image, first img in main/article, first img.
 */
function extractImage($, pageUrl) {
  const og = $('meta[property="og:image"]').attr("content");
  if (og) {
    try {
      return new URL(og, pageUrl).href;
    } catch {
      // fall through
    }
  }
  const firstImg =
    $("main img").first().attr("src") ||
    $("article img").first().attr("src") ||
    $("h1").first().parent().find("img").first().attr("src") ||
    $("img").first().attr("src");
  if (firstImg) {
    try {
      return new URL(firstImg, pageUrl).href;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Extract price from body text (currency regex).
 */
function extractPrice($) {
  const text = $("body").text();
  const matches = text.match(PRICE_REGEX);
  if (matches && matches.length > 0) return matches[0].trim();
  return null;
}

/**
 * Extract FAQ-style blocks: dl dt/dd, .faq items, heading + paragraph pairs with Q/A patterns.
 * @returns {Array<{ question: string, answer: string }>}
 */
function extractFaqBlocks($) {
  const faqs = [];
  $("dl").each((_, dl) => {
    const dts = $(dl).find("dt");
    dts.each((i, dt) => {
      const dd = dts.eq(i).next("dd");
      const q = $(dt).text().replace(/\s+/g, " ").trim();
      const a = dd.length ? dd.text().replace(/\s+/g, " ").trim().substring(0, 800) : "";
      if (q && q.length > 5 && a && a.length > 3) faqs.push({ question: q, answer: a });
    });
  });
  $("[class*='faq'], [id*='faq'], [data-faq]").find("h3, h4, .question, strong").each((_, el) => {
    const q = $(el).text().replace(/\s+/g, " ").trim();
    const next = $(el).next();
    const a = next.length ? next.text().replace(/\s+/g, " ").trim().substring(0, 800) : "";
    if (q && q.length > 5 && a && a.length > 3) faqs.push({ question: q, answer: a });
  });
  return faqs.slice(0, 30);
}

/**
 * Extract pricing-related blocks (sections containing prices or "pricing" in heading).
 * @returns {Array<string>}
 */
function extractPricingBlocks($) {
  const blocks = [];
  $("h1, h2, h3").each((_, el) => {
    const $el = $(el);
    const title = $el.text().trim().toLowerCase();
    const content = $el.nextUntil("h1, h2, h3").text().replace(/\s+/g, " ").trim().substring(0, 1500);
    if ((title.includes("pric") || title.includes("cost") || title.includes("plan") || title.includes("rate")) && content && content.match(PRICE_REGEX)) {
      blocks.push((title + "\n" + content).trim());
    }
  });
  $("table").each((_, t) => {
    const text = $(t).text().replace(/\s+/g, " ").trim();
    if (text.match(PRICE_REGEX) && text.length < 2000) blocks.push(text);
  });
  return blocks.slice(0, 10);
}

/**
 * Extract service/offer sections (headings with "service", "offer", "what we" and content).
 * @returns {Array<{ title: string, content: string }>}
 */
function extractServiceSections($) {
  const sections = [];
  $("h2, h3").each((_, el) => {
    const $el = $(el);
    const title = $el.text().trim();
    const content = $el.nextUntil("h2, h3").text().replace(/\s+/g, " ").trim().substring(0, 1200);
    const lower = title.toLowerCase();
    if ((lower.includes("service") || lower.includes("offer") || lower.includes("what we") || lower.includes("product") || lower.includes("solution")) && content.length > 20) {
      sections.push({ title, content });
    }
  });
  return sections.slice(0, 15);
}

/**
 * Extract meta tags and OpenGraph into a plain object.
 */
function extractMetaAndOg($) {
  const meta = {};
  $("meta[name], meta[property]").each((_, el) => {
    const name = $(el).attr("name") || $(el).attr("property");
    const content = $(el).attr("content");
    if (name && content) meta[name] = content.trim();
  });
  return meta;
}

/**
 * Extract image alt text for context.
 * @returns {Array<string>}
 */
function extractImageAltTexts($) {
  const alts = [];
  $("img[alt]").each((_, el) => {
    const alt = $(el).attr("alt");
    if (alt && alt.trim().length > 2 && alt.length < 300) alts.push(alt.trim());
  });
  return alts.slice(0, 20);
}

/**
 * Detect common product card containers and extract name + description text.
 * @returns {Array<string>}
 */
function extractProductCards($) {
  const cards = [];
  const seen = new Set();
  const selectors = [
    "[class*='product-card']", "[class*='product-item']", "[class*='product_card']",
    "[class*='ProductCard']", "[class*='grid-item']",
    "[class*='card'] [class*='product']",
    "[data-product]", "[data-item]",
    ".card", ".item",
  ];
  const containers = $(selectors.join(", "));
  containers.each((_, el) => {
    const $el = $(el);
    const name =
      $el.find("h1, h2, h3, h4, h5, [class*='title'], [class*='name']").first().text().replace(/\s+/g, " ").trim() ||
      $el.find("a").first().text().replace(/\s+/g, " ").trim();
    if (!name || name.length < 3 || name.length > 300) return;
    const key = name.slice(0, 60).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const desc =
      $el.find("p, [class*='desc'], [class*='excerpt'], [class*='summary']").first().text().replace(/\s+/g, " ").trim() || "";
    const price =
      $el.find("[class*='price'], .price, [data-price]").first().text().replace(/\s+/g, " ").trim() || "";
    let block = `Product: ${name}`;
    if (desc && desc.length > 5 && desc.length < 500) block += `\n${desc}`;
    if (price && price.length < 80) block += `\nPrice: ${price}`;
    cards.push(block);
  });
  return cards.slice(0, 30);
}

/**
 * Extract text labels displayed next to icons (service cards, feature lists, etc.).
 * @returns {Array<string>}
 */
function extractIconLabels($) {
  const labels = [];
  const seen = new Set();
  $("i, svg, [class*='icon'], [class*='Icon']").each((_, el) => {
    const $icon = $(el);
    const $parent = $icon.parent();
    const siblingText =
      $parent.find("span, p, h3, h4, h5, strong, [class*='label'], [class*='title']").first().text().replace(/\s+/g, " ").trim() ||
      $parent.text().replace(/\s+/g, " ").trim();
    if (!siblingText || siblingText.length < 3 || siblingText.length > 200) return;
    const key = siblingText.slice(0, 50).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    labels.push(siblingText);
  });
  return labels.slice(0, 30);
}

/**
 * Extract text from buttons and call-to-action elements.
 * @returns {Array<string>}
 */
function extractButtonLabels($) {
  const labels = [];
  const seen = new Set();
  $("button, a.btn, a.button, [class*='btn'], [class*='cta'], [role='button'], input[type='submit']").each((_, el) => {
    const $el = $(el);
    const text = ($el.text() || $el.attr("value") || "").replace(/\s+/g, " ").trim();
    if (!text || text.length < 3 || text.length > 100) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    labels.push(text);
  });
  return labels.slice(0, 20);
}

/**
 * Full structured extraction for a single page (for business_website_pages).
 * cleaned_content length is capped intelligently (main content prioritized, max MAX_CLEANED_CONTENT_CHARS).
 */
function extractStructuredPageData(html, pageUrl) {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  const mainContent = extractMainContent($);
  const title = extractTitle($);
  const description = extractDescription($, mainContent);
  const price = extractPrice($);
  const image = extractImage($, pageUrl);
  const jsonLdItems = extractJsonLd(html, pageUrl);
  const faqs = extractFaqBlocks($);
  const pricingBlocks = extractPricingBlocks($);
  const serviceSections = extractServiceSections($);
  const imageAltTexts = extractImageAltTexts($);
  const meta = extractMetaAndOg($);
  const productCards = extractProductCards($);
  const iconLabels = extractIconLabels($);
  const buttonLabels = extractButtonLabels($);

  let cleaned_content = mainContent || "";
  if (cleaned_content.length < 100 && description) cleaned_content = description;
  cleaned_content = cleanExtractedContent(cleaned_content) || cleaned_content.replace(/\s+/g, " ").trim();

  const visualBlocks = [];
  if (imageAltTexts.length) {
    visualBlocks.push(imageAltTexts.map((alt) => `Image: ${alt}`).join("\n"));
  }
  if (productCards.length) {
    visualBlocks.push(productCards.join("\n\n"));
  }
  if (iconLabels.length) {
    visualBlocks.push("Services/Features:\n" + iconLabels.map((l) => `• ${l}`).join("\n"));
  }
  if (buttonLabels.length) {
    visualBlocks.push("Actions: " + buttonLabels.join(" | "));
  }
  if (visualBlocks.length) {
    cleaned_content = (cleaned_content + "\n\n" + visualBlocks.join("\n\n")).trim();
  }

  if (cleaned_content.length > MAX_CLEANED_CONTENT_CHARS) cleaned_content = cleaned_content.substring(0, MAX_CLEANED_CONTENT_CHARS);

  const metadata_json = {
    faqs,
    pricing_blocks: pricingBlocks,
    service_sections: serviceSections,
    image_alt_texts: imageAltTexts,
    product_cards: productCards,
    icon_labels: iconLabels,
    button_labels: buttonLabels,
    json_ld: jsonLdItems.slice(0, 10),
    meta,
  };

  return {
    title: title || "Untitled",
    description: description || "",
    price: price || null,
    image: image || null,
    url: pageUrl,
    cleaned_content,
    metadata_json,
    jsonLdItems,
  };
}

/**
 * Extract structured page data: heuristic + JSON-LD merge.
 * Returns one primary page record; JSON-LD items can be merged by crawler if needed.
 */
function extractPageData(html, pageUrl) {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  const mainContent = extractMainContent($);
  let title = extractTitle($);
  let description = extractDescription($, mainContent);
  let price = extractPrice($);
  let image = extractImage($, pageUrl);

  const jsonLdItems = extractJsonLd(html, pageUrl);
  if (jsonLdItems.length > 0) {
    const first = jsonLdItems[0];
    if (first.name && !title) title = first.name;
    if (first.description && !description) description = first.description;
    if (first.price && !price) price = first.price;
    if (first.image && !image) image = first.image;
  }

  if (title && title.length > 200) title = title.substring(0, 197) + "...";
  if (description) description = cleanExtractedContent(description) || description || "";
  if (description.length > MAX_DESCRIPTION_CHARS) description = description.substring(0, MAX_DESCRIPTION_CHARS);

  return {
    title: title || "Untitled",
    description: description || "",
    price: price || null,
    image: image || null,
    url: pageUrl,
    jsonLdItems,
  };
}

// --- Business info (homepage) ---
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /(\+?1?[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g;
const ADDRESS_REGEX = /\d+[\s\w.,-]+(?:street|st|ave|avenue|blvd|road|rd|drive|dr|lane|ln|way|court|ct|suite|ste|floor|fl)[\s\w.,-]*/gi;
const SOCIAL_REGEX = /(?:https?:\/\/)?(?:www\.)?(facebook\.com|twitter\.com|instagram\.com|linkedin\.com|youtube\.com|tiktok\.com)\/[^\s"'<>)\]]+/gi;

/**
 * Extract global business info from homepage HTML (name, phone, email, address, socials).
 */
function extractBusinessInfo(html, pageUrl) {
  const $ = cheerio.load(html);
  const text = $("body").text();
  const result = { name: null, phone: null, email: null, address: null, socials: [] };

  const ogName = $('meta[property="og:site_name"]').attr("content");
  if (ogName && ogName.trim()) result.name = ogName.trim();
  if (!result.name) {
    const title = $("title").text().trim();
    if (title) result.name = title.replace(/\s*[-|–—]\s*.*$/, "").trim();
  }
  if (!result.name) {
    const h1 = $("h1").first().text().trim();
    if (h1 && h1.length < 150) result.name = h1;
  }

  const emails = text.match(EMAIL_REGEX) || [];
  const uniqueEmails = [...new Set(emails)].filter((e) => !/noreply|no-reply|donotreply|example\.com/i.test(e));
  if (uniqueEmails.length) result.email = uniqueEmails[0];

  const phones = text.match(PHONE_REGEX) || [];
  if (phones.length) result.phone = phones[0].trim();

  const addresses = text.match(ADDRESS_REGEX) || [];
  if (addresses.length) result.address = addresses[0].trim().replace(/\s+/g, " ");

  const socials = text.match(SOCIAL_REGEX) || [];
  const links = $("a[href]").map((_, el) => $(el).attr("href")).get();
  links.forEach((href) => {
    const m = (href || "").match(SOCIAL_REGEX);
    if (m) result.socials.push(...m);
  });
  result.socials = [...new Set([...result.socials, ...(socials || [])])].slice(0, 10);

  return result;
}

module.exports = {
  cleanExtractedContent,
  extractJsonLd,
  extractMainContent,
  extractPageData,
  extractStructuredPageData,
  extractBusinessInfo,
  extractTitle,
  extractDescription,
  extractImage,
  extractPrice,
  extractFaqBlocks,
  extractPricingBlocks,
  extractServiceSections,
  extractMetaAndOg,
  extractImageAltTexts,
  extractProductCards,
  extractIconLabels,
  extractButtonLabels,
  MIN_BODY_LENGTH_JS_RENDERED,
  MAX_DESCRIPTION_CHARS,
  MAX_CLEANED_CONTENT_CHARS,
};
