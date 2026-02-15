require("dotenv").config();

const express = require("express");
const session = require("express-session");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5000;

/* ========= STRIPE WEBHOOK (MUST BE FIRST & RAW) ========= */
app.use(
  "/webhook",
  express.raw({ type: "application/json" }),
  require("./routes/webhook"),
);

/* ========= MIDDLEWARE ========= */
app.use(cors()); // Allow cross-origin requests (for widget dev)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "devsecret",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }, // set true when using HTTPS only
  }),
);

/* ========= STATIC FILES ========= */
/* Allows serving:
   https://your-url/widget.js
   https://your-url/demo.html
*/
app.use(express.static("public"));

/* ========= ROUTES ========= */
app.use("/auth", require("./routes/auth"));
app.use("/chat", require("./routes/chat"));
app.use("/dashboard", require("./routes/dashboard"));
app.use("/agent", require("./routes/agent"));
app.use("/dashboard/install", require("./routes/install"));
app.use("/b", require("./routes/publicBusiness"));

/* ========= HEALTH CHECK ========= */
app.get("/", (req, res) => {
  res.send("🚀 Sales Agent SaaS backend is running");
});

/* ========= STRIPE SUCCESS / CANCEL PAGES ========= */
app.get("/success", (req, res) => {
  res.send("✅ Payment successful! Subscription activated.");
});

app.get("/cancel", (req, res) => {
  res.send("❌ Payment cancelled.");
});

/* ========= START SERVER ========= */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
