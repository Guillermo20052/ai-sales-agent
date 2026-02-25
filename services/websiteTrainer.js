const axios = require("axios");
const cheerio = require("cheerio");

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
  const headings = [];

  $("h1, h2, h3").each((i, el) => {
    const title = $(el).text().trim();
    const content = $(el).nextUntil("h1, h2, h3").text().trim();

    if (title && content) {
      headings.push({
        title,
        content: cleanText(content).substring(0, 1500),
      });
    }
  });

  return headings;
}

/**
 * Train website from homepage only (MVP)
 */
async function trainWebsite(url) {
  try {
    if (!url.startsWith("http")) {
      url = "https://" + url;
    }

    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        "User-Agent": "AI-Sales-Agent-Bot",
      },
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // Remove unwanted elements
    $("script, style, noscript").remove();

    const bodyText = cleanText($("body").text()).substring(0, 20000);
    const structuredSections = extractStructuredContent($);

    return {
      success: true,
      knowledge: {
        source_url: url,
        extracted_at: new Date(),
        raw_text: bodyText,
        sections: structuredSections,
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
