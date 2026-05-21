const { crawlWebsite } = require("./crawler");
const { storeCrawledPages } = require("./websiteContextService");
const { saveProductsFromCrawlResult } = require("./productTrainingService");
const { detectLanguageFromPages } = require("./languageDetectionService");
const pool = require("./db");

function inferWebsiteType(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return "general";
  const urls = pages.map((p) => (p.url || "").toLowerCase());
  const types = pages.map((p) => (p.page_type || "general").toLowerCase());
  const allContent = pages
    .map((p) => (p.cleaned_content || "").substring(0, 500).toLowerCase())
    .join(" ");

  const productPages = types.filter((t) => t === "product" || t === "catalog").length;
  if (productPages >= 3) return "ecommerce";
  if (["shop", "store", "cart", "product"].some((w) => urls.some((u) => u.includes(w)))) return "ecommerce";

  if (["menu", "reservation", "restaurante", "restaurant"].some((w) => urls.some((u) => u.includes(w)))) return "restaurant";
  if (["menu item", "appetizer", "entrée", "dessert", "reservat"].some((w) => allContent.includes(w))) return "restaurant";

  const blogPages = types.filter((t) => t === "blog" || t === "article").length;
  if (blogPages >= 3) return "blog";
  if (urls.some((u) => /\/blog\/|\/article\/|\/post\//.test(u))) return "blog";

  if (["portfolio", "case-study", "case_study", "our-work"].some((w) => urls.some((u) => u.includes(w)))) return "portfolio";

  if (["pricing", "features", "documentation", "docs", "api"].some((w) => urls.some((u) => u.includes(w)))) return "saas";
  if (["sign up", "free trial", "pricing plan", "subscription"].some((w) => allContent.includes(w))) return "saas";

  const servicePages = types.filter((t) => t === "services").length;
  if (servicePages >= 1) return "service";
  if (["services", "booking", "appointment", "consultation"].some((w) => urls.some((u) => u.includes(w)))) return "service";

  return "general";
}

const MAX_JOBS = Math.max(
  100,
  Number(process.env.AGENT_QUEUE_MAX_JOBS || 500) || 500,
);
const CONCURRENCY = Math.max(
  1,
  Number(process.env.AGENT_QUEUE_CONCURRENCY || 1) || 1,
);
const JOB_TIMEOUT_MS = Number(process.env.TRAINING_JOB_TIMEOUT_MS || 120000) || 120000;
const MAX_RETRIES = 3;
const jobs = new Map();
const queue = [];
const indexingProgress = new Map();
let running = 0;

function createJobId() {
  return `train_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanupOldJobs() {
  if (jobs.size <= MAX_JOBS) return;
  const sorted = Array.from(jobs.values()).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  const removeCount = jobs.size - MAX_JOBS;
  for (let i = 0; i < removeCount; i++) {
    jobs.delete(sorted[i].id);
  }
}

function runTrainingJobWithTimeout(job) {
  return Promise.race([
    runTrainingJob(job),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Job timeout")), JOB_TIMEOUT_MS),
    ),
  ]);
}

async function runTrainingJob(job) {
  const { businessId, url } = job.payload;
  await pool.query(
    "UPDATE business_profiles SET website_training_status = $1 WHERE id = $2",
    ["training", businessId],
  ).catch(() => {});

  await pool.query(
    "DELETE FROM business_website_chunks WHERE business_id = $1",
    [businessId],
  ).catch(() => {});
  await pool.query(
    "DELETE FROM business_website_pages WHERE business_id = $1",
    [businessId],
  ).catch(() => {});

  indexingProgress.set(businessId, 0);

  const crawlResult = await crawlWebsite(url, {
    onProgress: (processed, total) => {
      const pct = Math.floor((processed / Math.max(total, 1)) * 100);
      indexingProgress.set(businessId, Math.min(pct, 99));
    },
  });
  const fullPages = (crawlResult && crawlResult.fullPages) || [];
  const pages = (crawlResult && crawlResult.pages) || [];

  await storeCrawledPages(businessId, fullPages);
  const productResult = await saveProductsFromCrawlResult(businessId, pages);
  const productCount = productResult.count ?? 0;

  const websiteType = inferWebsiteType(fullPages);
  const detectedLanguage = detectLanguageFromPages(fullPages);

  const legacyKnowledge = {
    source_url: url,
    primary_language: detectedLanguage,
    raw_text: fullPages
      .map((p) => (p.cleaned_content || "").substring(0, 2000))
      .join("\n\n")
      .substring(0, 50000),
    sections: fullPages.slice(0, 30).map((p) => ({
      title: p.title || p.url,
      content: (p.cleaned_content || "").substring(0, 1500),
    })),
  };
  await pool
    .query(
      `UPDATE business_profiles
       SET website_knowledge = $1, website_training_status = $2, website_last_trained_at = NOW(),
           website_url = $3, website_type = $4, detected_language = $5
       WHERE id = $6`,
      [JSON.stringify(legacyKnowledge), "trained", url, websiteType, detectedLanguage, businessId],
    )
    .catch(() => {});

  indexingProgress.set(businessId, 100);

  return {
    productCount,
    pageCount: fullPages.length,
  };
}

async function processQueue() {
  if (running >= CONCURRENCY) return;
  const nextId = queue.shift();
  if (!nextId) return;
  const job = jobs.get(nextId);
  if (!job) return;

  running += 1;
  job.status = "running";
  job.startedAt = new Date().toISOString();
  job.queueWaitMs = Math.max(
    0,
    Date.now() - new Date(job.createdAt).getTime(),
  );
  try {
    const result = await runTrainingJobWithTimeout(job);
    job.status = "completed";
    job.result = result;
    job.finishedAt = new Date().toISOString();
  } catch (err) {
    const retryCount = (job.retryCount || 0) + 1;
    job.retryCount = retryCount;
    if (retryCount < MAX_RETRIES) {
      job.status = "queued";
      job.startedAt = null;
      job.error = null;
      queue.push(nextId);
    } else {
      job.status = "failed";
      job.error = err.message || "Training failed.";
      job.finishedAt = new Date().toISOString();
      const businessId = job.payload && job.payload.businessId;
      console.error("TRAINING_JOB_FAILED:", { jobId: job.id, businessId, error: job.error, retries: job.retryCount });
      if (businessId) {
        await pool
          .query(
            "UPDATE business_profiles SET website_training_status = $1 WHERE id = $2",
            ["failed", businessId],
          )
          .catch(() => {});
      }
    }
  } finally {
    running -= 1;
    setImmediate(processQueue);
  }
}

function enqueueTrainingJob(payload) {
  const id = createJobId();
  const job = {
    id,
    type: "website_training",
    status: "queued",
    payload,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
    retryCount: 0,
  };
  jobs.set(id, job);
  queue.push(id);
  cleanupOldJobs();
  setImmediate(processQueue);
  return job;
}

function getTrainingJob(jobId) {
  return jobs.get(jobId) || null;
}

function hasActiveTrainingJob(businessId) {
  const bid = Number(businessId);
  if (!Number.isInteger(bid)) return false;
  for (const job of jobs.values()) {
    if (job.payload && Number(job.payload.businessId) === bid && (job.status === "queued" || job.status === "running")) {
      return true;
    }
  }
  return false;
}

function getTrainingQueueStats() {
  const values = Array.from(jobs.values());
  const queued = values.filter((j) => j.status === "queued").length;
  const runningJobs = values.filter((j) => j.status === "running").length;
  const completed = values.filter((j) => j.status === "completed").length;
  const failed = values.filter((j) => j.status === "failed").length;
  return {
    queued,
    running: runningJobs,
    completed,
    failed,
    totalTracked: values.length,
    inMemoryQueueLength: queue.length,
    concurrency: CONCURRENCY,
  };
}

module.exports = {
  enqueueTrainingJob,
  getTrainingJob,
  hasActiveTrainingJob,
  getTrainingQueueStats,
  indexingProgress,
};
