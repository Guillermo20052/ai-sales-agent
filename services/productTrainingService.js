/**
 * Train a business from its website: crawl, extract products, store in business_products.
 */

const pool = require("./db");
const { crawlWebsite, normalizeUrl } = require("./crawler");

const MAX_PRODUCTS_STORED = 200;

/**
 * Train business from website URL: crawl, then replace old products with new ones.
 *
 * @param {number} businessId - business_profiles.id
 * @param {string} websiteUrl - Homepage or base URL to crawl
 * @returns {Promise<{ success: boolean, count?: number, error?: string }>}
 */
async function trainBusinessFromWebsite(businessId, websiteUrl) {
  if (!businessId || !websiteUrl) {
    return { success: false, error: "Business ID and website URL are required." };
  }

  const url = normalizeUrl(websiteUrl);
  if (!url) {
    return { success: false, error: "Invalid website URL." };
  }

  const hostname = new URL(url).hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("172.")
  ) {
    return { success: false, error: "Internal URLs are not allowed." };
  }

  let result;
  try {
    result = await crawlWebsite(url);
  } catch (err) {
    return {
      success: false,
      error: err.message || "Could not crawl website. Check the URL and try again.",
    };
  }

  const products = result && Array.isArray(result.pages) ? result.pages : [];

  if (products.length === 0) {
    return { success: true, count: 0 };
  }

  const toInsert = products.slice(0, MAX_PRODUCTS_STORED);

  const client = await pool.connect();
  try {
    await client.query("DELETE FROM business_products WHERE business_id = $1", [businessId]);

    for (const p of toInsert) {
      await client.query(
        `INSERT INTO business_products (business_id, title, description, price, image_url, page_url)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          businessId,
          p.title || null,
          p.description || null,
          p.price || null,
          p.image || null,
          p.url || null,
        ],
      );
    }

    return { success: true, count: toInsert.length };
  } catch (err) {
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Save product records from an existing crawl result (no crawl). Used when dashboard
 * runs a single crawl and both stores pages and products.
 * @param {number} businessId
 * @param {Array<{ title?, description?, price?, image?, url? }>} pages
 * @returns {Promise<{ success: boolean, count: number }>}
 */
async function saveProductsFromCrawlResult(businessId, pages) {
  const list = Array.isArray(pages) ? pages : [];
  const toInsert = list.slice(0, MAX_PRODUCTS_STORED);
  const client = await pool.connect();
  try {
    await client.query("DELETE FROM business_products WHERE business_id = $1", [businessId]);
    for (const p of toInsert) {
      await client.query(
        `INSERT INTO business_products (business_id, title, description, price, image_url, page_url)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          businessId,
          p.title || null,
          p.description || null,
          p.price || null,
          p.image || null,
          p.url || null,
        ],
      );
    }
    return { success: true, count: toInsert.length };
  } finally {
    client.release();
  }
}

module.exports = {
  trainBusinessFromWebsite,
  saveProductsFromCrawlResult,
};
