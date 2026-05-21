const fetch = require("node-fetch");
const { URL } = require("url");
const pool = require("./db");
const { extractStructuredPageData } = require("./contentExtractor");

const DEFAULT_MAX_STEPS = 2;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_TOTAL_BUDGET_MS = 12000;
const MAX_TOTAL_CONTEXT_CHARS = 3000;

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t && t.length >= 2);
}

function parseBaseOrigin(websiteUrl) {
  try {
    const normalized = String(websiteUrl || "").trim();
    if (!normalized) return null;
    const withScheme = normalized.startsWith("http")
      ? normalized
      : `https://${normalized}`;
    return new URL(withScheme).origin;
  } catch (_) {
    return null;
  }
}

function isSameDomain(candidateUrl, baseOrigin) {
  if (!candidateUrl || !baseOrigin) return false;
  try {
    const base = new URL(baseOrigin);
    const candidate = new URL(candidateUrl);
    return candidate.origin === base.origin;
  } catch (_) {
    return false;
  }
}

function scorePageForQuery(row, queryTokens) {
  const title = String(row.title || "").toLowerCase();
  const url = String(row.url || "").toLowerCase();
  const content = String(row.cleaned_content || "").toLowerCase();
  let score = 0;
  for (const tok of queryTokens) {
    if (title.includes(tok)) score += 3;
    if (url.includes(tok)) score += 2;
    if (content.includes(tok)) score += 1;
  }
  if (/pricing|price|plans/.test(url)) score += 1;
  if (/faq|help|support/.test(url)) score += 1;
  return score;
}

async function searchSitePages(businessId, query, maxCandidates = 8) {
  const result = await pool.query(
    `SELECT url, page_type, title, cleaned_content, extracted_at
     FROM business_website_pages
     WHERE business_id = $1
     ORDER BY extracted_at DESC
     LIMIT 120`,
    [businessId],
  );
  const rows = result.rows || [];
  const queryTokens = tokenize(query);
  const ranked = rows
    .map((row) => ({
      ...row,
      score: scorePageForQuery(row, queryTokens),
    }))
    .sort((a, b) => b.score - a.score);
  return ranked.slice(0, maxCandidates);
}

async function discoverLiveCandidates(baseOrigin, query, maxCandidates = 10) {
  const homepage = `${String(baseOrigin || "").replace(/\/$/, "")}/`;
  const html = await fetchPageHtml(homepage, DEFAULT_TIMEOUT_MS);
  const hrefMatches = String(html || "").match(/href\s*=\s*["']([^"']+)["']/gi) || [];
  const discovered = new Set([homepage]);

  for (const raw of hrefMatches) {
    const m = raw.match(/href\s*=\s*["']([^"']+)["']/i);
    const href = m && m[1] ? m[1].trim() : "";
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
    try {
      const full = new URL(href, homepage).href;
      if (!isSameDomain(full, baseOrigin)) continue;
      discovered.add(full.split("#")[0]);
    } catch (_) {
      // ignore invalid
    }
  }

  const queryTokens = tokenize(query);
  const ranked = Array.from(discovered)
    .map((url) => {
      const lower = url.toLowerCase();
      let score = 0;
      for (const tok of queryTokens) {
        if (lower.includes(tok)) score += 2;
      }
      if (/casos|exito|clientes/.test(lower)) score += 2;
      if (/servicios|pricing|contact|nosotros|about/.test(lower)) score += 1;
      return { url, page_type: "general", title: url, cleaned_content: "", score };
    })
    .sort((a, b) => b.score - a.score);

  return ranked.slice(0, maxCandidates);
}

async function fetchPageHtml(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "AI-Sales-Agent-LiveNav/1.0" },
      follow: 3,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      throw new Error("Non-HTML response");
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractFactsFromHtml(html, url) {
  const structured = extractStructuredPageData(html, url);
  const clean = String(structured.cleaned_content || "").trim().slice(0, 1200);
  const pricing = Array.isArray(structured.metadata_json?.pricing_blocks)
    ? structured.metadata_json.pricing_blocks.slice(0, 2).join(" | ")
    : "";
  const faqText = Array.isArray(structured.metadata_json?.faqs)
    ? structured.metadata_json.faqs
        .slice(0, 2)
        .map((f) => `Q: ${f.question} A: ${f.answer}`)
        .join(" ")
    : "";

  const blockParts = [];
  if (clean) blockParts.push(clean);
  if (pricing) blockParts.push(`Pricing: ${pricing}`);
  if (faqText) blockParts.push(`FAQ: ${faqText}`);
  const snippet = blockParts.join("\n").slice(0, 1400);

  return {
    title: structured.title || url,
    pageType: structured.page_type || "general",
    snippet,
  };
}

async function getLiveNavigationContext(options) {
  const {
    businessId,
    query,
    websiteUrl,
    maxSteps = DEFAULT_MAX_STEPS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    totalBudgetMs = DEFAULT_TOTAL_BUDGET_MS,
  } = options || {};

  const baseOrigin = parseBaseOrigin(websiteUrl);
  if (!businessId || !query || !baseOrigin) {
    return { structured: "", evidence: [], stats: { used: false, reason: "missing_inputs" } };
  }

  const start = Date.now();
  const candidates = await searchSitePages(businessId, query, 10);
  let sameDomainCandidates = candidates.filter((c) =>
    isSameDomain(c.url, baseOrigin),
  );
  if (sameDomainCandidates.length === 0) {
    try {
      sameDomainCandidates = await discoverLiveCandidates(baseOrigin, query, 10);
    } catch (_) {
      sameDomainCandidates = [];
    }
  }
  if (sameDomainCandidates.length === 0) {
    return { structured: "", evidence: [], stats: { used: false, reason: "no_candidates" } };
  }

  const picked = [];
  for (const c of sameDomainCandidates) {
    if (picked.length >= maxSteps) break;
    if (Date.now() - start > totalBudgetMs) break;
    picked.push(c);
  }

  const evidence = [];
  const blocks = [];
  for (let i = 0; i < picked.length; i++) {
    const row = picked[i];
    if (Date.now() - start > totalBudgetMs) break;
    try {
      const html = await fetchPageHtml(row.url, timeoutMs);
      const facts = extractFactsFromHtml(html, row.url);
      if (!facts.snippet) continue;
      evidence.push({
        sourceId: `nav_${i + 1}`,
        url: row.url,
        pageType: row.page_type || "general",
        score: Number(row.score) || 0,
        excerpt: facts.snippet.slice(0, 260),
      });
      blocks.push(`[live_nav] ${facts.title}\n${facts.snippet}`);
    } catch (_) {
      // best effort only
    }
  }

  const structured = blocks.join("\n\n---\n\n").slice(0, MAX_TOTAL_CONTEXT_CHARS);
  return {
    structured,
    evidence,
    stats: {
      used: evidence.length > 0,
      reason: evidence.length > 0 ? "ok" : "fetch_failed",
      visitedCount: evidence.length,
      candidateCount: sameDomainCandidates.length,
      elapsedMs: Date.now() - start,
      baseOrigin,
    },
  };
}

module.exports = {
  getLiveNavigationContext,
};
