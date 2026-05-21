const express = require("express");
const router = express.Router();
const { indexingProgress } = require("../services/trainingQueueService");
const { isPositiveInt } = require("../middleware/security");
const authMiddleware = require("../middleware/authMiddleware");
const pool = require("../services/db");

router.get("/progress/:businessId", authMiddleware, async (req, res) => {
  const { businessId } = req.params;
  if (!isPositiveInt(businessId)) {
    return res.status(400).json({ error: "Invalid business ID." });
  }

  try {
    const bpResult = await pool.query(
      "SELECT id FROM business_profiles WHERE id = $1 AND user_id = $2",
      [businessId, req.session.userId],
    );
    if (!bpResult.rows.length) {
      return res.status(403).json({ error: "Forbidden" });
    }
  } catch (err) {
    return res.status(500).json({ error: "Internal server error" });
  }

  const bid = Number(businessId);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const sendProgress = () => {
    const pct = indexingProgress.get(bid) ?? indexingProgress.get(businessId) ?? null;
    if (pct === null) {
      res.write(`data: ${JSON.stringify({ progress: null })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ progress: pct })}\n\n`);
      if (pct >= 100) {
        res.write(`event: done\ndata: ${JSON.stringify({ progress: 100 })}\n\n`);
        clearInterval(intervalId);
        res.end();
        return;
      }
    }
  };

  sendProgress();
  const intervalId = setInterval(sendProgress, 2000);

  let failCheckCount = 0;
  const failCheckId = setInterval(async () => {
    failCheckCount++;
    try {
      const result = await pool.query(
        "SELECT website_training_status FROM business_profiles WHERE id = $1",
        [bid],
      );
      const status = result.rows[0]?.website_training_status;
      if (status === "failed") {
        res.write(`event: done\ndata: ${JSON.stringify({ progress: -1, error: "Training failed" })}\n\n`);
        clearInterval(intervalId);
        clearInterval(failCheckId);
        res.end();
      }
    } catch (_) {}
    if (failCheckCount > 150) {
      clearInterval(intervalId);
      clearInterval(failCheckId);
      res.end();
    }
  }, 4000);

  req.on("close", () => {
    clearInterval(intervalId);
    clearInterval(failCheckId);
  });
});

module.exports = router;
