/**
 * Headless browser (Puppeteer) fallback for JS-rendered pages.
 * Used when axios returns empty or minimal HTML.
 */

const BROWSER_TIMEOUT_MS = 15000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const BLOCK_RESOURCE_TYPES = ["image", "font", "media"];

let browserInstance = null;

/**
 * Get or create a shared browser instance (lazy launch).
 * Requires puppeteer to be installed; if not, will throw when first used.
 * @returns {Promise<import('puppeteer').Browser>}
 */
async function getBrowser() {
  if (browserInstance) return browserInstance;
  let puppeteer;
  try {
    puppeteer = require("puppeteer");
  } catch (e) {
    throw new Error("Puppeteer is not installed. Run: npm install puppeteer");
  }
  browserInstance = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
  return browserInstance;
}

/**
 * Fetch full HTML of a URL using headless Chrome.
 * Blocks images, fonts, and media for speed. Waits for network idle.
 *
 * @param {string} url - Full URL to fetch
 * @returns {Promise<string>} Rendered HTML
 */
async function fetchWithBrowser(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (BLOCK_RESOURCE_TYPES.includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent(USER_AGENT);
    await page.setDefaultNavigationTimeout(BROWSER_TIMEOUT_MS);
    await page.setDefaultTimeout(BROWSER_TIMEOUT_MS);

    const response = await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: BROWSER_TIMEOUT_MS,
    });

    if (!response || response.status() >= 400) {
      throw new Error(`Page returned ${response ? response.status() : "no response"}`);
    }

    const html = await page.content();
    return html;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Close the shared browser instance (call when crawler is done or on shutdown).
 */
async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}

module.exports = {
  fetchWithBrowser,
  getBrowser,
  closeBrowser,
  BROWSER_TIMEOUT_MS,
};
