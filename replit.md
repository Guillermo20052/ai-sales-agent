# Sales Agent SaaS

## Overview

AI Sales Agent SaaS application with a modern dark-themed dashboard UI. Provides user authentication, AI-powered chat via OpenAI, lead capture, Stripe subscription billing, and an embeddable chat widget for businesses.

Built with Node.js/Express, PostgreSQL, Stripe, and OpenAI.

## User Preferences

Preferred communication style: Simple, everyday language.
UI preference: Modern dark SaaS aesthetic, premium feel ($50/month tier look).

## Recent Changes

- **Feb 15, 2026**: Complete UI redesign of `/dashboard/install` page and `/login.html` page. Dark theme with Inter font, gradient hero card, modern cards with soft shadows, responsive layout, toast notifications. No backend logic was changed.

## System Architecture

### Backend Framework
- **Express 4.x** serves as the HTTP framework. The entry point is `server.js`.
- Routes are organized in the `routes/` directory.
- Services live in the `services/` directory.
- Middleware in `middleware/` directory.

### Route Structure
| Route Prefix | File | Status |
|---|---|---|
| `/auth` | `routes/auth.js` | Login endpoint (`POST /auth/login`) |
| `/chat` | `routes/chat.js` | AI chat with auth + usage limits |
| `/dashboard` | `routes/dashboard.js` | Leads, checkout, install page |
| `/dashboard/install` | `routes/install.js` | Install JSON API |
| `/agent` | `routes/agent.js` | Public AI agent endpoint |
| `/b` | `routes/publicBusiness.js` | Public business page |
| `/webhook` | `routes/webhook.js` | Stripe webhook handler |
| `/` | `server.js` | Health check |

### Frontend / UI
- **Dark SaaS theme** using Inter font (Google Fonts), gradient cards, glass effects
- `views/install.html` - Dashboard install page (server-rendered with template variables)
- `public/login.html` - Login page
- `public/demo.html` - Widget demo page
- `public/widget.js` - Embeddable chat widget
- Template variables in install.html: `{{businessName}}`, `{{hostedPage}}`, `{{embedCode}}`, `{{statusText}}`, `{{statusClass}}`, `{{upgradeButton}}`

### Authentication
- Login via `POST /auth/login` using **bcrypt** password comparison.
- Sessions managed with **express-session**.
- Auth middleware in `middleware/authMiddleware.js`.

### Database
- **PostgreSQL** via the `pg` library with a connection pool (`services/db.js`).
- Connection string from `DATABASE_URL` environment variable.
- Tables: `users`, `business_profiles`, `leads`

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

### Project Structure
```
├── server.js              # Entry point, middleware, route mounting
├── package.json           # Dependencies
├── views/
│   └── install.html       # Dashboard install page (dark SaaS UI)
├── public/
│   ├── login.html         # Login page (dark SaaS UI)
│   ├── demo.html          # Widget demo
│   └── widget.js          # Embeddable chat widget
├── routes/
│   ├── auth.js            # Authentication (login)
│   ├── chat.js            # AI chat with usage limits
│   ├── dashboard.js       # Dashboard (leads, checkout, install)
│   ├── install.js         # Install JSON API
│   ├── agent.js           # Public AI agent
│   ├── publicBusiness.js  # Public business page
│   └── webhook.js         # Stripe webhooks
├── services/
│   ├── db.js              # PostgreSQL connection pool
│   ├── stripeService.js   # Stripe checkout sessions
│   └── openaiService.js   # OpenAI sales reply generation
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