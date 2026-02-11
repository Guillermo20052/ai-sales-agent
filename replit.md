# Sales Agent SaaS

## Overview

This is an AI Sales Agent SaaS backend application. It provides a REST API for user authentication, AI-powered chat (intended to use OpenAI), and a dashboard. The project is in its early stages — authentication registration is implemented, while chat and dashboard routes are stubbed out with placeholder responses.

The application is built with Node.js and Express, uses PostgreSQL for data storage, and is designed to integrate with OpenAI for AI sales agent functionality.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Backend Framework
- **Express 5.x** serves as the HTTP framework. The entry point is `server.js`.
- Routes are organized in the `routes/` directory, with separate files for `auth`, `chat`, and `dashboard`.
- Services (like database connections) live in the `services/` directory.

### Route Structure
| Route Prefix | File | Status |
|---|---|---|
| `/auth` | `routes/auth.js` | Registration endpoint implemented (`POST /auth/register`) |
| `/chat` | `routes/chat.js` | Stub — placeholder GET route only |
| `/dashboard` | `routes/dashboard.js` | Stub — placeholder GET route only |
| `/` | `server.js` | Health check endpoint |

### Authentication
- User registration uses **bcrypt** for password hashing (cost factor 10).
- Sessions are managed with **express-session** using a secret from the `SESSION_SECRET` environment variable (falls back to `"devsecret"`).
- There is no login endpoint yet — only registration exists.
- No session-based auth middleware or JWT is implemented yet.

### Database
- **PostgreSQL** via the `pg` library with a connection pool (`services/db.js`).
- Connection string comes from the `DATABASE_URL` environment variable.
- SSL is enabled when `DATABASE_URL` is set (with `rejectUnauthorized: false`).
- The database requires a `users` table with at least these columns: `id`, `email` (unique), `password`, `created_at`. There is no migration system or schema file in the repo — the table must be created manually or a migration system should be added.

**Expected users table schema:**
```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Environment Variables
| Variable | Purpose | Required |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `SESSION_SECRET` | Secret for express-session | No (defaults to "devsecret") |
| `PORT` | Server port | No (defaults to 5000) |
| `OPENAI_API_KEY` | OpenAI API key (not yet used but the library is installed) | Not yet |

### Project Structure
```
├── server.js            # Entry point, middleware setup, route mounting
├── package.json         # Dependencies and scripts
├── routes/
│   ├── auth.js          # User registration
│   ├── chat.js          # Chat (stub)
│   └── dashboard.js     # Dashboard (stub)
└── services/
    └── db.js            # PostgreSQL connection pool
```

## External Dependencies

### Core Dependencies
- **express (v5.2.1)** — Web framework
- **pg (v8.18.0)** — PostgreSQL client for Node.js
- **bcrypt (v6.0.0)** — Password hashing (uses native addon via node-addon-api)
- **express-session (v1.19.0)** — Server-side session management
- **dotenv (v17.2.4)** — Environment variable loading from `.env` files
- **openai (v6.21.0)** — OpenAI API client (installed but not yet used in any route)

### Database
- **PostgreSQL** — Required as the primary data store. Must be provisioned and the `DATABASE_URL` environment variable set. No ORM or migration tool is in use — raw SQL queries are used directly via the `pg` pool.

### Planned Integrations
- **OpenAI API** — The `openai` package is installed but not yet integrated. It will likely power the chat/sales agent functionality in `routes/chat.js`.