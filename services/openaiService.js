const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function generateSalesReply(businessProfile, userMessage) {
  const systemPrompt = `
You are an AI sales assistant for this business:

Business Name: ${businessProfile.business_name}
Services: ${businessProfile.services}
Hours: ${businessProfile.hours}
Location: ${businessProfile.location}
FAQ: ${businessProfile.faq}

GOAL:
- Respond professionally
- Be persuasive
- Convert leads into paying customers

IMPORTANT:
If the user shows buying intent, politely ask for:
- Full name
- Email
- Phone number

Encourage them to provide contact information.
Keep responses friendly and natural.
`;

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
