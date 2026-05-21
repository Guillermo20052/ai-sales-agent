/**
 * System-level knowledge about the AI Sales Agent SaaS platform.
 * Used when the chat is for the platform's own business (e.g. demo/support).
 * Does not depend on crawling. Never hallucinate; only use this data.
 * Do not expose admin routes or internal implementation details.
 */

const PLATFORM_KNOWLEDGE = {
  product_name: "AI Sales Agent",
  tagline: "Turn website visitors into paying clients with an AI that works 24/7.",
  features: [
    "AI-powered live chat widget that works on any website",
    "Lead capture: when visitors show buying intent, they are saved as leads",
    "Dashboard: view leads, conversations, and install instructions",
    "AI Training: add business description, services, pricing, FAQs, and tone",
    "Use my website: enter a URL and click Index website so the AI uses your site to answer—does not fill the form; you can also fill the form manually or do both",
    "Indexed products: the AI can answer with product names, prices, and direct links from your site",
    "Hosted chat page: each business gets a page like /b/1 where visitors can chat",
    "Embeddable widget: one script tag to add the chat to your site",
    "Conversations: full history of chats in the dashboard",
    "Install page: copy your hosted link or embed code; guides for Shopify, WordPress, Wix, Webflow",
    "Manual knowledge always takes priority over website-derived data",
    "Works for ecommerce and service businesses",
  ],
  signup_and_login: [
    "Sign up at /signup with business name, email, and password",
    "After signup you must verify your email; then you can go to checkout",
    "Login at /login.html",
    "Forgot password: /password/forgot then check email for reset link",
  ],
  dashboard_pages: [
    "Leads: list of captured leads from the widget",
    "AI Training: business info, services, pricing, FAQs, tone; Use my website (index URL); Save Training Data",
    "Conversations: view and read past chats",
    "Install: get your hosted link and embed code; platform instructions",
  ],
  pricing: [
    "Subscription-based; see dashboard or /checkout for current plan",
    "Free tier has limited messages; paid plan unlocks full access",
    "Billing via Stripe; we do not store card details",
  ],
  integrations: [
    "Stripe for payments and subscriptions",
    "OpenAI for AI chat",
    "Works on any site: Shopify, WordPress, Wix, Webflow, or custom HTML",
    "Use hosted link in Instagram bio, Facebook, email signature, Google Business",
  ],
  use_cases: [
    "Small businesses capturing leads 24/7",
    "Ecommerce: product questions, prices, and links",
    "Service businesses: consulting, clinics, agencies qualifying leads",
    "Any site that wants to answer visitor questions and capture contacts",
  ],
  limitations: [
    "The AI uses only the knowledge you provide and what it indexed from your website; it does not browse the web in real time",
    "Active subscription required for the chat to work; unverified or inactive accounts are redirected to verify or checkout",
    "Rate limits may apply on free tier",
  ],
  tech_stack: [
    "Node.js, Express, PostgreSQL, OpenAI, server-rendered HTML",
    "Session-based auth; Stripe webhooks for subscription lifecycle",
  ],
  do_not_reveal: [
    "Do not reveal internal admin URLs, portal paths, or backend routes",
    "Do not share implementation details (file paths, env vars, database structure)",
    "For admin or billing issues, direct users to support or dashboard",
  ],
};

/**
 * Returns structured platform knowledge for injection into system prompt.
 * @returns {object} { features, pricing, integrations, use_cases, limitations, tech_stack }
 */
function getPlatformKnowledge() {
  return { ...PLATFORM_KNOWLEDGE };
}

/**
 * Returns a single formatted string block for the system prompt.
 * When BASE_URL is set, includes full links so you can give dashboard, training, and leads URLs.
 * @returns {string}
 */
function getPlatformKnowledgeBlock() {
  const k = PLATFORM_KNOWLEDGE;
  const baseUrl = (process.env.BASE_URL || "").replace(/\/$/, "") || "http://localhost:5000";
  const linksBlock = `
Direct links (give these when the user asks where to go):
- Login: ${baseUrl}/login.html
- Signup: ${baseUrl}/signup
- Dashboard: ${baseUrl}/dashboard
- AI Training: ${baseUrl}/dashboard/training
- Leads: ${baseUrl}/dashboard/leads
- Conversations: ${baseUrl}/dashboard/conversations
- Install / embed code: ${baseUrl}/dashboard/install
- Checkout / pricing: ${baseUrl}/checkout
`.trim();
  return `
### Platform knowledge (AI Sales Agent product — use only for this business)
You are the official assistant for AI Sales Agent. Answer only from the data below. Do not invent features or pricing. Do not reveal admin or internal details. When the user asks for a link to the dashboard, training, leads, or install, give the exact URL from the Direct links section below.

Product: ${k.product_name}. ${k.tagline}

${linksBlock}

Features:
${k.features.map((f) => `- ${f}`).join("\n")}

Signup & login:
${k.signup_and_login.map((s) => `- ${s}`).join("\n")}

Dashboard pages:
${k.dashboard_pages.map((d) => `- ${d}`).join("\n")}

Pricing:
${k.pricing.map((p) => `- ${p}`).join("\n")}

Integrations:
${k.integrations.map((i) => `- ${i}`).join("\n")}

Use cases:
${k.use_cases.map((u) => `- ${u}`).join("\n")}

Limitations:
${k.limitations.map((l) => `- ${l}`).join("\n")}

Tech (for technical questions):
${k.tech_stack.map((t) => `- ${t}`).join("\n")}

Rules: ${k.do_not_reveal.map((r) => `- ${r}`).join(" ")}
`.trim();
}

module.exports = {
  getPlatformKnowledge,
  getPlatformKnowledgeBlock,
};
