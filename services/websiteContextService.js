/**
 * Smart context retrieval from business_website_pages and persistence of crawl results.
 * Used by: dashboard (store pages after crawl), agent (retrieve relevant pages for prompt).
 * Supports embedding-based semantic retrieval (business_website_chunks) with keyword fallback.
 */

const crypto = require("crypto");
const pool = require("./db");
const { sanitizeWebsiteContext } = require("./aiSecurity");
const { callClaude } = require("./aiService");
const { detectLanguageFromPages } = require("./languageDetectionService");
const redis = require("./redis");

const PAGE_TYPE_PRIORITY = { pricing: 4, services: 3, faq: 3, product: 3, about: 2, contact: 2, blog: 1, general: 1 };

/**
 * Strip HTML and broken attributes from text. Use for all content before sending to the AI.
 * Does not modify or reconstruct URLs; only cleans plain text.
 */
function cleanText(input) {
  if (!input || typeof input !== "string") return input;
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/\s*target="_blank"/g, "")
    .replace(/\s*href="[^"]*"/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
const EMBEDDING_MODEL = "voyage-4";
const EMBEDDING_MAX_INPUT_CHARS = 8000;
// Retrieve more chunks for stronger context grounding
const SEMANTIC_TOP_K = 10;
const MAX_PAGES_RETURN = 6;
// AUTOFILL_MODEL removed — auto-fill now uses callClaude() from aiService
const AUTOFILL_MAX_INPUT_CHARS = 12000;
const MAX_CHARS_PER_PAGE = 2500;
const CHUNK_MAX = 700;
const CHUNK_OVERLAP = 100;
// Increased context window so the AI can see significantly more website knowledge per query.
// GPT-4o-mini supports large context windows so this is still conservative.
const MAX_STRUCTURED_TOTAL_CHARS = 8000;
const SUMMARY_MAX_CHARS = 420;
const MARKETING_NOISE_PATTERNS = [
  /want more information/gi,
  /quieres m[aá]s informaci[oó]n/gi,
  /contact us/gi,
  /cont[aá]ctanos/gi,
  /case study/gi,
  /caso de [ée]xito/gi,
  /learn more/gi,
  /book a demo/gi,
  /agenda una demo/gi,
];

/**
 * URL relevance score for evidence ranking: prefer main site pages (short, root-close)
 * over deep content (blog, FAQ, articles, long paths). Used before returning evidence to the model.
 * No industry-specific paths; works for any website.
 * @param {string} url - Full page URL
 * @returns {number} Positive = main-page boost, negative = penalty
 */
function getUrlRelevanceScore(url) {
  if (!url || typeof url !== "string") return 0;
  try {
    const u = new URL(url);
    const pathname = (u.pathname || "/").trim() || "/";
    const pathLower = pathname.toLowerCase();
    const segments = pathname.split("/").filter(Boolean);
    const depth = segments.length;

    let score = 0;

    // Prefer shorter URLs, close to root, 1–2 path segments
    if (depth <= 1) score += 2;
    else if (depth === 2) score += 1;

    // Long URL penalty: path depth > 3
    if (depth > 3) score -= depth - 3;

    // Decrease score for FAQ, blog, articles, news, long informational URLs (generic patterns)
    const deepContentPatterns = [
      /\/(?:blog|blogs)\b/i,
      /\/(?:news)\b/i,
      /\/(?:faq|faqs)\b/i,
      /\/(?:article|articles)\b/i,
      /\/(?:post|posts)\b/i,
      /\/\d{4}\//, // year in path e.g. /2023/ or /blog/2022/10/...
    ];
    for (const re of deepContentPatterns) {
      if (re.test(pathLower)) score -= 1.5;
    }

    return score;
  } catch (_) {
    return 0;
  }
}

/**
 * Split text into chunks of at most CHUNK_MAX chars with CHUNK_OVERLAP between consecutive chunks.
 * Does not merge entire page into one chunk; footer and all sections are preserved across chunks.
 * Breaks at word boundaries when possible to avoid cutting words.
 * @param {string} text - Full page content (including footer, header, contact blocks).
 * @returns {string[]}
 */
function splitIntoChunks(text) {
  if (!text || typeof text !== "string") return [];
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= CHUNK_MAX) return [trimmed];

  const chunks = [];
  let start = 0;

  while (start < trimmed.length) {
    let end = Math.min(start + CHUNK_MAX, trimmed.length);
    let segment = trimmed.slice(start, end);
    const lastSpace = segment.lastIndexOf(" ");
    if (lastSpace > CHUNK_MAX / 2) {
      end = start + lastSpace + 1;
      segment = trimmed.slice(start, end);
    }
    chunks.push(segment.trim());
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
    if (end >= trimmed.length) break;
  }
  return chunks.filter((c) => c.length > 0);
}

