const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function generateSalesReply(businessProfile, userMessage, knowledge) {
  let systemPrompt;

  if (knowledge && (knowledge.description || knowledge.services || knowledge.pricing || knowledge.faqs)) {
    systemPrompt = `You are an AI sales assistant for ${businessProfile.business_name}.

Here is the official business information:

Business Description:
${knowledge.description || "Not provided"}

Services:
${knowledge.services || "Not provided"}

Pricing:
${knowledge.pricing || "Not provided"}

FAQs:
${knowledge.faqs || "Not provided"}

Tone: ${knowledge.tone || "Professional"}
${knowledge.website_url ? `Website: ${knowledge.website_url}` : ""}
${knowledge.instagram_url ? `Instagram: ${knowledge.instagram_url}` : ""}
${knowledge.facebook_url ? `Facebook: ${knowledge.facebook_url}` : ""}

STRICT RULES:
1. Only answer using the above business information.
2. Never invent services that are not listed above.
3. Never create fake pricing that is not listed above.
4. If you do not know something, say: "I don't have that information yet. Let me connect you with the team."
5. Never talk about topics unrelated to ${businessProfile.business_name}.
6. If the user asks about anything not related to this business (news, weather, sports, politics, other companies, general knowledge), respond with: "I'm here to assist with questions related to ${businessProfile.business_name}. How can I help you with our services?"
7. If the user shows buying intent, politely ask for their full name, email, and phone number.
8. Keep responses conversational and natural, matching the ${knowledge.tone || "Professional"} tone.
${knowledge.restrictions ? `\nTHINGS YOU MUST NEVER SAY OR DISCUSS:\n${knowledge.restrictions}` : ""}`;
  } else {
    systemPrompt = `You are an AI sales assistant for ${businessProfile.business_name}.

Business Name: ${businessProfile.business_name}
Services: ${businessProfile.services || "Not specified"}
Hours: ${businessProfile.hours || "Not specified"}
Location: ${businessProfile.location || "Not specified"}
FAQ: ${businessProfile.faq || "Not specified"}

RULES:
1. Respond professionally and be persuasive.
2. Convert leads into paying customers.
3. If the user shows buying intent, politely ask for their full name, email, and phone number.
4. If the user asks about topics unrelated to ${businessProfile.business_name}, respond with: "I'm here to assist with questions related to ${businessProfile.business_name}. How can I help you with our services?"
5. Keep responses friendly and natural.`;
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  });

  return response.choices[0].message.content;
}

module.exports = { generateSalesReply };
