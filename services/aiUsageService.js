const pool = require("./db");

/**
 * Records one row per AI response for tenant cost visibility.
 * Non-blocking and fail-safe: does not await, swallows errors.
 *
 * @param {object} opts
 * @param {number} [opts.businessId] - business_profiles.id (skip if missing)
 * @param {string} [opts.model] - e.g. "claude-sonnet-4-6"
 * @param {number} [opts.promptTokens] - input tokens
 * @param {number} [opts.completionTokens] - output tokens
 */
function recordUsage({ businessId, model, promptTokens, completionTokens }) {
  if (businessId == null || businessId === "") return;

  const prompt = Number(promptTokens) || 0;
  const completion = Number(completionTokens) || 0;

  pool
    .query(
      `INSERT INTO ai_usage (business_id, model, prompt_tokens, completion_tokens)
       VALUES ($1, $2, $3, $4)`,
      [businessId, model || null, prompt, completion],
    )
    .catch((err) => {
      console.error("AI_USAGE_LOG_ERROR:", err.message);
    });
}

module.exports = {
  recordUsage,
};
