const express = require("express");
const router = express.Router();

// TEMP test route
router.get("/", (req, res) => {
  res.json({ message: "Dashboard route working ✅" });
});

module.exports = router;
