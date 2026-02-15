# Sales Agent SaaS

## Overview

AI Sales Agent SaaS application with a modern dark-themed dashboard UI. Provides user authentication with email verification, AI-powered chat via OpenAI, lead capture, Stripe subscription billing, an embeddable chat widget, and a per-business AI training/knowledge system.

Built with Node.js/Express, PostgreSQL, Stripe, OpenAI, Nodemailer, and Cheerio.

## User Preferences

Preferred communication style: Simple, everyday language.
UI preference: Modern dark SaaS aesthetic, premium feel ($50/month tier look).

## Recent Changes

- **Feb 15, 2026**: Added Business Knowledge System: AI Training page (/dashboard/training), website scraping (/dashboard/scrape), chat history with conversations/messages tables, conversations viewer (/dashboard/conversations), dynamic AI prompts with business knowledge + guardrails, per-business isolation. New tables: business_knowledge, conversations, messages. New deps: cheerio, node-fetch@2.
- **Feb 15, 2026**: Fixed subscription flow race condition. /install-success now verifies Stripe session_id before activating. All subscription checks use subscription_status only (removed is_paid from conditionals). Added customer.subscription.created webhook handler. Added /logout route and logout button to dashboard. Added Cache-Control headers.
- **Feb 15, 2026**: Fixed Stripe success_url/cancel_url to use BASE_URL (was hardcoded to dev URL). Added /health endpoint. Created /payment-success page with business info, hosted link, embed code, and auto-redirect. Upgraded dashboard to show agent section with hosted link, embed code, copy buttons, and platform install guides for active subscribers.
- **Feb 15, 2026**: Implemented full SaaS signup flow: signup page, email verification (Nodemailer), checkout page, dashboard protection (email_verified + subscription_status), terms & privacy pages.
- **Feb 15, 2026**: Added professional SaaS landing page at "/", dashboard page at "/dashboard" with leads table and stats, improved success/cancel pages with dark theme.
- **Feb 15, 2026**: Complete UI redesign of `/dashboard/install` page and `/login.html` page. Dark theme with Inter font, gradient hero card, modern cards with soft shadows, responsive layout, toast notifications.

## System Architecture

### Backend Framework
- **Express 4.x** serves as the HTTP framework. The entry point is `server.js`.
- Routes are organized in the `routes/` directory.
- Services live in the `services/` directory.
- Middleware in `middleware/` directory.

### User Journey
Landing -> Signup -> Verify Email -> Checkout (Stripe) -> Dashboard -> Train AI -> Install Widget

### Route Structure
| Route Prefix | File | Purpose |
|---|---|---|
| `/` | `server.js` | Landing page + health check (returns 200, no DB calls) |
| `/health` | `server.js` | Dedicated health check endpoint (instant 200, no DB) |
| `/install-success` | `server.js` | Post-payment success page with Stripe session verification |
| `/payment-success` | `server.js` | Backward compat redirect to /install-success |
| `/home` | `server.js` | Alias for landing page (backward compat) |
| `/signup` | `server.js` | Signup page (views/signup.html) |
| `/verify` | `server.js` | Email verification (GET /verify?token=...) |
| `/verify-pending` | `server.js` | Email verification pending page |
| `/checkout` | `server.js` | Checkout page (requires email_verified) |
| `/terms` | `server.js` | Terms & Conditions page |
| `/privacy` | `server.js` | Privacy Policy page |
| `/auth` | `routes/auth.js` | Login, signup, resend-verification endpoints |
| `/chat` | `routes/chat.js` | AI chat with auth + usage limits |
| `/dashboard` | `routes/dashboard.js` | Dashboard page, leads, checkout, install, training, conversations, scrape |
| `/agent` | `routes/agent.js` | Public AI agent endpoint (with knowledge + chat history) |
| `/b` | `routes/publicBusiness.js` | Public business page |
| `/webhook` | `routes/webhook.js` | Stripe webhook handler |
| `/success` | `server.js` | Stripe payment success page |
| `/cancel` | `server.js` | Stripe payment cancel page |

