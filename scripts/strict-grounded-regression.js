const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

function testDashboardSqlParamOrder() {
  const dashboardSrc = read("routes/dashboard.js");
  const queueSrc = read("services/trainingQueueService.js");
  const legacyExpected = '[JSON.stringify(legacyKnowledge), "trained", url, business.id]';
  const queuedExpected = '[JSON.stringify(legacyKnowledge), "trained", url, businessId]';
  const hasLegacyFix = dashboardSrc.includes(legacyExpected);
  const hasQueuedFix = queueSrc.includes(queuedExpected);
  assert(
    hasLegacyFix || hasQueuedFix,
    "website-train SQL param order regression: expected url before business id in training update",
  );
}

function testStrictPromptAndParser() {
  const {
    buildSystemPrompt,
    parseGroundedJsonReply,
  } = require(path.join(root, "services/aiService"));

  const prompt = buildSystemPrompt(
    { business_name: "Acme Co" },
    {
      description: "Acme builds automation tools.",
      services: "Implementation and support.",
      pricing: "$99/mo",
      faqs: "Q: SLA? A: 99.9%",
    },
    "General question",
    {
      strictGrounded: true,
      websiteContextStructured: "[pricing] plans and limits",
      products: [{ title: "Starter", price: "$99", page_url: "https://acme.com/pricing" }],
      evidenceHints: [{ sourceId: "semantic_1", url: "https://acme.com/pricing" }],
    },
  );

  assert(prompt.includes("MANUAL BUSINESS KNOWLEDGE"), "prompt should include manual context block");
  assert(prompt.includes("STRICT OUTPUT FORMAT"), "prompt should include strict JSON output instructions");
  assert(
    prompt.indexOf("MANUAL BUSINESS KNOWLEDGE") < prompt.indexOf("WEBSITE CONTENT"),
    "manual context should be prioritized before website context in prompt order",
  );

  const parsed = parseGroundedJsonReply(
    JSON.stringify({
      grounded: true,
      answer: "The Starter plan is $99/mo.",
      evidence: ["semantic_1"],
    }),
  );
  assert.strictEqual(parsed.grounded, true, "valid grounded JSON should parse grounded=true");
  assert.strictEqual(parsed.answer, "The Starter plan is $99/mo.", "valid grounded JSON should preserve answer");
  assert.deepStrictEqual(parsed.evidence, ["semantic_1"], "valid grounded JSON should preserve evidence list");

  const invalid = parseGroundedJsonReply("not-json");
  assert.strictEqual(invalid.grounded, false, "invalid JSON should default to grounded=false");
}

function testWidgetConversationPersistence() {
  const src = read("public/widget.js");
  assert(
    src.includes("ai_agent_conv_"),
    "widget should store conversation id key in localStorage",
  );
  assert(
    src.includes("conversationId: conversationId"),
    "widget should send conversationId on POST requests",
  );
  assert(
    src.includes("localStorage.setItem(conversationStorageKey"),
    "widget should persist conversationId returned by API",
  );
  assert(
    src.includes('"/vision"') || src.includes('"/vision"'),
    "widget should route image messages to vision endpoint",
  );
}

function testStrictRouteGuardsPresent() {
  const src = read("routes/agent.js");
  assert(src.includes("STRICT_FALLBACK_REPLY"), "agent route should define strict fallback response");
  assert(
    src.includes("returnStructured: strictGroundedForBusiness") ||
      src.includes("returnStructured: STRICT_GROUNDED_MODE"),
    "agent route should request structured strict output",
  );
  assert(
    src.includes("AGENT_STRICT_MIN_SCORE"),
    "agent route should support configurable strict retrieval threshold",
  );
  assert(
    src.includes("answerLooksRelatedToEvidence("),
    "agent route should validate answer relevance against evidence",
  );
  assert(
    src.includes("getLiveNavigationContext(") &&
      src.includes("AGENT_ENABLE_LIVE_NAV"),
    "agent route should support live website navigation tools with feature flag",
  );
  assert(
    src.includes("hasLiveNavEvidence") &&
      src.includes('startsWith("nav_")'),
    "agent route should treat live navigation evidence as valid gating signal",
  );
  assert(
    src.includes("addGroundedDebugLog("),
    "agent route should write strict-grounding debug logs",
  );
  assert(
    src.includes('router.post("/:businessId/vision"'),
    "agent route should expose vision endpoint",
  );
}

function testAdminGroundedDebugEndpoint() {
  const src = read("routes/admin.js");
  assert(
    src.includes('router.get("/grounded-debug", requireAdmin'),
    "admin route should expose grounded debug endpoint for troubleshooting",
  );
  assert(
    src.includes('router.get("/ops-metrics", requireAdmin'),
    "admin route should expose ops metrics endpoint for observability",
  );
  assert(
    src.includes('router.get("/sla-health", requireAdmin') &&
      src.includes('router.get("/audit-logs", requireAdmin'),
    "admin route should expose SLA health and audit logs endpoints",
  );
}

