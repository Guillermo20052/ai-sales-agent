const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendVerificationEmail(email, token) {
  const baseUrl = process.env.BASE_URL;
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
    from: process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@aisalesagent.com",
    to: email,
    subject: "Verify your AI Sales Agent account",
    html: html,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("Verification email sent to:", email);
    return true;
  } catch (err) {
    console.error("EMAIL ERROR:", err.message);
    return false;
  }
}

module.exports = { sendVerificationEmail };
