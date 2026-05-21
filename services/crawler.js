/**
 * Production-grade website crawler: hybrid fetch (axios + Puppeteer), sitemap,
 * concurrency, retry, global timeout. Exports crawlWebsite() as main API.
 */

const axios = require("axios");
const cheerio = require("cheerio");
const { URL } = require("url");
const { parseSitemap } = require("./sitemapParser");
const crypto = require("crypto");
const {
  extractPageData,
  extractStructuredPageData,
  extractBusinessInfo,
  cleanExtractedContent,
  MIN_BODY_LENGTH_JS_RENDERED,
} = require("./contentExtractor");

const CRAWL_DEPTH = 3;
const MAX_PAGES_PER_CRAWL = 50;
const REQUEST_DELAY_MS = 300;
const PAGE_TIMEOUT_MS = 12000;
const GLOBAL_CRAWL_TIMEOUT_MS = 60000;
const CONCURRENCY = 3;
const RETRIES = 2;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Path segments to exclude: only login, cart, account, admin (and external domains handled elsewhere). */
const ROBOTS_TXT_TIMEOUT_MS = 5000;
const EXCLUDED_PATH_SEGMENTS = [
  "login",
  "logout",
  "wp-login",
  "cart",
  "checkout",
  "account",
  "my-account",
  "admin",
  "wp-admin",
];

const PAGE_TYPES = ["pricing", "services", "faq", "about", "contact", "product", "blog", "general"];

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Classify page type from URL path, title, and h1 text.
 * @returns {string} One of PAGE_TYPES
 */
function classifyPageType(url, title = "", h1Text = "") {
  const path = (url || "").toLowerCase();
  const t = (title || "").toLowerCase();
  const h1 = (h1Text || "").toLowerCase();
  const combined = path + " " + t + " " + h1;

  if (/\/(pricing|price|plans|rates|fees)\b|pricing|^price|plans|rates/.test(combined)) return "pricing";
  if (/\/(services?|offer|solutions?)\b|services|what we offer|our services/.test(combined)) return "services";
  if (/\/(faq|faqs|questions?|help)\b|faq|frequently asked|questions? & answers/.test(combined)) return "faq";
  if (/\/(about|about-us|our-story|team)\b|about us|who we are|our story/.test(combined)) return "about";
  if (/\/(contact|get-in-touch|reach-us)\b|contact us|get in touch|reach us/.test(combined)) return "contact";
  if (/\/(product|products|shop|store)\b|product|shop|store/.test(combined)) return "product";
  if (/\/(blog|news|articles?|post)\b|blog|news|articles/.test(combined)) return "blog";
  return "general";
}

/**
 * Content hash for deduplication and change detection.
 */
function contentHash(content) {
  if (!content || typeof content !== "string") return "";
  const normalized = content.replace(/\s+/g, " ").trim();
  return crypto.createHash("sha256").update(normalized).digest("hex").substring(0, 64);
}

/**
 * Importance score by page type (used for retrieval priority).
 * No ecommerce bias: all page types treated equally for full-website coverage.
 */
function importanceForPageType(pageType) {
  return 1.0;
}

/**
 * Normalize URL: add https if missing, strip hash/fragment.
 */