function testAdminDebugUiExists() {
  const src = read("views/admin.html");
  assert(
    src.includes("Grounded Agent Debug") &&
      src.includes('id="groundedDebugRows"') &&
      src.includes("/internal-admin-portal-93847/grounded-debug"),
    "admin UI should include grounded debug controls and table",
  );
  assert(
    src.includes("SLA Health") &&
      src.includes("/internal-admin-portal-93847/sla-health") &&
      src.includes("/internal-admin-portal-93847/audit-logs"),
    "admin UI should include SLA health and audit logs sections",
  );
}

function testLiveNavigationServiceExists() {
  const src = read("services/websiteNavigationService.js");
  assert(
    src.includes("getLiveNavigationContext") &&
      src.includes("isSameDomain") &&
      src.includes("extractFactsFromHtml"),
    "live navigation service should include same-domain and fact extraction safeguards",
  );
}

function testMemoryPhaseExists() {
  const service = read("services/memoryService.js");
  assert(
    service.includes("getBusinessMemoryConfig") &&
      service.includes("getPersistentVisitorMemory") &&
      service.includes("savePersistentVisitorMemory"),
    "memory service should expose config, load, and save helpers",
  );

  const agent = read("routes/agent.js");
  assert(
    agent.includes("buildMemoryFromConversation") &&
      agent.includes("savePersistentVisitorMemory"),
    "agent route should build and persist visitor memory",
  );

  const server = read("server.js");
  assert(
    server.includes("business_visitor_memory") &&
      server.includes("memory_enabled") &&
      server.includes("memory_retention_days"),
    "server bootstrap should ensure visitor memory table and retention columns",
  );
}

function testQueuePhaseExists() {
  const queueService = read("services/trainingQueueService.js");
  assert(
    queueService.includes("enqueueTrainingJob") &&
      queueService.includes("getTrainingJob") &&
      queueService.includes("getTrainingQueueStats"),
    "training queue service should expose enqueue, status, and stats APIs",
  );

  const dashboard = read("routes/dashboard.js");
  assert(
    dashboard.includes('router.get("/training/jobs/:jobId"') &&
      dashboard.includes("enqueueTrainingJob("),
    "dashboard routes should enqueue training and expose job polling endpoint",
  );

}

function testBusinessSettingsControlsExist() {
  const dashboard = read("routes/dashboard.js");
  assert(
    dashboard.includes("strict_grounded_enabled") &&
      dashboard.includes("live_nav_enabled") &&
      dashboard.includes("citation_enabled") &&
      dashboard.includes("max_reply_sources"),
    "dashboard training routes should read/write business runtime controls",
  );

  const trainingView = read("views/training.html");
  assert(
    trainingView.includes("strict_grounded_enabled") &&
      trainingView.includes("live_nav_enabled") &&
      trainingView.includes("citation_enabled") &&
      trainingView.includes("memory_retention_days"),
    "training UI should expose per-business settings controls",
  );

  const agentRoute = read("routes/agent.js");
  assert(
    agentRoute.includes("strictGroundedForBusiness") &&
      agentRoute.includes("liveNavForBusiness") &&
      agentRoute.includes("citationsForBusiness"),
    "agent runtime should apply business-specific strictness/tool/citation settings",
  );
}

function testPgvectorPrepExists() {
  const sql = read("scripts/prepare-pgvector-migration.sql");
  assert(
    sql.includes("CREATE EXTENSION IF NOT EXISTS vector") &&
      sql.includes("embedding_vector vector(1536)") &&
      sql.includes("vector_cosine_ops"),
    "pgvector prep migration should exist for phased rollout",
  );
}

function testAuditAndSlaServicesExist() {
  const audit = read("services/auditLogService.js");
  assert(
    audit.includes("writeAuditLog") && audit.includes("getAuditLogs"),
    "audit log service should expose write/read functions",
  );
  const sla = read("services/slaService.js");
  assert(
    sla.includes("evaluateHealth") && sla.includes("fallbackRate"),
    "sla service should evaluate health using runtime metrics",
  );
  const server = read("server.js");
  assert(
    server.includes("agent_audit_logs"),
    "server bootstrap should ensure agent_audit_logs table exists",
  );
}

function run() {
  testDashboardSqlParamOrder();
  testStrictPromptAndParser();
  testWidgetConversationPersistence();
  testStrictRouteGuardsPresent();
  testAdminGroundedDebugEndpoint();
  testAdminDebugUiExists();
  testLiveNavigationServiceExists();
  testMemoryPhaseExists();
  testQueuePhaseExists();
  testBusinessSettingsControlsExist();
  testPgvectorPrepExists();
  testAuditAndSlaServicesExist();
  console.log("strict-grounded-regression: all checks passed");
}

run();