### Dashboard Routes
| Endpoint | Method | Purpose |
|---|---|---|
| `/dashboard` | GET | Main dashboard with leads table + AI agent section |
| `/dashboard/leads` | GET | Leads API (JSON) |
| `/dashboard/checkout` | POST | Create Stripe checkout session |
| `/dashboard/install` | GET | Install page with embed code |
| `/dashboard/training` | GET | AI Training page (business knowledge form) |
| `/dashboard/training` | POST | Save business knowledge data |
| `/dashboard/scrape` | POST | Scrape website URL and return text content |
| `/dashboard/conversations` | GET | Conversations viewer page (last 10) |
| `/dashboard/conversations/:id` | GET | Single conversation messages (JSON) |

### Auth Endpoints
| Endpoint | Method | Purpose |
|---|---|---|
| `/auth/login` | POST | Login (returns redirect based on user state) |
| `/auth/signup` | POST | Create account + business_profile + send verification email |
| `/auth/resend-verification` | POST | Resend verification email |

### Frontend / UI
- **Dark SaaS theme** using Inter font (Google Fonts), gradient cards, glass effects
- `views/landing.html` - Public SaaS landing page (hero, features, pricing, footer)
- `views/signup.html` - Signup page (business name, email, password, terms checkbox)
- `views/verify-pending.html` - Email verification pending page with resend button
- `views/checkout.html` - Stripe checkout page (only if email_verified)
- `views/terms.html` - Terms & Conditions page
- `views/privacy.html` - Privacy Policy page
- `views/dashboard.html` - Dashboard with leads table, stats cards, AI agent section
- `views/install.html` - Dashboard install page (server-rendered with template variables)
- `views/training.html` - AI Training page (business knowledge form, scrape button, status badge)
- `views/conversations.html` - Conversations viewer with modal message detail
- `public/login.html` - Login page (redirects based on user state)
- `public/demo.html` - Widget demo page
- `public/widget.js` - Embeddable chat widget
- Dashboard navigation tabs: Leads | AI Training | Conversations | Install

### AI System
- `services/openaiService.js` - generateSalesReply(businessProfile, message, knowledge)
- When business_knowledge exists, builds dynamic system prompt with:
  - Business description, services, pricing, FAQs, tone
  - Strict guardrails: no inventing services/pricing, no off-topic answers
  - Business-specific restrictions (things AI must never say)
- Falls back to basic prompt using business_profiles data if no knowledge exists
- Off-topic requests get redirected: "I'm here to assist with questions related to [Business Name]"

### Chat History
- Every user message and AI response saved to `messages` table
- Conversations grouped by `conversations` table (linked to business_id)
- `visitor_id` optional field for tracking anonymous visitors
- Agent returns `conversationId` for multi-turn conversations
- Dashboard shows last 10 conversations with message count and preview

### Website Scraping
- POST /dashboard/scrape accepts a URL
- Uses node-fetch + cheerio to extract visible text
- Strips scripts, styles, nav, footer, header, iframe, svg
- Limits extracted text to 5000 characters
- SSRF protection: blocks localhost, private IPs, non-HTTP protocols
- 10-second timeout

### Authentication & Authorization
- Login via `POST /auth/login` using **bcrypt** password comparison.
- Signup via `POST /auth/signup` creates user + business_profile.
- Sessions managed with **express-session**.
- Auth middleware in `middleware/authMiddleware.js`.
- Dashboard protection: requires email_verified=true AND subscription_status='active'
- Login redirects: unverified -> /verify-pending, inactive subscription -> /checkout, active -> /dashboard

### Database
- **PostgreSQL** via the `pg` library with a connection pool (`services/db.js`).
- Connection string from `DATABASE_URL` environment variable.
- Tables: `users`, `business_profiles`, `leads`, `business_knowledge`, `conversations`, `messages`

### Database Tables

#### users
| Column | Type | Default | Purpose |
|---|---|---|---|
| id | serial | auto | Primary key |
| email | text | - | User email |
| password | text | - | Bcrypt hashed password |
| created_at | timestamp | CURRENT_TIMESTAMP | Account creation time |
| is_paid | boolean | false | Stripe payment status |
| message_count | integer | 0 | Monthly message usage |
| current_period_start | timestamp | now() | Usage period start |
| email_verified | boolean | false | Email verification status |
| verification_token | text | null | UUID token for email verification |
| subscription_status | text | 'inactive' | Subscription status (active/inactive) |
| terms_accepted | boolean | false | Terms acceptance |

