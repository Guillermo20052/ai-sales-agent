const axios = require("axios");
const cheerio = require("cheerio");
const { URL } = require("url");

/**
 * Clean extracted text
 */
function cleanText(text) {
  return text.replace(/\s+/g, " ").replace(/\n+/g, "\n").trim();
}

/**
 * Extract structured sections
 */
function extractStructuredContent($) {
  const sections = [];

  $("h1, h2, h3").each((i, el) => {
    const title = $(el).text().trim();
    const content = $(el).nextUntil("h1, h2, h3").text().trim();

    if (title && content) {
      sections.push({
        title,
        content: cleanText(content).substring(0, 1500),
      });
    }
  });

  return sections;
}

/**
 * Score links for business relevance
 */
function scoreLink(url) {
  const lower = url.toLowerCase();

  let score = 0;

  // Positive signals
  if (lower.includes("product")) score += 3;
  if (lower.includes("service")) score += 3;
  if (lower.includes("solution")) score += 3;
  if (lower.includes("pricing")) score += 3;
  if (lower.includes("about")) score += 2;
  if (lower.includes("catalog")) score += 3;
  if (lower.includes("shop")) score += 3;
  if (lower.includes("offer")) score += 2;

  // Negative signals
  if (lower.includes("privacy")) score -= 5;
  if (lower.includes("terms")) score -= 5;
  if (lower.includes("login")) score -= 5;
  if (lower.includes("cart")) score -= 5;
  if (lower.includes("account")) score -= 5;
  if (lower.includes("wp-admin")) score -= 5;

  return score;
}

/**
 * Extract and rank internal links
 */
function extractRelevantLinks($, baseUrl) {
  const links = new Map();

  $("a").each((i, el) => {
    let href = $(el).attr("href");
    if (!href) return;

    try {
      const fullUrl = new URL(href, baseUrl).href;

      // Must be same domain
      if (!fullUrl.startsWith(baseUrl)) return;

      // Avoid duplicates
      if (links.has(fullUrl)) return;

      const score = scoreLink(fullUrl);
      links.set(fullUrl, score);
    } catch (e) {
      return;
    }
  });

  // Sort by score descending
  return Array.from(links.entries())
    .sort((a, b) => b[1] - a[1])
    .filter(([_, score]) => score > 0)
    .slice(0, 5)
    .map(([url]) => url);
}

/**
 * Crawl a single page
 */
async function crawlPage(url) {
  const response = await axios.get(url, {
    timeout: 10000,
    headers: {
      "User-Agent": "AI-Sales-Agent-Bot",
    },
  });

  const $ = cheerio.load(response.data);
  $("script, style, noscript").remove();

  return {
    raw: cleanText($("body").text()).substring(0, 15000),
    sections: extractStructuredContent($),
  };
}

/**
 * Universal Multi-Page Website Training
 */
async function trainWebsite(url) {
  try {
    if (!url.startsWith("http")) {
      url = "https://" + url;
    }

    const baseUrl = new URL(url).origin;

    // Crawl homepage
    const homepage = await crawlPage(url);

    const homepageResponse = await axios.get(url);
    const $ = cheerio.load(homepageResponse.data);

    const internalLinks = extractRelevantLinks($, baseUrl);

    let combinedSections = [...homepage.sections];
    let combinedRaw = homepage.raw;

    // Crawl additional high-value pages
    for (const link of internalLinks) {
      try {
        const page = await crawlPage(link);
        combinedSections = combinedSections.concat(page.sections);
        combinedRaw += "\n\n" + page.raw;
      } catch (err) {
        console.warn("Failed to crawl:", link);
      }
    }

    return {
      success: true,
      knowledge: {
        source_url: url,
        extracted_at: new Date(),
        raw_text: combinedRaw.substring(0, 50000),
        sections: combinedSections,
      },
    };
  } catch (error) {
    console.error("Website training failed:", error.message);

    return {
      success: false,
      error: error.message,
    };
  }
}

module.exports = {
  trainWebsite,
};
