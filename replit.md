# Sales Agent SaaS

## Overview
The AI Sales Agent SaaS is a modern, dark-themed web application designed to provide businesses with an AI-powered chat solution. Its primary purpose is to enhance lead capture, facilitate customer interaction through an embeddable chat widget, and offer per-business AI training capabilities. The platform supports user authentication, subscription management via Stripe, and integrates AI for dynamic conversational responses. The business vision is to empower businesses with an intelligent, customizable sales agent that can be easily integrated into their existing web presence, driving market potential by offering a comprehensive, easy-to-use solution for automated customer engagement and lead qualification.

## User Preferences
Preferred communication style: Simple, everyday language.
UI preference: Modern dark SaaS aesthetic, premium feel ($50/month tier look).

## System Architecture

### Core Frameworks and UI/UX
The application is built on **Node.js/Express**, serving as the backend HTTP framework. The UI/UX features a **modern dark SaaS theme** utilizing the Inter font, gradient cards, and glass effects, aiming for a premium aesthetic. Key pages like the dashboard, signup, login, and install pages adhere to this design language.

### Key Features and Implementations
- **User Authentication**: Implements a full SaaS signup flow with email verification (Nodemailer), bcrypt for password hashing, and session management using `express-session`.
- **Subscription Management**: Integrates **Stripe** for subscription billing, checkout sessions, and webhook handling. It includes a refund system within a 7-day window.
- **AI Sales Agent**: Features an AI-powered chat system using **OpenAI**. It supports a per-business knowledge base for customized responses and dynamic prompt generation with guardrails to ensure business-specific and on-topic interactions.
- **Business Knowledge System**: Allows businesses to train their AI by providing descriptions, services, pricing, FAQs, and tone. Includes a website scraping feature (using **Cheerio** and **node-fetch**) to automatically extract content from URLs for AI training, with SSRF protection and text limits.
- **Embeddable Chat Widget**: Provides a `widget.js` for easy integration of the AI chat agent into external websites.
- **Lead Capture & Dashboard**: A comprehensive dashboard displays leads and provides access to AI training, conversation logs, and installation instructions for the chat widget.
- **Chat History**: Stores every user message and AI response in `conversations` and `messages` tables, allowing businesses to review interactions.
- **Authorization**: Middleware handles authentication checks, email verification, and subscription status to protect routes. Admin role bypasses all subscription/payment checks.
- **Admin System**: Admin account (aisales@aiagentproperties.com) auto-provisioned with role=admin, active subscription, verified email. Hidden admin portal at `/internal-admin-portal-93847` with platform stats, user management, and leads table. Protected by `requireAdmin` middleware.

### Database
**PostgreSQL** is the chosen database, managed via the `pg` library. Key tables include `users`, `business_profiles`, `leads`, `business_knowledge`, `conversations`, `messages`, and `refunds`.

### Environment Variables
Crucial configurations are managed through environment variables such as `DATABASE_URL`, `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`, `BASE_URL`, and `SMTP` details for email services.

## External Dependencies

- **Express**: Web application framework.
- **PostgreSQL (via `pg`)**: Relational database management system.
- **Bcrypt**: For password hashing.
- **Express-session**: For managing user sessions.
- **Dotenv**: For loading environment variables.
- **OpenAI API**: For AI-powered chat functionalities.
- **Stripe**: For payment processing, subscriptions, and webhooks.
- **CORS**: For handling cross-origin requests.
- **Nodemailer**: For sending email verification and other notifications.
- **Cheerio**: Used for parsing and manipulating HTML, specifically for website scraping.
- **Node-fetch@2**: For making HTTP requests, particularly in the website scraping feature.