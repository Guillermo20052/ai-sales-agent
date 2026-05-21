/**
 * AI request queue: limits concurrent AI calls and rejects when overloaded.
 * Prevents server crashes and API rate limit exhaustion.
 */

const PQueue = require("p-queue").default;

const CONCURRENCY = Number(process.env.AI_QUEUE_CONCURRENCY || 5);
const MAX_PENDING = Number(process.env.AI_QUEUE_MAX_PENDING || 100);

const queue = new PQueue({
  concurrency: Math.max(1, Math.min(CONCURRENCY, 20)),
  autoStart: true,
});

class AIQueueFullError extends Error {
  constructor(message = "AI queue overloaded") {
    super(message);
    this.name = "AIQueueFullError";
    this.code = "AI_QUEUE_FULL";
  }
}

/**
 * Run an AI task (e.g. Claude call) through the queue.
 * Rejects with AIQueueFullError if queue would exceed MAX_PENDING.
 * @param {() => Promise<T>} fn - Async function that performs the AI call
 * @returns {Promise<T>}
 */
async function runAiTask(fn) {
  const total = queue.size + queue.pending;
  if (total >= MAX_PENDING) {
    console.warn("AI_QUEUE_OVERLOAD:", { size: queue.size, pending: queue.pending, maxPending: MAX_PENDING });
    throw new AIQueueFullError();
  }
  return queue.add(fn);
}

function getQueueStats() {
  return { size: queue.size, pending: queue.pending, concurrency: queue.concurrency };
}

module.exports = {
  runAiTask,
  getQueueStats,
  AIQueueFullError,
  CONCURRENCY,
  MAX_PENDING,
};