#### business_knowledge
| Column | Type | Default | Purpose |
|---|---|---|---|
| id | serial | auto | Primary key |
| user_id | integer | - | FK to users.id |
| description | text | '' | Business description |
| services | text | '' | Services offered |
| pricing | text | '' | Pricing details |
| faqs | text | '' | FAQs |
| tone | varchar(50) | 'Professional' | AI tone (Professional/Friendly/Aggressive Sales/Luxury) |
| website_url | text | '' | Website URL |
| instagram_url | text | '' | Instagram URL |
| facebook_url | text | '' | Facebook URL |
| restrictions | text | '' | What AI should never say |
| updated_at | timestamp | CURRENT_TIMESTAMP | Last update time |

#### conversations
| Column | Type | Default | Purpose |
|---|---|---|---|
| id | serial | auto | Primary key |
| business_id | integer | - | FK to business_profiles.id |
| visitor_id | varchar(64) | null | Anonymous visitor tracking |
| created_at | timestamp | CURRENT_TIMESTAMP | Conversation start time |

#### messages
| Column | Type | Default | Purpose |
|---|---|---|---|
| id | serial | auto | Primary key |
| conversation_id | integer | - | FK to conversations.id |
| sender | varchar(10) | - | 'user' or 'ai' |
| content | text | - | Message content |
| created_at | timestamp | CURRENT_TIMESTAMP | Message time |

### Environment Variables
| Variable | Purpose | Required |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `SESSION_SECRET` | Secret for express-session | No (defaults to "devsecret") |
| `PORT` | Server port | No (defaults to 5000) |
| `BASE_URL` | Public URL for embed codes and hosted links | Yes |
| `OPENAI_API_KEY` | OpenAI API key for AI chat | Yes |
| `STRIPE_SECRET_KEY` | Stripe secret key | Yes |
| `STRIPE_PRICE_ID` | Stripe subscription price ID | Yes |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | Yes |
| `SMTP_HOST` | SMTP server host | Yes (for email) |
| `SMTP_PORT` | SMTP server port | No (defaults to 587) |
| `SMTP_USER` | SMTP username/email | Yes (for email) |
| `SMTP_PASS` | SMTP password/app password | Yes (for email) |
| `SMTP_FROM` | From email address | No (defaults to SMTP_USER) |

### Project Structure
```
├── server.js              # Entry point, middleware, route mounting, page routes
├── package.json           # Dependencies
├── views/
│   ├── landing.html       # Public SaaS landing page
│   ├── signup.html        # Signup page
│   ├── verify-pending.html # Email verification pending page
│   ├── checkout.html      # Stripe checkout page
│   ├── terms.html         # Terms & Conditions
│   ├── privacy.html       # Privacy Policy
│   ├── dashboard.html     # Dashboard with leads table
│   ├── install.html       # Dashboard install page (dark SaaS UI)
│   ├── training.html      # AI Training page (business knowledge)
│   └── conversations.html # Conversations viewer
├── public/
│   ├── login.html         # Login page (dark SaaS UI)
│   ├── demo.html          # Widget demo
│   └── widget.js          # Embeddable chat widget
├── routes/
│   ├── auth.js            # Authentication (login, signup, resend-verification)
│   ├── chat.js            # AI chat with usage limits
│   ├── dashboard.js       # Dashboard (leads, checkout, install, training, conversations, scrape)
│   ├── install.js         # Install JSON API
│   ├── agent.js           # Public AI agent (with knowledge + chat history)
│   ├── publicBusiness.js  # Public business page
│   └── webhook.js         # Stripe webhooks
├── services/
│   ├── db.js              # PostgreSQL connection pool
│   ├── stripeService.js   # Stripe checkout sessions
│   ├── openaiService.js   # OpenAI sales reply (with business knowledge + guardrails)
│   └── emailService.js    # Nodemailer verification email service
└── middleware/
    ├── authMiddleware.js   # Session auth check
    ├── paymentRequired.js  # Subscription check
    └── usageLimit.js       # Free tier message limits
```

## External Dependencies

### Core Dependencies
- **express** — Web framework
- **pg** — PostgreSQL client
- **bcrypt** — Password hashing
- **express-session** — Session management
- **dotenv** — Environment variable loading
- **openai** — OpenAI API client
- **stripe** — Stripe payment processing
- **cors** — Cross-origin request support
- **nodemailer** — Email sending for verification
- **cheerio** — HTML parsing for website scraping
- **node-fetch@2** — HTTP client for website scraping
