require("dotenv").config();

const express = require("express");
const session = require("express-session");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5000;

/* ========= HEALTH CHECK (MUST BE FAST) ========= */
/* Replit Deploy sends health checks to "/" */
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

/* ========= STRIPE WEBHOOK (MUST BE FIRST & RAW) ========= */
app.use(
  "/webhook",
  express.raw({ type: "application/json" }),
  require("./routes/webhook"),
);

/* ========= MIDDLEWARE ========= */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "devsecret",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }, // Set true only if forcing HTTPS
  }),
);

/* ========= STATIC FILES ========= */
app.use(express.static("public"));

/* ========= ROUTES ========= */
app.use("/auth", require("./routes/auth"));
app.use("/chat", require("./routes/chat"));
app.use("/dashboard", require("./routes/dashboard"));
app.use("/agent", require("./routes/agent"));
app.use("/b", require("./routes/publicBusiness"));

/* ========= REAL LANDING PAGE ========= */
app.get("/home", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

/* ========= STRIPE SUCCESS / CANCEL ========= */
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
