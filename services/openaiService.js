const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Build structured system prompt
 */
function buildSystemPrompt(businessProfile, knowledge) {
  const manualDataExists =
    knowledge &&
    (knowledge.description ||
      knowledge.services ||
      knowledge.pricing ||
      knowledge.faqs);

  let websiteStructured = "";
  let websiteRaw = "";

  // Parse website knowledge if available
  if (businessProfile.website_knowledge) {
    try {
      const wk =
        typeof businessProfile.website_knowledge === "string"
          ? JSON.parse(businessProfile.website_knowledge)
          : businessProfile.website_knowledge;

      if (wk.sections && wk.sections.length) {
        websiteStructured = wk.sections
          .map((section) => `SECTION: ${section.title}\n${section.content}`)
          .join("\n\n");
      }

      if (wk.raw_text) {
        // Limit raw text to prevent token overflow
        websiteRaw = wk.raw_text.substring(0, 8000);
      }
    } catch (e) {
      console.error("Website knowledge parse error:", e);
    }
  }

  // ==============================
  // FULL TRAINED MODE
  // ==============================
  if (manualDataExists) {
    return `You are an AI sales assistant for ${businessProfile.business_name}.

==============================
OFFICIAL MANUAL BUSINESS DATA
==============================

Business Description:
${knowledge.description || "Not provided"}

Services:
${knowledge.services || "Not provided"}

Pricing:
${knowledge.pricing || "Not provided"}

FAQs:
${knowledge.faqs || "Not provided"}

Tone:
${knowledge.tone || "Professional"}

${knowledge.website_url ? `Website: ${knowledge.website_url}` : ""}
${knowledge.instagram_url ? `Instagram: ${knowledge.instagram_url}` : ""}
${knowledge.facebook_url ? `Facebook: ${knowledge.facebook_url}` : ""}

==============================
STRUCTURED WEBSITE KNOWLEDGE
==============================

${websiteStructured || "No structured website data available."}

==============================
RAW WEBSITE CONTENT (REFERENCE ONLY)
==============================

${websiteRaw || "No raw website content available."}

==============================
STRICT RULES
==============================

1. PRIORITY ORDER:
   - Manual Business Data overrides Website Data.
   - Structured Website Data overrides Raw Website Content.
   - Never invent information.

2. Only answer using provided business data.
3. Never create fake services or pricing.
4. If information is missing, say:
   "I don't have that information yet. Let me connect you with the team."

5. If user asks about unrelated topics (news, politics, weather, other companies, general knowledge):
   Respond with:
   "I'm here to assist with questions related to ${businessProfile.business_name}. How can I help you with our services?"

6. If user shows buying intent:
   Politely ask for full name, email, and phone number.

7. Maintain a ${knowledge.tone || "Professional"} tone.

${
  knowledge.restrictions
    ? `
==============================
ABSOLUTE RESTRICTIONS
==============================
${knowledge.restrictions}
`
    : ""
}`;
  }

  // ==============================
  // FALLBACK MODE (NO TRAINING)
  // ==============================
  return `You are an AI sales assistant for ${businessProfile.business_name}.

Business Name: ${businessProfile.business_name}
Services: ${businessProfile.services || "Not specified"}
Hours: ${businessProfile.hours || "Not specified"}
Location: ${businessProfile.location || "Not specified"}

STRICT RULES:
1. Do not invent services or pricing.
2. If unsure, say:
   "I don't have that information yet. Let me connect you with the team."
3. Convert leads into customers politely.
4. If topic is unrelated, redirect to business services.
5. Keep responses professional and natural.`;
}

/**
 * Generate AI sales reply
 */
async function generateSalesReply(businessProfile, userMessage, knowledge) {
  const systemPrompt = buildSystemPrompt(businessProfile, knowledge);

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  });

  return response.choices[0].message.content;
}

module.exports = { generateSalesReply };