function normalizeTokens(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9áéíóúñü]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function summarizePageContent(content) {
  const clean = String(content || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  const top = sentences.slice(0, 3).join(" ").trim();
  const out = top || clean.slice(0, SUMMARY_MAX_CHARS);
  return out.length > SUMMARY_MAX_CHARS
    ? `${out.slice(0, SUMMARY_MAX_CHARS - 1).trim()}…`
    : out;
}

function normalizeBlock(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9áéíóúñü\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarityRatio(a, b) {
  const aTokens = new Set(normalizeBlock(a).split(" ").filter(Boolean));
  const bTokens = new Set(normalizeBlock(b).split(" ").filter(Boolean));
  if (!aTokens.size || !bTokens.size) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(aTokens.size, bTokens.size);
}

function cleanStructuredContext(structuredText, maxChars = MAX_STRUCTURED_TOTAL_CHARS) {
  const text = sanitizeWebsiteContext(cleanText(String(structuredText || "").trim()));
  if (!text) return "";
  const rawBlocks = text.split("\n\n---\n\n").map((b) => b.trim()).filter(Boolean);
  const cleaned = [];
  for (const block of rawBlocks) {
    let current = block;
    for (const pattern of MARKETING_NOISE_PATTERNS) {
      current = current.replace(pattern, "").trim();
    }
    current = current
      .split("\n")
      .filter((line, idx, arr) => {
        const normalized = line.trim().toLowerCase();
        if (!normalized) return false;
        // Drop immediate repeated headings/lines.
        if (idx > 0 && normalized === arr[idx - 1].trim().toLowerCase()) return false;
        return true;
      })
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!current) continue;

    const duplicate = cleaned.some((existing) => similarityRatio(existing, current) >= 0.82);
    if (!duplicate) cleaned.push(current);
  }
  const compact = cleaned.join("\n\n---\n\n").trim();
  return compact.length > maxChars ? compact.slice(0, maxChars).trim() : compact;
}

function buildSiteDigest(fullPages) {
  const pages = Array.isArray(fullPages) ? fullPages : [];
  if (!pages.length) return "";
  const byImportance = [...pages].sort(
    (a, b) => (Number(b.importance_score) || 0) - (Number(a.importance_score) || 0),
  );
  const selected = byImportance.slice(0, 12);
  const blocks = selected
    .map((p) => {
      const label = p.page_type || "general";
      const title = cleanText(p.title || p.url || "Page");
      const summary = summarizePageContent(cleanText(p.cleaned_content || ""));
      if (!summary) return "";
      return `[${label}] ${title}\n${cleanText(summary)}`;
    })
    .filter(Boolean);
  return blocks.join("\n\n").slice(0, 3500);
}

// NOTE: After deploying, re-run website training for all businesses to
// regenerate embeddings with Voyage (1024-dim instead of OpenAI's 1536-dim).

const { VoyageAIClient } = require("voyageai");

let _voyageClient = null;
function getEmbeddingClient() {
  if (_voyageClient) return _voyageClient;
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return null;
  try {
    _voyageClient = new VoyageAIClient({ apiKey: key });
    return _voyageClient;
  } catch (_) {
    return null;
  }
}

/**
 * Truncate text for embedding API (model input limit).
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function truncateForEmbedding(text, maxChars = EMBEDDING_MAX_INPUT_CHARS) {
  if (!text || typeof text !== "string") return "";
  const t = text.trim();
  return t.length <= maxChars ? t : t.substring(0, maxChars);
}

/**
 * Get embedding vector for a single text (Voyage AI).
 * Uses inputType "query" — suitable for user questions at retrieval time.
 * @param {string} text
 * @returns {Promise<number[] | null>}
 */
async function getEmbedding(text) {
  const client = getEmbeddingClient();
  if (!client) return null;
  const input = truncateForEmbedding(text);
  if (!input) return null;
  try {
    const res = await client.embed({
      input: [input],
      model: EMBEDDING_MODEL,
      inputType: "query",
    });
    const vec = res?.embeddings?.[0];
    return Array.isArray(vec) ? vec : null;
  } catch (_) {
    return null;
  }
}

/**
 * Get embeddings for multiple texts in one request (batch).
 * Uses inputType "document" — suitable for indexed website chunks.
 * Returns one embedding per input; null for empty/failed.
 * @param {string[]} texts
 * @returns {Promise<(number[] | null)[]>}
 */
async function getEmbeddingBatch(texts) {
  const client = getEmbeddingClient();
  if (!client || !Array.isArray(texts) || texts.length === 0) return texts.map(() => null);
  const withIndex = texts.map((t, i) => ({ text: truncateForEmbedding(t), i }));
  const nonEmpty = withIndex.filter(({ text }) => text);
  if (nonEmpty.length === 0) return texts.map(() => null);
  try {
    const res = await client.embed({
      input: nonEmpty.map(({ text }) => text),
      model: EMBEDDING_MODEL,
      inputType: "document",
    });
    const vecs = res?.embeddings || [];
    const byIndex = new Map();
    vecs.forEach((vec, j) => {
      if (Array.isArray(vec) && nonEmpty[j]) byIndex.set(nonEmpty[j].i, vec);
    });
    return texts.map((_, i) => byIndex.get(i) ?? null);
  } catch (_) {
    return texts.map(() => null);
  }
}

/**
 * Cosine similarity between two vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom <= 0 ? 0 : dot / denom;
}

/**
 * Store fullPages from crawl into business_website_pages. Skip unchanged (same content_hash).
 * For cleaned_content > 2500 chars, adds metadata_json.content_chunks (sentence-boundary chunks ~1200–1500 chars).
 * @param {number} businessId
 * @param {Array<{ url, page_type, title, cleaned_content, metadata_json, importance_score, content_hash }>} fullPages
 */
async function storeCrawledPages(businessId, fullPages) {
  if (!businessId || !Array.isArray(fullPages) || fullPages.length === 0) return;

  const client = await pool.connect();
  try {
    const crawledUrls = new Set();
    for (const p of fullPages) {
      const url = (p.url || "").trim();
      if (!url) continue;
      crawledUrls.add(url);
      const existing = await client.query(
        "SELECT id, content_hash FROM business_website_pages WHERE business_id = $1 AND url = $2",
        [businessId, url],
      );
      if (existing.rows.length > 0 && existing.rows[0].content_hash === p.content_hash) {
        continue;
      }

      let metaToStore = p.metadata_json && typeof p.metadata_json === "object"
        ? { ...p.metadata_json }
        : (typeof p.metadata_json === "object" && p.metadata_json !== null ? p.metadata_json : {});
      const content = cleanText((p.cleaned_content || "").trim());
      if (content) {
        metaToStore.content_chunks = splitIntoChunks(content);
        metaToStore.page_summary = summarizePageContent(content);
      }

      const metadata_json = JSON.stringify(metaToStore);
      await client.query(
        `INSERT INTO business_website_pages (business_id, url, page_type, title, cleaned_content, metadata_json, importance_score, content_hash, extracted_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NOW())
         ON CONFLICT (business_id, url) DO UPDATE SET
           page_type = EXCLUDED.page_type,
           title = EXCLUDED.title,
           cleaned_content = EXCLUDED.cleaned_content,
           metadata_json = EXCLUDED.metadata_json,
           importance_score = EXCLUDED.importance_score,
           content_hash = EXCLUDED.content_hash,
           extracted_at = NOW()`,
        [
          businessId,
          url,
          p.page_type || "general",
          cleanText((p.title || "").substring(0, 500)) || null,
          (content && content.substring(0, 15000)) || null,
          metadata_json,
          Number(p.importance_score) || 1,
          (p.content_hash || "").substring(0, 64) || null,
        ],
      );
    }

    if (crawledUrls.size > 0) {
      const urlList = Array.from(crawledUrls);
      // Remove stale pages/chunks not seen in latest crawl to avoid outdated answers.
      await client.query(
        `DELETE FROM business_website_pages
         WHERE business_id = $1
           AND NOT (url = ANY($2::text[]))`,
        [businessId, urlList],
      );
      await client.query(
        `DELETE FROM business_website_chunks
         WHERE business_id = $1
           AND NOT (page_url = ANY($2::text[]))`,
        [businessId, urlList],
      );
    }

    const allChunks = [];
    for (const p of fullPages) {
      const content = cleanText((p.cleaned_content || "").trim());
      if (!content) continue;
      const url = (p.url || "").trim();
      if (!url) continue;
      const pageType = p.page_type || "general";
      const chunks = splitIntoChunks(content);
      for (const c of chunks) {
        if (c) allChunks.push({ page_url: url, page_type: pageType, content_chunk: c });
      }
    }

    if (allChunks.length > 0 && getEmbeddingClient()) {
      const BATCH_SIZE = 50;
      const embeddings = [];
      for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
        const batch = allChunks.slice(i, i + BATCH_SIZE).map((o) => o.content_chunk);
        const batchEmb = await getEmbeddingBatch(batch);
        embeddings.push(...batchEmb);
      }
      await client.query("DELETE FROM business_website_chunks WHERE business_id = $1", [businessId]);
      for (let i = 0; i < allChunks.length; i++) {
        const vec = embeddings[i];
        if (!Array.isArray(vec)) continue;
        const row = allChunks[i];
        await client.query(
          `INSERT INTO business_website_chunks (business_id, page_url, page_type, content_chunk, embedding, extracted_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, NOW())`,
          [businessId, row.page_url, row.page_type, row.content_chunk, JSON.stringify(vec)],
        );
      }
    }

    const siteDigest = buildSiteDigest(fullPages);
    const primaryLanguage = detectLanguageFromPages(fullPages);
    try {
      await client.query(
        `UPDATE business_profiles
         SET website_knowledge = COALESCE(website_knowledge, '{}'::jsonb) || jsonb_build_object('site_digest', $2, 'primary_language', $3),
             website_last_trained_at = NOW(),
             language = COALESCE(language, $3)
         WHERE id = $1`,
        [businessId, siteDigest, primaryLanguage],
      );
    } catch (_) {
      // best effort, do not fail training on profile digest update
    }
  } finally {
    client.release();
  }
}

