# Sales Agent SaaS

## Overview

AI Sales Agent SaaS application with a modern dark-themed dashboard UI. Provides user authentication with email verification, AI-powered chat via OpenAI, lead capture, Stripe subscription billing, and an embeddable chat widget for businesses.

Built with Node.js/Express, PostgreSQL, Stripe, OpenAI, and Nodemailer.

## User Preferences

Preferred communication style: Simple, everyday language.
UI preference: Modern dark SaaS aesthetic, premium feel ($50/month tier look).

## Recent Changes

- **Feb 15, 2026**: Fixed Stripe success_url/cancel_url to use BASE_URL (was hardcoded to dev URL). Added /health endpoint. Created /payment-success page with business info, hosted link, embed code, and auto-redirect. Upgraded dashboard to show agent section with hosted link, embed code, copy buttons, and platform install guides for active subscribers.
- **Feb 15, 2026**: Implemented full SaaS signup flow: signup page, email verification (Nodemailer), checkout page, dashboard protection (email_verified + subscription_status), terms & privacy pages. Added columns to users table: email_verified, verification_token, subscription_status, terms_accepted. Webhook syncs subscription_status alongside is_paid. Login now redirects based on user state.
- **Feb 15, 2026**: Added professional SaaS landing page at "/", dashboard page at "/dashboard" with leads table and stats, improved success/cancel pages with dark theme. Added navigation between dashboard pages. All existing routes preserved including /home backward compat.
- **Feb 15, 2026**: Complete UI redesign of `/dashboard/install` page and `/login.html` page. Dark theme with Inter font, gradient hero card, modern cards with soft shadows, responsive layout, toast notifications.

## System Architecture

### Backend Framework
- **Express 4.x** serves as the HTTP framework. The entry point is `server.js`.
- Routes are organized in the `routes/` directory.
- Services live in the `services/` directory.
- Middleware in `middleware/` directory.

### User Journey
Landing -> Signup -> Verify Email -> Checkout (Stripe) -> Dashboard -> Install Widget

### Route Structure
| Route Prefix | File | Purpose |
|---|---|---|
| `/` | `server.js` | Landing page + health check (returns 200, no DB calls) |
| `/health` | `server.js` | Dedicated health check endpoint (instant 200, no DB) |
| `/install-success` | `server.js` | Post-payment success page with business info, hosted link, embed code + 3s auto-redirect to dashboard |
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
| `/dashboard` | `routes/dashboard.js` | Dashboard page, leads API, checkout, install page |
| `/dashboard/install` | `routes/install.js` | Install JSON API |
| `/agent` | `routes/agent.js` | Public AI agent endpoint |
| `/b` | `routes/publicBusiness.js` | Public business page |
| `/webhook` | `routes/webhook.js` | Stripe webhook handler |
| `/success` | `server.js` | Stripe payment success page |
| `/cancel` | `server.js` | Stripe payment cancel page |

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
- `views/dashboard.html` - Dashboard with leads table, stats cards, status badges
- `views/install.html` - Dashboard install page (server-rendered with template variables)
- `public/login.html` - Login page (redirects based on user state)
- `public/demo.html` - Widget demo page
- `public/widget.js` - Embeddable chat widget
- Template variables in install.html: `{{businessName}}`, `{{hostedPage}}`, `{{embedCode}}`, `{{statusText}}`, `{{statusClass}}`, `{{upgradeButton}}`
- Template variables in dashboard.html: `{{businessName}}`, `{{statusText}}`, `{{statusClass}}`, `{{upgradeButton}}`

### Authentication & Authorization
- Login via `POST /auth/login` using **bcrypt** password comparison.
- Signup via `POST /auth/signup` creates user + business_profile.
- Sessions managed with **express-session**.
- Auth middleware in `middleware/authMiddleware.js`.
- Dashboard protection: requires email_verified=true AND (subscription_status='active' OR is_paid=true)
- Login redirects: unverified -> /verify-pending, inactive subscription -> /checkout, active -> /dashboard

### Database
- **PostgreSQL** via the `pg` library with a connection pool (`services/db.js`).
- Connection string from `DATABASE_URL` environment variable.
- Tables: `users`, `business_profiles`, `leads`

### Users Table Columns
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
├── server.js              # Entry point, middleware, route mounting, new page routes
├── package.json           # Dependencies
├── views/
│   ├── landing.html       # Public SaaS landing page
│   ├── signup.html        # Signup page
│   ├── verify-pending.html # Email verification pending page
│   ├── checkout.html      # Stripe checkout page
│   ├── terms.html         # Terms & Conditions
│   ├── privacy.html       # Privacy Policy
│   ├── dashboard.html     # Dashboard with leads table
│   └── install.html       # Dashboard install page (dark SaaS UI)
├── public/
│   ├── login.html         # Login page (dark SaaS UI)
│   ├── demo.html          # Widget demo
│   └── widget.js          # Embeddable chat widget
├── routes/
│   ├── auth.js            # Authentication (login, signup, resend-verification)
│   ├── chat.js            # AI chat with usage limits
│   ├── dashboard.js       # Dashboard (page, leads, checkout, install) with protection
│   ├── install.js         # Install JSON API
│   ├── agent.js           # Public AI agent
│   ├── publicBusiness.js  # Public business page
│   └── webhook.js         # Stripe webhooks (syncs is_paid + subscription_status)
├── services/
│   ├── db.js              # PostgreSQL connection pool
│   ├── stripeService.js   # Stripe checkout sessions
│   ├── openaiService.js   # OpenAI sales reply generation
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
