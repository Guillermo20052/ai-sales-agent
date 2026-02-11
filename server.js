require("dotenv").config();

const express = require("express");
const session = require("express-session");

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "devsecret",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false },
  }),
);

// ROUTES
const authRoutes = require("./routes/auth");
console.log("Loading Auth routes...");
const chatRoutes = require("./routes/chat");
const dashboardRoutes = require("./routes/dashboard");

app.use("/auth", authRoutes);
console.log("Auth routes mounted at /auth");
app.use("/chat", chatRoutes);
app.use("/dashboard", dashboardRoutes);

// Health check
app.get("/", (req, res) => {
  res.send("Sales Agent SaaS backend is running 🚀");
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