function normalizeUrl(input) {
  if (!input || typeof input !== "string") return null;
  const s = input.trim();
  if (!s) return null;
  const withScheme = s.startsWith("http") ? s : "https://" + s;
  try {
    const u = new URL(withScheme);
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Check if path should be excluded from crawl.
 * @param {string} pathname
 * @param {string[]} [robotsDisallow] - path prefixes from robots.txt Disallow
 */
function isExcludedPath(pathname, robotsDisallow = []) {
  const lower = (pathname || "").toLowerCase();
  if (EXCLUDED_PATH_SEGMENTS.some((seg) => lower.includes(seg))) return true;
  const path = (pathname || "").trim() || "/";
  for (const disallow of robotsDisallow) {
    if (!disallow) continue;
    const prefix = disallow.startsWith("/") ? disallow : "/" + disallow;
    if (path === prefix || path.startsWith(prefix + "/")) return true;
  }
  return false;
}

/**
 * Fetch robots.txt and return list of Disallow path prefixes (for * or any agent).
 */
async function getRobotsDisallow(baseOrigin) {
  try {
    const url = baseOrigin.replace(/\/$/, "") + "/robots.txt";
    const res = await axios.get(url, {
      timeout: ROBOTS_TXT_TIMEOUT_MS,
      validateStatus: (s) => s === 200,
      headers: { "User-Agent": USER_AGENT },
    });
    const text = typeof res.data === "string" ? res.data : String(res.data || "");
    const lines = text.split(/\r?\n/);
    const disallow = [];
    let inRelevant = false;
    for (const line of lines) {
      const [key, ...rest] = line.split(":").map((s) => s.trim());
      const val = rest.join(":").trim();
      if (/user-agent/i.test(key)) {
        inRelevant = !val || val === "*" || /crawler|bot|spider/i.test(val);
      } else if (inRelevant && /disallow/i.test(key) && val) {
        disallow.push(val);
      }
    }
    return disallow;
  } catch {
    return [];
  }
}

/**
 * Get all same-origin internal links from HTML.
 * Includes ALL internal links (contact, about, locations, hours, team, faq, policies, privacy, footer).
 * Only excludes: login, cart, account, admin, external domains.
 * No filtering by product/service or ecommerce keywords.
 */
function getInternalLinks(html, baseOrigin, robotsDisallow = []) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const out = [];
  $("a[href]").each((_, el) => {
    let href = $(el).attr("href");
    if (!href) return;
    href = href.trim();
    if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
    try {
      const full = new URL(href, baseOrigin).href;
      const u = new URL(full);
      if (u.origin !== baseOrigin) return;
      if (u.hash) u.hash = "";
      const canonical = u.href;
      if (seen.has(canonical)) return;
      if (isExcludedPath(u.pathname, robotsDisallow)) return;
      seen.add(canonical);
      out.push(canonical);
    } catch {
      // ignore invalid
    }
  });
  return out;
}

/**
 * Extract footer, header/nav, and contact block text so the AI sees full site content.
 * @param {string} html
 * @returns {string} Combined text from footer, header nav, and contact sections.
 */
function extractFooterHeaderContact(html) {
  if (!html || typeof html !== "string") return "";
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  const parts = [];

  const addText = (sel, label) => {
    $(sel).each((_, el) => {
      const text = $(el).text().replace(/\s+/g, " ").trim();
      if (text && text.length > 10) parts.push(`[${label}]\n${text.slice(0, 2000)}`);
    });
  };

  addText("footer", "Footer");
  addText("[role='contentinfo']", "Footer");
  addText(".footer", "Footer");
  addText("#footer", "Footer");

  addText("header", "Header");
  addText("nav", "Navigation");
  addText("[role='navigation']", "Navigation");
  addText(".header-nav, .main-nav, .site-nav", "Navigation");

  addText("[class*='contact']", "Contact");
  addText("[id*='contact']", "Contact");
  addText(".contact-block, .contact-info, .contact-details", "Contact");

  const combined = parts.join("\n\n");
  return combined.length > 4000 ? combined.slice(0, 4000) : combined;
}

/**
 * Fetch HTML via axios. Returns { html, status }.
 */
async function fetchHtmlAxios(url) {
  const res = await axios.get(url, {
    timeout: PAGE_TIMEOUT_MS,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
  });
  const html = typeof res.data === "string" ? res.data : String(res.data || "");
  return { html, status: res.status };
}

/**
 * Hybrid fetch: axios first; if page looks empty/JS-rendered, fallback to Puppeteer.
 */
async function fetchHtml(url) {
  let html = "";
  let status = 0;

  try {
    const result = await fetchHtmlAxios(url);
    html = result.html;
    status = result.status;
  } catch (err) {
    // axios failed; try browser once
    try {
      const { fetchWithBrowser } = require("./browserCrawler");
      html = await fetchWithBrowser(url);
      status = 200;
    } catch (browserErr) {
      throw err;
    }
    return html;
  }

  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  const bodyTextLen = $("body").text().replace(/\s+/g, " ").trim().length;

  if (bodyTextLen >= MIN_BODY_LENGTH_JS_RENDERED) return html;

  try {
    const { fetchWithBrowser } = require("./browserCrawler");
    html = await fetchWithBrowser(url);
  } catch {
    // keep axios html
  }
  return html;
}

/**
 * Crawl a single URL with retries. Returns { data, links, html } or throws.
 */
async function crawlOnePage(url, baseOrigin, deadline, robotsDisallow = []) {
  if (Date.now() > deadline) throw new Error("Crawl timeout");
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      if (attempt > 0) await delay(REQUEST_DELAY_MS * attempt);
      const html = await fetchHtml(url);
      const data = extractPageData(html, url);
      const links = getInternalLinks(html, baseOrigin, robotsDisallow);
      return { data, links, html };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Main crawl: sitemap seed, BFS with depth and max pages, concurrency 3, global timeout 60s.
 * Returns { businessInfo, pages }.
 *
 * @param {string} homepageUrl - Normalized homepage URL
 * @param {object} [options] - { respectRobotsTxt?: boolean }
 * @returns {Promise<{ businessInfo: object, pages: Array<{ title, description, price, image, url }> }>}
 */
async function crawlWebsite(homepageUrl, options = {}) {
  const normalized = normalizeUrl(homepageUrl);
  if (!normalized) throw new Error("Invalid website URL.");

  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const baseOrigin = new URL(normalized).origin;
  const deadline = Date.now() + GLOBAL_CRAWL_TIMEOUT_MS;
  const visited = new Set();
  const pageResults = [];
  const fullPages = [];
  const seenContentHashes = new Set();
  let businessInfo = { name: null, phone: null, email: null, address: null, socials: [] };

  const robotsDisallow = options.respectRobotsTxt ? await getRobotsDisallow(baseOrigin) : [];

  const queue = [{ url: normalized, depth: 0 }];
  const sitemapUrls = await parseSitemap(normalized);
  sitemapUrls.forEach((u) => {
    try {
      if (!visited.has(u) && !isExcludedPath(new URL(u).pathname, robotsDisallow))
        queue.push({ url: u, depth: 1 });
    } catch {
      // skip invalid URL
    }
  });

  const MAX_LOOP_ITERATIONS = 200;
  let loopCount = 0;
  while (queue.length > 0 && pageResults.length < MAX_PAGES_PER_CRAWL && Date.now() <= deadline && loopCount < MAX_LOOP_ITERATIONS) {
    loopCount += 1;
    const batch = [];
    while (batch.length < CONCURRENCY && queue.length > 0) {
      const item = queue.shift();
      if (!item || visited.has(item.url)) continue;
      visited.add(item.url);
      batch.push(item);
    }
    if (batch.length === 0) break;

    const tasks = batch.map(({ url, depth }) => async () => {
      try {
        await delay(REQUEST_DELAY_MS);
        return await crawlOnePage(url, baseOrigin, deadline, robotsDisallow);
      } catch (err) {
        return null;
      }
    });

    const results = await Promise.all(tasks.map((t) => t()));

    for (let i = 0; i < batch.length; i++) {
      const { url, depth } = batch[i];
      const result = results[i];
      if (!result) continue;

      const { data, links, html } = result;
      if (url === normalized && html) {
        businessInfo = extractBusinessInfo(html, url);
      }

      const record = {
        title: data.title || "Untitled",
        description: data.description || "",
        price: data.price || null,
        image: data.image || null,
        url: data.url || url,
      };
      if (record.title || record.description || record.price) {
        pageResults.push(record);
      }

      if (html) {
        try {
          const structured = extractStructuredPageData(html, url);
          const footerHeaderContact = extractFooterHeaderContact(html);
          let fullContent = structured.cleaned_content || "";
          if (footerHeaderContact) {
            fullContent = fullContent ? `${fullContent}\n\n${footerHeaderContact}` : footerHeaderContact;
          }
          let h1Text = "";
          try {
            const $ = cheerio.load(html);
            h1Text = $("h1").first().text().trim();
          } catch {
            // ignore
          }
          const page_type = classifyPageType(url, structured.title, h1Text || structured.title);
          const content_hash = contentHash(fullContent);
          if (!seenContentHashes.has(content_hash) && (fullContent || structured.title)) {
            seenContentHashes.add(content_hash);
            fullPages.push({
              url,
              page_type,
              title: structured.title,
              cleaned_content: fullContent,
              metadata_json: structured.metadata_json,
              importance_score: importanceForPageType(page_type),
              content_hash,
            });
          }
        } catch (structErr) {
          if (process.env.NODE_ENV !== "production") {
            console.warn("Structured extract failed for", url, structErr.message);
          }
        }
      }

      if (depth < CRAWL_DEPTH && pageResults.length + queue.length < MAX_PAGES_PER_CRAWL) {
        links.forEach((u) => {
          if (visited.has(u)) return;
          try {
            if (isExcludedPath(new URL(u).pathname, robotsDisallow)) return;
          } catch {
            return;
          }
          visited.add(u);
          queue.push({ url: u, depth: depth + 1 });
        });
      }
    }

    if (onProgress) {
      const total = Math.max(pageResults.length + queue.length, 1);
      onProgress(pageResults.length, total);
    }
  }

  if (!businessInfo.name && pageResults.length > 0) {
    businessInfo.name = pageResults[0].title !== "Untitled" ? pageResults[0].title : null;
  }

  return {
    businessInfo,
    pages: pageResults,
    fullPages,
  };
}

module.exports = {
  crawlWebsite,
  normalizeUrl,
  cleanExtractedContent,
  classifyPageType,
  contentHash,
  extractPageData: (html, url) => {
    const data = extractPageData(html, url);
    return {
      title: data.title,
      description: data.description,
      price: data.price,
      image: data.image,
      url: data.url,
    };
  },
};
