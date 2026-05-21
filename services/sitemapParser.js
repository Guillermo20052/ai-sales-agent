/**
 * Sitemap parser: fetch sitemap.xml (or sitemap index) and extract same-origin URLs.
 * Used to seed the crawl queue before link discovery.
 */

const axios = require("axios");
const { URL } = require("url");

const SITEMAP_TIMEOUT_MS = 10000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; AI-Sales-Agent-Crawler/1.0; +https://github.com/ai-sales-agent)";

const LOC_REGEX = /<loc>\s*([^<]+)\s*<\/loc>/gi;

/**
 * Fetch URL and return response body as string.
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function fetchUrl(url) {
  try {
    const res = await axios.get(url, {
      timeout: SITEMAP_TIMEOUT_MS,
      maxRedirects: 3,
      validateStatus: (s) => s >= 200 && s < 400,
      responseType: "text",
      headers: { "User-Agent": USER_AGENT, Accept: "application/xml, text/xml, */*" },
    });
    return typeof res.data === "string" ? res.data : String(res.data || "");
  } catch {
    return null;
  }
}

/**
 * Extract all <loc> URLs from sitemap XML string.
 * @param {string} xml
 * @returns {string[]}
 */
function extractLocUrls(xml) {
  if (!xml || typeof xml !== "string") return [];
  const urls = [];
  let m;
  LOC_REGEX.lastIndex = 0;
  while ((m = LOC_REGEX.exec(xml)) !== null) {
    const raw = m[1].trim();
    if (raw) urls.push(raw);
  }
  return urls;
}

/**
 * Check if XML looks like a sitemap index (contains <sitemap>).
 * @param {string} xml
 * @returns {boolean}
 */
function isSitemapIndex(xml) {
  return /<sitemap[\s>]/i.test(xml || "");
}

/**
 * Fetch sitemap at baseUrl/sitemap.xml and return same-origin URLs.
 * If it's a sitemap index, follow first-level sitemaps (up to 5) and merge.
 *
 * @param {string} baseUrl - e.g. https://example.com
 * @returns {Promise<string[]>} List of absolute URLs from sitemap(s)
 */
async function parseSitemap(baseUrl) {
  const base = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (!base) return [];

  let origin;
  try {
    origin = new URL(base).origin;
  } catch {
    return [];
  }

  const sitemapUrl = base.replace(/\/$/, "") + "/sitemap.xml";
  const xml = await fetchUrl(sitemapUrl);
  if (!xml) return [];

  const locs = extractLocUrls(xml);
  if (locs.length === 0) return [];

  if (!isSitemapIndex(xml)) {
    return locs.filter((u) => {
      try {
        return new URL(u).origin === origin;
      } catch {
        return false;
      }
    });
  }

  const sitemapLocs = locs.filter((u) => /\.xml$/i.test(u)).slice(0, 5);
  const allUrls = [];
  const seen = new Set();

  for (const smUrl of sitemapLocs) {
    const subXml = await fetchUrl(smUrl);
    if (!subXml) continue;
    const subUrls = extractLocUrls(subXml);
    for (const u of subUrls) {
      try {
        if (new URL(u).origin === origin && !seen.has(u)) {
          seen.add(u);
          allUrls.push(u);
        }
      } catch {
        // skip invalid
      }
    }
  }

  return allUrls;
}

module.exports = {
  parseSitemap,
  extractLocUrls,
  fetchUrl,
};
