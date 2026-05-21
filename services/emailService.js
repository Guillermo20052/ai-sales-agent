const nodemailer = require("nodemailer");

const smtpHost = process.env.SMTP_HOST || "smtp.gmail.com";
const smtpPort = parseInt(process.env.SMTP_PORT || "587", 10);
const smtpUser = process.env.SMTP_USER;
const smtpPass =
  typeof process.env.SMTP_PASS === "string"
    ? process.env.SMTP_PASS.trim().replace(/^["']|["']$/g, "")
    : "";
const smtpFrom =
  process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@aisalesagent.com";

const smtpConfigured = !!(smtpUser && smtpPass);
if (!smtpConfigured) {
  console.warn("EMAIL_SERVICE: SMTP_USER or SMTP_PASS not set — emails will fail. Set them in .env.");
} else {
  console.log(`EMAIL_SERVICE: configured host=${smtpHost} port=${smtpPort} user=${smtpUser}`);
}

const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpPort === 465,
  auth: {
    user: smtpUser,
    pass: smtpPass,
  },
});

transporter.verify().then(() => {
  console.log("EMAIL_SERVICE: SMTP connection verified OK");
}).catch((err) => {
  console.error("EMAIL_SERVICE: SMTP connection verify FAILED:", err.message);
});

const isProd = process.env.NODE_ENV === "production";

async function sendVerificationEmail(email, token) {
  if (!smtpConfigured) {
    console.error("EMAIL_SEND: Cannot send verification — SMTP not configured");
    return false;
  }
  const baseUrl = process.env.BASE_URL;
  if (!baseUrl) {
    console.error("EMAIL_SEND: Cannot send verification — BASE_URL not set in .env");
    return false;
  }
  const verifyUrl = `${baseUrl}/verify?token=${token}`;

  const html = `
    <!doctype html>
    <html>
      <head>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f5; padding: 40px 20px; margin: 0; }
          .container { max-width: 480px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
          .logo { text-align: center; margin-bottom: 32px; }
          .logo-icon { display: inline-block; width: 44px; height: 44px; background: linear-gradient(135deg, #6366f1, #8b5cf6); border-radius: 10px; color: #fff; font-weight: 800; font-size: 18px; line-height: 44px; text-align: center; }
          h1 { font-size: 22px; font-weight: 700; color: #111; text-align: center; margin-bottom: 12px; }
          p { font-size: 15px; color: #555; line-height: 1.7; text-align: center; margin-bottom: 28px; }
          .btn-wrapper { text-align: center; margin-bottom: 28px; }
          .btn { display: inline-block; padding: 14px 36px; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; font-size: 15px; font-weight: 700; border-radius: 10px; text-decoration: none; }
          .fallback { font-size: 12px; color: #888; text-align: center; word-break: break-all; }
          .footer { font-size: 12px; color: #aaa; text-align: center; margin-top: 32px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="logo"><div class="logo-icon">AI</div></div>
          <h1>Verify Your Email</h1>
          <p>Thanks for signing up for AI Sales Agent! Click the button below to verify your email address and get started.</p>
          <div class="btn-wrapper">
            <a href="${verifyUrl}" class="btn">Verify Email Address</a>
          </div>
          <p class="fallback">If the button doesn't work, copy and paste this link:<br/>${verifyUrl}</p>
          <div class="footer">AI Sales Agent &mdash; Turn visitors into paying clients</div>
        </div>
      </body>
    </html>
  `;

  const mailOptions = {
    from: smtpFrom,
    to: email,
    subject: "Verify your AI Sales Agent account",
    html: html,
  };

  console.log("EMAIL_SEND: verification to:", email);
  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("EMAIL_SEND: verification OK messageId:", info.messageId);
    return true;
  } catch (err) {
    console.error("EMAIL_SEND: verification FAILED to:", email, "error:", err.message);
    if (err.response) console.error("EMAIL_SEND: SMTP response:", err.response);
    if (err.code) console.error("EMAIL_SEND: SMTP code:", err.code);
    return false;
  }
}

