#!/usr/bin/env node
/**
 * One-off audit script: RAG injection, DB state, embeddings, prompt dump.
 * Usage: node scripts/run-agent-audit.js <businessId> ["What services do you offer?"]
 * Requires: .env with ANTHROPIC_API_KEY, VOYAGE_API_KEY, and DB connection (same as server).
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const pool = require("../services/db");
const { getRelevantWebsiteContextFromPages } = require("../services/websiteContextService");
const { buildSystemPrompt } = require("../services/aiService");

async function main() {
  const businessId = parseInt(process.argv[2], 10);
  const testMessage = process.argv[3] || "What services do you offer?";
  if (!businessId || isNaN(businessId)) {
    console.error("Usage: node scripts/run-agent-audit.js <businessId> [\"test message\"]");
    process.exit(1);
  }

  console.log("=== AI AGENT AUDIT ===\n");
  console.log("Business ID:", businessId);
  console.log("Test message:", testMessage);
  console.log("");

  // --- DB state ---
  const [pagesRes, chunksRes, productsRes] = await Promise.all([
    pool.query("SELECT id, url, page_type, title, LEFT(cleaned_content, 200) AS content_preview FROM business_website_pages WHERE business_id = $1", [businessId]),
    pool.query("SELECT id, page_url, page_type, LEFT(content_chunk, 300) AS chunk_preview, (embedding IS NOT NULL) AS has_embedding, embedding FROM business_website_chunks WHERE business_id = $1 LIMIT 10", [businessId]),
    pool.query("SELECT id, title, description, price, page_url FROM business_products WHERE business_id = $1 LIMIT 20", [businessId]),
  ]);

  const pageCount = (pagesRes.rows || []).length;
  const chunkCount = (chunksRes.rows || []).length;
  const productCount = (productsRes.rows || []).length;

  console.log("--- 3. DATABASE STATE ---");
  console.log("business_website_pages count:", pageCount);
  console.log("business_website_chunks count:", chunkCount);
  console.log("business_products count:", productCount);
  console.log("");

  if (chunksRes.rows && chunksRes.rows.length > 0) {
    console.log("3 sample chunks:");
    chunksRes.rows.slice(0, 3).forEach((r, i) => {
      const dims = r.embedding && (Array.isArray(r.embedding) ? r.embedding.length : (typeof r.embedding === "string" ? (() => { try { return JSON.parse(r.embedding).length; } catch { return 0; } })() : 0));
      console.log(`  [${i + 1}] page_url=${r.page_url} page_type=${r.page_type} has_embedding=${r.has_embedding} dims=${dims || "n/a"}`);
      console.log(`      preview: ${(r.chunk_preview || "").substring(0, 120)}...`);
    });
    console.log("");
  }

  if (pagesRes.rows && pagesRes.rows.length > 0) {
    console.log("3 sample page records:");
    pagesRes.rows.slice(0, 3).forEach((r, i) => {
      console.log(`  [${i + 1}] url=${r.url} page_type=${r.page_type} title=${r.title || "(none)"}`);
      console.log(`      content_preview: ${(r.content_preview || "").substring(0, 100)}...`);
    });
    console.log("");
  }

  // --- Website context (RAG) ---
  let websiteContext = { structured: "", raw: "" };
  try {
    websiteContext = await getRelevantWebsiteContextFromPages(businessId, testMessage, 5);
  } catch (e) {
    console.log("getRelevantWebsiteContextFromPages error:", e.message);
  }

  console.log("--- 2. RAG INJECTION VERIFICATION ---");
  console.log("websiteContextStructured length:", (websiteContext.structured || "").length);
  console.log("websiteContextStructured (first 800 chars):");
  console.log((websiteContext.structured || "(empty)").substring(0, 800));
  console.log("");
  console.log("websiteContextRaw length:", (websiteContext.raw || "").length);
  console.log("websiteContextRaw (first 400 chars):", (websiteContext.raw || "(empty)").substring(0, 400));
  console.log("");

  // Manual knowledge
  const profileRes = await pool.query(
    "SELECT bp.*, u.is_paid FROM business_profiles bp JOIN users u ON bp.user_id = u.id WHERE bp.id = $1",
    [businessId]
  );
  const businessProfile = profileRes.rows[0] || null;
  let knowledge = null;
  if (businessProfile) {
    const knowledgeRes = await pool.query("SELECT * FROM business_knowledge WHERE user_id = $1", [businessProfile.user_id]);
    knowledge = knowledgeRes.rows[0] || null;
  }

  console.log("Manual knowledge (business_knowledge):", knowledge ? "present" : "null/empty");
  if (knowledge) {
    console.log("  description length:", (knowledge.description || "").length);
    console.log("  services length:", (knowledge.services || "").length);
    console.log("  pricing length:", (knowledge.pricing || "").length);
    console.log("  faqs length:", (knowledge.faqs || "").length);
  }
  console.log("");

  // Products (as passed to agent - after semantic filter in real flow we'd have filtered list)
  console.log("Products array (raw from DB, first 5):", productsRes.rows ? productsRes.rows.slice(0, 5) : []);
  console.log("");

  // --- Embedding check ---
  const chunksWithEmbedding = (chunksRes.rows || []).filter((r) => r.embedding != null);
  let embeddingDims = 0;
  const firstWithEmb = chunksRes.rows && chunksRes.rows.find((r) => r.embedding != null);
  if (firstWithEmb && firstWithEmb.embedding) {
    const arr = Array.isArray(firstWithEmb.embedding) ? firstWithEmb.embedding : (typeof firstWithEmb.embedding === "string" ? (() => { try { return JSON.parse(firstWithEmb.embedding); } catch { return []; } })() : []);
    embeddingDims = arr.length;
  }
  console.log("--- 4. EMBEDDING CHECK ---");
  console.log("Chunks with non-null embedding:", chunksWithEmbedding.length);
  console.log("Embedding dimensions (from first chunk):", embeddingDims || "(none)");
  console.log("Cosine similarity: computed inside getRelevantWebsiteContextFromPages; top chunks by combined score (semantic + keyword + page-type).");
  console.log("(Top 5 chunk similarity scores are computed in getRelevantWebsiteContextFromPages but not logged; add logging there to print.)");
  console.log("");

  // --- System prompt dump ---
  if (businessProfile) {
    const intent = "General question";
    const systemPrompt = buildSystemPrompt(businessProfile, knowledge, intent, {
      userMessage: testMessage,
      emailAlreadyProvided: false,
      buyingSignalCount: 0,
      products: [],
      platformKnowledgeBlock: null,
      websiteContextStructured: websiteContext.structured,
      websiteContextRaw: websiteContext.raw,
    });
    console.log("--- 5. PROMPT STRUCTURE (buildSystemPrompt order) ---");
    console.log("Active blocks: roleAndGoals, identityLock, businessProfileBlock, websiteKnowledgeBlock, groundingRule, businessKnowledgeBlock, knowledgePriorityNote, conversationBehavior, dataUsageRules, style.");
    console.log("Commented out: intentHandling, rules. productsBlock is empty string so never added.");
    console.log("");
    console.log("--- FULL SYSTEM PROMPT (first 4000 chars) ---");
    console.log(systemPrompt.substring(0, 4000));
    if (systemPrompt.length > 4000) console.log("\n... [truncated, total " + systemPrompt.length + " chars]");
    console.log("");

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "system", content: "Always reply in the same language the user is using. Never switch languages mid-conversation." },
      { role: "user", content: testMessage.trim() },
    ];
    console.log("--- FINAL MESSAGES ARRAY SENT TO AI ---");
    console.log(JSON.stringify(messages.map((m) => ({ role: m.role, contentLength: (m.content || "").length })), null, 2));
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