async function getSummaryContextFromPages(
  businessId,
  userMessage,
  maxPages = MAX_PAGES_RETURN,
) {
  const rowsRes = await pool.query(
    `SELECT url, page_type, title, metadata_json, importance_score
     FROM business_website_pages
     WHERE business_id = $1
     ORDER BY extracted_at DESC
     LIMIT 120`,
    [businessId],
  );
  const rows = rowsRes.rows || [];
  if (!rows.length) {
    return { structured: "", raw: "", evidence: [], retrieval: { mode: "summary", topScore: 0, candidateCount: 0 } };
  }
  const tokens = new Set(normalizeTokens(userMessage));
  const scored = rows
    .map((row) => {
      const meta =
        row.metadata_json && typeof row.metadata_json === "object"
          ? row.metadata_json
          : typeof row.metadata_json === "string"
            ? (() => {
                try {
                  return JSON.parse(row.metadata_json);
                } catch {
                  return {};
                }
              })()
            : {};
      const summary = cleanText(String(meta.page_summary || "").trim());
      if (!summary) return null;
      const text = `${cleanText(row.title || "")} ${summary}`.toLowerCase();
      let keyword = 0;
      tokens.forEach((t) => {
        if (text.includes(t)) keyword += 1;
      });
      const priority = PAGE_TYPE_PRIORITY[row.page_type] || 1;
      const importance = Number(row.importance_score) || 1;
      const urlScore = getUrlRelevanceScore(row.url || "");
      const score = keyword * 0.8 + priority * 0.2 + Math.min(importance, 2) + urlScore;
      return { row, summary, score };
    })
    .filter(Boolean);
  if (!scored.length) {
    return { structured: "", raw: "", evidence: [], retrieval: { mode: "summary", topScore: 0, candidateCount: rows.length } };
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, maxPages);
  const blocks = [];
  const evidence = [];
  for (let i = 0; i < top.length; i++) {
    const item = top[i];
    blocks.push(
      `[${item.row.page_type || "general"}] ${cleanText(item.row.title || item.row.url || "")}\n${item.summary}`,
    );
    evidence.push({
      sourceId: `summary_${i + 1}`,
      url: item.row.url,
      pageType: item.row.page_type || "general",
      score: Number(item.score) || 0,
      excerpt: cleanText(item.summary).substring(0, 260),
    });
  }
  return {
    structured: cleanStructuredContext(
      blocks.join("\n\n---\n\n"),
      MAX_STRUCTURED_TOTAL_CHARS,
    ),
    raw: "",
    evidence,
    retrieval: {
      mode: "summary",
      topScore: Number(top[0]?.score) || 0,
      candidateCount: scored.length,
    },
  };
}