async function sendPasswordResetEmail(email, resetUrl) {
  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f5; padding: 40px 20px; margin: 0; }
          .container { max-width: 480px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
          .logo { text-align: center; margin-bottom: 32px; }
          .logo-icon { display: inline-block; width: 44px; height: 44px; background: linear-gradient(135deg, #6366f1, #8b5cf6); border-radius: 10px; color: #fff; font-weight: 800; font-size: 18px; line-height: 44px; text-align: center; }
          h1 { font-size: 22px; font-weight: 700; color: #111; text-align: center; margin-bottom: 12px; }
          p { font-size: 15px; color: #555; line-height: 1.7; text-align: center; margin-bottom: 28px; }
          .btn-wrapper { text-align: center; margin-bottom: 28px; }
          .btn { display: inline-block; padding: 14px 36px; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; font-size: 15px; font-weight: 700; border-radius: 10px; text-decoration: none; }
          .fallback { font-size: 12px; color: #888; text-align: center; word-break: break-all; }
          .footer { font-size: 12px; color: #aaa; text-align: center; margin-top: 32px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="logo"><div class="logo-icon">AI</div></div>
          <h1>Reset your password</h1>
          <p>We received a request to reset your password for AI Sales Agent. Click the button below to choose a new password.</p>
          <div class="btn-wrapper">
            <a href="${resetUrl}" class="btn">Reset Password</a>
          </div>
          <p class="fallback">If the button doesn't work, copy and paste this link into your browser:<br/>${resetUrl}</p>
          <div class="footer">If you didn’t request this, you can safely ignore this email.</div>
        </div>
      </body>
    </html>
  `;

  const mailOptions = {
    from: smtpFrom,
    to: email,
    subject: "Reset your AI Sales Agent password",
    html: html,
  };

  console.log("EMAIL_SEND: password-reset to:", email);
  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("EMAIL_SEND: password-reset OK messageId:", info.messageId);
    return true;
  } catch (err) {
    console.error("EMAIL_SEND: password-reset FAILED to:", email, "error:", err.message);
    if (err.response) console.error("EMAIL_SEND: SMTP response:", err.response);
    if (err.code) console.error("EMAIL_SEND: SMTP code:", err.code);
    return false;
  }
}

async function sendContactSalesEmail({ name, email, company, message }) {
  const mailOptions = {
    from: smtpFrom,
    to: "aisales@aiagentproperties.com",
    replyTo: email || undefined,
    subject: "New Contact Sales Request",
    text: [
      `Name: ${name || "N/A"}`,
      `Email: ${email || "N/A"}`,
      `Company: ${company || "N/A"}`,
      "",
      "Message:",
      message || "(no message)",
    ].join("\n"),
  };

  console.log("EMAIL_SEND: contact-sales from:", email);
  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("EMAIL_SEND: contact-sales OK messageId:", info.messageId);
    return true;
  } catch (err) {
    console.error("EMAIL_SEND: contact-sales FAILED error:", err.message);
    if (err.response) console.error("EMAIL_SEND: SMTP response:", err.response);
    if (err.code) console.error("EMAIL_SEND: SMTP code:", err.code);
    return false;
  }
}

async function sendTestEmail() {
  const mailOptions = {
    from: smtpFrom,
    to: "sales@aiagentproperties.com",
    subject: "AI Sales Agent Email Test",
    text: `Test email sent at ${new Date().toISOString()}\n\nIf you received this, SMTP is working correctly.`,
  };
  console.log("EMAIL_SEND: test email to:", mailOptions.to);
  const info = await transporter.sendMail(mailOptions);
  console.log("EMAIL_SEND: test OK messageId:", info.messageId);
  return info;
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendContactSalesEmail, sendTestEmail };
