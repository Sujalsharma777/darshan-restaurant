# Restaurant Reservation System

A standalone restaurant table-reservation platform — Firebase phone-auth
customers, Razorpay booking-advance payments, and an Admin/SuperAdmin web
dashboard for managing restaurants, menus, slots, and bookings. Two-package
monorepo: an Express/TypeScript API and a React admin dashboard that also
ships as an Android app via Capacitor.

This repository was transformed from a Hotel/PMS template ("Darshan
Connector"). The Restaurant backend has **no dependency on GoAdapter or any
Hotel domain model** (StayProfile/Room/RoomType/RatePlan/etc.) — it owns its
own authentication, database, and business logic end to end. See
`backend/README.md` for the full domain model, API list, and what changed.

## Repository Layout

```text
backend/   Node.js + Express + Prisma API — see backend/README.md
frontend/  React + Vite + Capacitor Android admin dashboard — see frontend/README.md
.github/workflows/
  backend-deploy.yml   CI/CD: validate + test + deploy backend to the VPS on push to main
  frontend-deploy.yml  CI/CD: build + upload frontend dist/ to the VPS on push to main
```

Each package has its own dependencies, `.env` files, and lifecycle — always
`cd` into `backend/` or `frontend/` before running its scripts.

## Tech Stack

| | Backend | Frontend |
|---|---|---|
| Language | TypeScript (Node.js 22) | TypeScript |
| Framework | Express 5 | React 19 + Vite |
| Data | Prisma 7 + MySQL/MariaDB | TanStack Query, Zustand |
| Realtime | Socket.IO (Redis adapter), BullMQ | Socket.IO client |
| Mobile | — | Capacitor (Android) |
| Auth | Firebase phone-auth (customers), JWT + bcrypt (Admin/SuperAdmin) | — |
| Payments | Razorpay (booking advance) | — |
| Push | OneSignal (customer notifications) | — |
| Tests | Vitest (unit + mocked-Prisma integration) | — |

## Getting Started

Start the backend first, then the frontend — the frontend proxies API calls
to it.

```bash
# Backend
cd backend
cp .env.example .env      # fill in DATABASE_URL at minimum
npm install
npm run prisma:generate
npm run prisma:migrate     # applies prisma/migrations/20260822000000_init
npm run db:seed            # 2 restaurants, SuperAdmin, Admin, menu, slots
npm run dev                 # http://localhost:4000

# Frontend (in a second terminal)
cd frontend
cp .env.example .env       # VITE_CLIENT_KEY must match backend APP_CLIENT_KEY
npm install
npm run dev                 # http://localhost:3000
```

Requires a reachable MySQL/MariaDB server and Redis 6.2+. Full setup,
environment variables, the customer-facing API list, payment/notification
flow, and Android build steps live in the package READMEs:

- [backend/README.md](backend/README.md)
- [frontend/README.md](frontend/README.md)

## Core Concepts

- A `Restaurant` has its own menu (`MenuCategory` → `MenuItem`), slot
  configuration (`SlotConfiguration`, Lunch/Dinner), seating capacity, and
  category taxonomy — all admin-manageable, none hard-coded.
- Customers authenticate via Firebase phone OTP; the backend verifies the ID
  token server-side and owns its own rotating-refresh-token session — no
  GoAdapter or third-party identity dependency.
- A booking requires a **server-verified** Razorpay payment before it can be
  created, and a transaction-guarded capacity re-check at creation/
  modification time closes the race window between reading slot
  availability and writing the booking.
- `AdminUser` is either `ADMIN` (scoped to specific restaurants via
  `AdminRestaurant`) or `SUPERADMIN` (manages everything, including other
  Admins).

## Deployment

Both packages deploy independently via GitHub Actions on push to `main`:

- **Backend** (`backend-deploy.yml`): installs, generates the Prisma client,
  validates the schema, runs the test suite, builds, applies
  `prisma migrate deploy`, then restarts the API under PM2 on the VPS.
- **Frontend** (`frontend-deploy.yml`): builds static assets and uploads
  `dist/` to the VPS; no server restart needed since it's served as static
  files.

Both workflows only trigger on changes to their respective package path.

## Requirements

- Node.js 22.x LTS and npm 10+ for both packages
- MySQL or MariaDB, and Redis 6.2+ for the backend
- Java JDK 21 and the Android SDK for building the frontend's Android app

## Pending Work

| Item | Spec |
|---|---|
| Customer account deletion (`POST /api/restaurant/darshan/account-deletion/evaluate`, `/anonymise`, and `/revoke-sessions`) — **implemented, not deployed**; needs the migration and a deploy. Anonymised booking/payment history has an 8-year minimum retention configured by `CUSTOMER_DATA_RETENTION_YEARS` | [ACCOUNT_DELETION_PENDING.md](ACCOUNT_DELETION_PENDING.md) |