/**
 * Legacy keyword + page-type retrieval (no embeddings). Used when semantic path is unavailable.
 */
async function getRelevantWebsiteContextFromPagesLegacy(businessId, userMessage, maxPages = MAX_PAGES_RETURN) {
  const structured = [];
  const evidence = [];
  const result = await pool.query(
    `SELECT url, page_type, title, cleaned_content, metadata_json, importance_score
     FROM business_website_pages
     WHERE business_id = $1 AND (cleaned_content IS NOT NULL AND cleaned_content != '')
     ORDER BY extracted_at DESC`,
    [businessId],
  );

  const rows = result.rows || [];
  if (rows.length === 0) {
    return {
      structured: "",
      raw: "",
      evidence: [],
      retrieval: { mode: "legacy", topScore: 0, candidateCount: 0 },
    };
  }

  const normalizedMessage = (userMessage || "").toLowerCase();
  const messageTokens = new Set(
    normalizedMessage.split(/[^a-z0-9]+/i).filter((t) => t && t.length >= 2),
  );

  const faqQuestionWords = ["how", "what", "why", "can", "do", "is"];
  const isFaqStyleQuestion = faqQuestionWords.some((w) => normalizedMessage.includes(w));

  const scored = rows.map((row) => {
    const title = cleanText(row.title || "").toLowerCase();
    const content = cleanText(row.cleaned_content || "").toLowerCase();
    let score = (PAGE_TYPE_PRIORITY[row.page_type] || 1) * (Number(row.importance_score) || 1);

    if (messageTokens.size > 0) {
      messageTokens.forEach((tok) => {
        if (title.includes(tok)) score += 2;
        if (content.includes(tok)) score += 1;
      });
    }

    score += getUrlRelevanceScore(row.url || "");

    const meta = row.metadata_json && typeof row.metadata_json === "object"
      ? row.metadata_json
      : typeof row.metadata_json === "string"
        ? (() => { try { return JSON.parse(row.metadata_json); } catch { return {}; } })()
        : {};
    if (meta.meta && typeof meta.meta === "object" && meta.meta.description) {
      const desc = (meta.meta.description || "").toLowerCase();
      if (messageTokens.size > 0) {
        messageTokens.forEach((tok) => {
          if (desc.includes(tok)) score += 1;
        });
      }
    }
    if (Array.isArray(meta.image_alt_texts)) {
      const altText = meta.image_alt_texts.join(" ").toLowerCase();
      if (messageTokens.size > 0) {
        messageTokens.forEach((tok) => {
          if (altText.includes(tok)) score += 1;
        });
      }
    }

    if (row.page_type === "faq" && isFaqStyleQuestion) score += 2;

    return { ...row, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, maxPages);

  let totalChars = 0;

  for (let i = 0; i < top.length; i++) {
    const row = top[i];
    if (totalChars >= MAX_STRUCTURED_TOTAL_CHARS) break;

    const content = cleanText((row.cleaned_content || "").trim());
    const meta = row.metadata_json && typeof row.metadata_json === "object"
      ? row.metadata_json
      : typeof row.metadata_json === "string"
        ? (() => { try { return JSON.parse(row.metadata_json); } catch { return {}; } })()
        : {};

    let contentToInject = "";
    const chunks = Array.isArray(meta.content_chunks) ? meta.content_chunks : [];
    if (chunks.length > 0) {
      const chunkScores = chunks.map((chunk) => {
        const cleaned = cleanText(String(chunk || "").trim());
        const lower = cleaned.toLowerCase();
        let s = 0;
        messageTokens.forEach((tok) => {
          if (lower.includes(tok)) s += 1;
        });
        return { chunk: cleaned, score: s };
      });
      chunkScores.sort((a, b) => b.score - a.score);
      const topChunks = chunkScores.slice(0, 2).map((c) => c.chunk).filter(Boolean);
      contentToInject = topChunks.join("\n\n").trim();
    }
    if (!contentToInject && content) {
      contentToInject = content.length > MAX_CHARS_PER_PAGE ? content.substring(0, MAX_CHARS_PER_PAGE) + "…" : content;
    }
    if (!contentToInject) continue;

    let block = `[${row.page_type}] ${cleanText(row.title || row.url || "")}\n${contentToInject}`;
    if (meta.faqs && meta.faqs.length > 0) {
      const faqText = meta.faqs.slice(0, 5).map((f) => `Q: ${cleanText(f.question || "")}\nA: ${cleanText((f.answer || "").substring(0, 200))}`).join("\n");
      block += "\n\nFAQs:\n" + faqText;
    }
    if (meta.pricing_blocks && meta.pricing_blocks.length > 0) {
      block += "\n\nPricing: " + cleanText(meta.pricing_blocks.slice(0, 2).join(" | ").substring(0, 400));
    }

    const blockLen = block.length;
    const remaining = MAX_STRUCTURED_TOTAL_CHARS - totalChars;
    if (blockLen > remaining) {
      block = block.substring(0, remaining).trim();
    }
    structured.push(block);
    evidence.push({
      sourceId: `legacy_${i + 1}`,
      url: row.url,
      pageType: row.page_type || "general",
      score: Number(row.score) || 0,
      excerpt: cleanText(contentToInject).substring(0, 260),
    });
    totalChars += block.length;
  }

  const structuredText = structured.join("\n\n---\n\n").substring(0, MAX_STRUCTURED_TOTAL_CHARS);
  return {
    structured: cleanStructuredContext(structuredText, MAX_STRUCTURED_TOTAL_CHARS),
    raw: "",
    evidence,
    retrieval: {
      mode: "legacy",
      topScore: Number(top[0]?.score) || 0,
      candidateCount: rows.length,
    },
  };
}

async function getHomepageSnippet(businessId) {
  try {
    const res = await pool.query(
      `SELECT url, title, cleaned_content, page_type FROM business_website_pages
       WHERE business_id = $1
         AND (page_type = 'general' OR page_type = 'about')
         AND (url ~ '/$' OR url ~ '/index\\.html$' OR url ~ '/index$' OR page_type = 'about')
       ORDER BY CASE WHEN url ~ '/$' OR url ~ '/index' THEN 0 ELSE 1 END,
                importance_score DESC
       LIMIT 1`,
      [businessId],
    );
    const row = res.rows && res.rows[0];
    if (!row) return null;
    const content = cleanText((row.cleaned_content || "").trim());
    if (!content) return null;
    return {
      block: `[homepage] ${cleanText(row.title || row.url || "")}\n${content.substring(0, 500)}`,
      evidence: {
        sourceId: "homepage_identity",
        url: row.url,
        pageType: row.page_type || "general",
        score: 10,
        excerpt: content.substring(0, 260),
      },
    };
  } catch (_) {
    return null;
  }
}

const CONTEXT_CACHE_TTL = 45;

/**
 * Get relevant website context: semantic retrieval when available, then merge with keyword + page-type; else legacy keyword-only.
 */
async function getRelevantWebsiteContextFromPages(businessId, userMessage, maxPages = MAX_PAGES_RETURN) {
  const msgNorm = String(userMessage || "").trim().slice(0, 500);
  const cacheKey = `ctx:${businessId}:${crypto.createHash("sha256").update(msgNorm).digest("hex").slice(0, 16)}`;
  if (redis.REDIS_URL) {
    try {
      const cached = await redis.cacheGet(cacheKey);
      if (cached && typeof cached === "object") return cached;
    } catch (_) {}
  }

  const homepageSnippet = await getHomepageSnippet(businessId);

  const summaryContext = await getSummaryContextFromPages(
    businessId,
    userMessage,
    Math.max(3, Math.min(maxPages, 6)),
  );

  const normalizedMessage = (userMessage || "").trim();
  const messageTokens = new Set(
    (userMessage || "").toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t && t.length >= 2),
  );

  const chunkRows = await pool.query(
    `SELECT page_url, page_type, content_chunk, embedding
     FROM business_website_chunks
     WHERE business_id = $1 AND embedding IS NOT NULL`,
    [businessId],
  );
  const chunksWithEmbedding = (chunkRows.rows || []).filter((r) => r.embedding != null);

  const FACTUAL_QUERY_WORDS = ["hours", "open", "opening", "location", "address", "phone", "contact", "price", "cost"];
  const msgLower = (userMessage || "").toLowerCase();
  const hasFactualQuery = FACTUAL_QUERY_WORDS.some((w) => msgLower.includes(w));

  if (chunksWithEmbedding.length > 0 && getEmbeddingClient()) {
    const msgEmbedding = await getEmbedding(normalizedMessage || "general inquiry");
    if (Array.isArray(msgEmbedding) && msgEmbedding.length > 0) {
      const withScore = chunksWithEmbedding.map((row) => {
        const vec = typeof row.embedding === "string" ? (() => { try { return JSON.parse(row.embedding); } catch { return []; } })() : (Array.isArray(row.embedding) ? row.embedding : []);
        const semantic = cosineSimilarity(msgEmbedding, vec);
        const lower = (row.content_chunk || "").toLowerCase();
        let keywordScore = 0;
        messageTokens.forEach((tok) => { if (lower.includes(tok)) keywordScore += 1; });
        let factualBoost = 0;
        if (hasFactualQuery) {
          FACTUAL_QUERY_WORDS.forEach((w) => {
            if (msgLower.includes(w) && lower.includes(w)) factualBoost += 1.0;
          });
        }
        const priority = PAGE_TYPE_PRIORITY[row.page_type] || 1;
        const urlScore = getUrlRelevanceScore(row.page_url || "");
        const combined =
          semantic * 0.40 +
          keywordScore * 0.35 +
          priority * 0.15 +
          urlScore * 0.1 +
          factualBoost;
        return { ...row, semantic, keywordScore, combined };
      });
      withScore.sort((a, b) => b.combined - a.combined);
      const topChunks = withScore.slice(0, SEMANTIC_TOP_K);
      const byPageType = [...topChunks].sort((a, b) => (PAGE_TYPE_PRIORITY[b.page_type] || 1) - (PAGE_TYPE_PRIORITY[a.page_type] || 1));
      const structured = [];
      const evidence = [];
      let totalChars = 0;
      for (let i = 0; i < byPageType.length; i++) {
        const row = byPageType[i];
        if (totalChars >= MAX_STRUCTURED_TOTAL_CHARS) break;
        const title = row.page_url;
        const chunkText = cleanText(String(row.content_chunk || "").trim());
        let block = `[${row.page_type}] ${title}\n${chunkText}`;
        const remaining = MAX_STRUCTURED_TOTAL_CHARS - totalChars;
        if (block.length > remaining) block = block.substring(0, remaining).trim();
        structured.push(block);
        evidence.push({
          sourceId: `semantic_${i + 1}`,
          url: row.page_url,
          pageType: row.page_type || "general",
          score: Number(row.combined) || 0,
          excerpt: chunkText.substring(0, 260),
        });
        totalChars += block.length;
      }
      const structuredText = structured.join("\n\n---\n\n").substring(0, MAX_STRUCTURED_TOTAL_CHARS);
      if (structuredText) {
        const mergedStructured = cleanStructuredContext([
          homepageSnippet ? homepageSnippet.block : "",
          summaryContext && summaryContext.structured ? summaryContext.structured : "",
          structuredText,
        ]
          .filter(Boolean)
          .join("\n\n---\n\n"), MAX_STRUCTURED_TOTAL_CHARS);
        const mergedEvidence = [
          ...(homepageSnippet ? [homepageSnippet.evidence] : []),
          ...(summaryContext?.evidence || []),
          ...evidence,
        ]
          .slice(0, 12)
          .sort((a, b) => getUrlRelevanceScore(b.url || "") - getUrlRelevanceScore(a.url || ""));
        const out1 = {
          structured: mergedStructured,
          raw: "",
          evidence: mergedEvidence,
          retrieval: {
            mode: summaryContext?.structured ? "summary+semantic" : "semantic",
            topScore: Number(withScore[0]?.combined) || 0,
            candidateCount: withScore.length,
          },
        };
        if (redis.REDIS_URL) redis.cacheSet(cacheKey, out1, CONTEXT_CACHE_TTL).catch(() => {});
        return out1;
      }
    }
  }

  if ((summaryContext?.structured || "").trim() || homepageSnippet) {
    const parts = [
      homepageSnippet ? homepageSnippet.block : "",
      (summaryContext?.structured || "").trim(),
    ].filter(Boolean);
    const out2 = {
      structured: cleanStructuredContext(
        parts.join("\n\n---\n\n"),
        MAX_STRUCTURED_TOTAL_CHARS,
      ),
      raw: "",
      evidence: [
        ...(homepageSnippet ? [homepageSnippet.evidence] : []),
        ...(summaryContext?.evidence || []),
      ]
        .slice(0, 12)
        .sort((a, b) => getUrlRelevanceScore(b.url || "") - getUrlRelevanceScore(a.url || "")),
      retrieval: {
        mode: homepageSnippet && !(summaryContext?.structured || "").trim() ? "homepage_only" : "summary_only",
        topScore: Number(summaryContext?.retrieval?.topScore) || (homepageSnippet ? 1 : 0),
        candidateCount: Number(summaryContext?.retrieval?.candidateCount) || (homepageSnippet ? 1 : 0),
      },
    };
    if (redis.REDIS_URL) redis.cacheSet(cacheKey, out2, CONTEXT_CACHE_TTL).catch(() => {});
    return out2;
  }
  const out3 = {
    structured: "",
    raw: "",
    evidence: [],
    retrieval: { mode: "none", topScore: 0, candidateCount: 0 },
  };
  if (redis.REDIS_URL) redis.cacheSet(cacheKey, out3, CONTEXT_CACHE_TTL).catch(() => {});
  return out3;
}

/**
 * Build naive auto-fill from page rows (concatenate by type). Used as fallback when AI summarization fails.
 * @param {Array} rows
 * @returns {{ description: string, services: string, pricing: string, faqs: string }}
 */
function buildNaiveAutofillFromRows(rows) {
  let description = "";
  let services = "";
  let pricing = "";
  let faqs = "";
  for (const row of rows) {
    const content = (row.cleaned_content || "").trim().substring(0, 3000);
    const meta = row.metadata_json && typeof row.metadata_json === "object"
      ? row.metadata_json
      : typeof row.metadata_json === "string"
        ? (() => { try { return JSON.parse(row.metadata_json); } catch { return {}; } })()
        : {};
    if (row.page_type === "about" && content && !description) description = content;
    if (row.page_type === "services" && content) services += (services ? "\n\n" : "") + (row.title ? row.title + "\n" : "") + content;
    if (row.page_type === "pricing" && content) pricing += (pricing ? "\n\n" : "") + (row.title ? row.title + "\n" : "") + content;
    if (row.page_type === "faq" && meta.faqs && meta.faqs.length) {
      faqs += (faqs ? "\n\n" : "") + meta.faqs.map((f) => `Q: ${f.question}\nA: ${(f.answer || "").substring(0, 500)}`).join("\n\n");
    }
  }
  if (!description && rows.length > 0) description = (rows[0].cleaned_content || "").trim().substring(0, 2000);
  return { description, services, pricing, faqs };
}

/**
 * Get structured auto-fill via Claude. Falls back to naive concatenation on failure.
 * @param {number} businessId
 * @returns {{ description: string, services: string, pricing: string, faqs: string }}
 */
async function getAutoFillFromPages(businessId) {
  const result = await pool.query(
    `SELECT page_type, title, cleaned_content, metadata_json
     FROM business_website_pages
     WHERE business_id = $1
     ORDER BY CASE page_type WHEN 'about' THEN 1 WHEN 'services' THEN 2 WHEN 'pricing' THEN 3 WHEN 'faq' THEN 4 ELSE 5 END, extracted_at DESC`,
    [businessId],
  );
  const rows = result.rows || [];
  const naive = buildNaiveAutofillFromRows(rows);

  const aboutBlock = (naive.description || "").trim();
  const servicesBlock = (naive.services || "").trim();
  const pricingBlock = (naive.pricing || "").trim();
  const faqsBlock = (naive.faqs || "").trim();
  let payload = "";
  if (aboutBlock) payload += "About:\n" + aboutBlock + "\n\n";
  if (servicesBlock) payload += "Services:\n" + servicesBlock + "\n\n";
  if (pricingBlock) payload += "Pricing:\n" + pricingBlock + "\n\n";
  if (faqsBlock) payload += "FAQs:\n" + faqsBlock;
  payload = payload.trim();
  if (!payload) return naive;

  const truncated = payload.length > AUTOFILL_MAX_INPUT_CHARS
    ? payload.substring(0, AUTOFILL_MAX_INPUT_CHARS) + "\n[...truncated]"
    : payload;

  const systemInstruction = `Summarize this website content into exactly this JSON (use only these keys; values must be strings):
{
  "description": "short paragraph about the business",
  "services": "bullet list or short summary of services",
  "pricing": "concise pricing summary",
  "faqs": "clean Q&A list, one line per Q and A"
}
Return only valid JSON, no markdown or extra text.`;

  try {
    const completion = await callClaude(
      systemInstruction,
      [{ role: "user", content: truncated }],
      1500,
    );
    const raw = completion.content;
    if (!raw || typeof raw !== "string") return naive;
    const sanitized = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(sanitized);
    const description = typeof parsed.description === "string" ? parsed.description : "";
    const services = typeof parsed.services === "string" ? parsed.services : "";
    const pricing = typeof parsed.pricing === "string" ? parsed.pricing : "";
    const faqs = typeof parsed.faqs === "string" ? parsed.faqs : "";
    return { description, services, pricing, faqs };
  } catch (_) {
    return naive;
  }
}

/**
 * Build a short high-level summary of the business from stored pages and profile data.
 * Used to give the AI a baseline understanding even when chunk-level retrieval is weak.
 * @param {number} businessId
 * @param {object} [profile] - business_profiles row (may contain website_knowledge JSONB)
 * @param {object} [knowledge] - business_knowledge row (may contain description)
 * @returns {Promise<string>}
 */
async function buildBusinessContextSummary(businessId, profile, knowledge) {
  const MAX_SUMMARY_CHARS = 800;
  const parts = [];

  if (knowledge && knowledge.description) {
    parts.push(String(knowledge.description).trim().slice(0, 300));
  }

  const wk = profile && profile.website_knowledge;
  if (wk) {
    try {
      const obj = typeof wk === "string" ? JSON.parse(wk) : wk;
      if (obj.site_digest) {
        parts.push(String(obj.site_digest).trim().slice(0, 500));
      }
    } catch (_) {}
  }

  if (parts.length === 0) {
    try {
      const result = await pool.query(
        `SELECT title, cleaned_content, page_type
         FROM business_website_pages
         WHERE business_id = $1
         ORDER BY CASE page_type WHEN 'about' THEN 1 WHEN 'services' THEN 2 ELSE 3 END, extracted_at ASC
         LIMIT 3`,
        [businessId],
      );
      for (const row of (result.rows || [])) {
        const title = (row.title || "").trim();
        const content = summarizePageContent(row.cleaned_content || "");
        if (title || content) {
          parts.push(`${title}${content ? ": " + content : ""}`);
        }
      }
    } catch (_) {}
  }

  if (parts.length === 0) return "";
  const combined = parts.join("\n").trim();
  return combined.length > MAX_SUMMARY_CHARS
    ? combined.slice(0, MAX_SUMMARY_CHARS).trim()
    : combined;
}

const NAV_PATTERNS = [
  { key: "catalog", patterns: [/\/catal[oe]g[oe]?/i, /\/shop/i, /\/tienda/i] },
  { key: "products", patterns: [/\/products?/i, /\/productos?/i] },
  { key: "services", patterns: [/\/services?/i, /\/servicios?/i] },
  { key: "pricing", patterns: [/\/pricing/i, /\/precios?/i, /\/planes?/i, /\/plans?/i] },
  { key: "contact", patterns: [/\/contact[oe]?/i, /\/contacto/i] },
  { key: "about", patterns: [/\/about/i, /\/nosotros/i, /\/acerca/i, /\/quienes-somos/i] },
  { key: "blog", patterns: [/\/blogs?/i, /\/noticias/i, /\/news/i] },
  { key: "faq", patterns: [/\/faqs?/i, /\/preguntas/i] },
];

/**
 * Analyse indexed page URLs and detect important navigation pages based on
 * common URL patterns. Returns a map of page role -> URL.
 *
 * @param {Array<{ url: string }>} pages - rows from business_website_pages (only url is required)
 * @returns {Record<string, string>} e.g. { catalog: "https://site.com/catalog", contact: "https://site.com/contact" }
 */
function buildWebsiteNavigationMap(pages) {
  const result = {};
  if (!Array.isArray(pages) || pages.length === 0) return result;

  for (const { key, patterns } of NAV_PATTERNS) {
    let best = null;
    let bestDepth = Infinity;
    for (const page of pages) {
      const url = (page.url || "").trim();
      if (!url) continue;
      try {
        const u = new URL(url);
        const pathname = u.pathname || "/";
        const depth = pathname.split("/").filter(Boolean).length;
        if (patterns.some((re) => re.test(pathname)) && depth < bestDepth) {
          best = url;
          bestDepth = depth;
        }
      } catch (_) {
        continue;
      }
    }
    if (best) result[key] = best;
  }
  return result;
}

/**
 * Format the navigation map as a text block suitable for inclusion in the system prompt.
 * @param {Record<string, string>} navMap
 * @returns {string}
 */
function formatNavigationMapBlock(navMap) {
  if (!navMap || typeof navMap !== "object") return "";
  const entries = Object.entries(navMap).filter(([, v]) => v);
  if (entries.length === 0) return "";
  const lines = entries.map(
    ([key, url]) => `${key.charAt(0).toUpperCase() + key.slice(1)}: ${url}`,
  );
  return lines.join("\n");
}

module.exports = {
  storeCrawledPages,
  getRelevantWebsiteContextFromPages,
  getAutoFillFromPages,
  buildBusinessContextSummary,
  getEmbedding,
  getEmbeddingBatch,
  cosineSimilarity,
  getEmbeddingClient,
  buildWebsiteNavigationMap,
  formatNavigationMapBlock,
};
