/**
 * Run: node scripts/test-smtp.js your@email.com
 * Uses .env SMTP_* and prints the exact error if send fails.
 */
require("dotenv").config();
const nodemailer = require("nodemailer");

const to = process.argv[2] || process.env.SMTP_USER || "you@example.com";

const pass = process.env.SMTP_PASS;
const user = process.env.SMTP_USER;
console.log("SMTP_USER:", user ? `${user.slice(0, 3)}***` : "(missing)");
console.log("SMTP_PASS length:", pass ? pass.length : 0);
console.log("SMTP_HOST:", process.env.SMTP_HOST);
console.log("SMTP_PORT:", process.env.SMTP_PORT);
console.log("Sending test email to:", to);
console.log("---");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT || "587", 10),
  secure: false,
  auth: {
    user: user,
    pass: pass ? pass.trim() : "",
  },
});

transporter
  .sendMail({
    from: process.env.SMTP_FROM || user,
    to,
    subject: "Test from AI Sales Agent",
    text: "If you see this, SMTP is working.",
  })
  .then((info) => {
    console.log("SUCCESS. MessageId:", info.messageId);
    process.exit(0);
  })
  .catch((err) => {
    console.error("SMTP ERROR:", err.message);
    if (err.response) console.error("Response:", err.response);
    if (err.code) console.error("Code:", err.code);
    if (err.responseCode) console.error("ResponseCode:", err.responseCode);
    process.exit(1);
  });
