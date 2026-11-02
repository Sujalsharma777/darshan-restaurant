# Customer Account Deletion (Darshan) — Implemented, Not Deployed

**Status (2026-10-30):** implemented in this repository, tested with mocked
Prisma, **not deployed, not committed**. Darshan Admin only calls it once
`ACCOUNT_DELETION_RESTAURANT_CLEANUP=true` is set there, so deploying this
first changes nothing on its own.

## Why

Google Play requires the Darshan app to let a user delete their account and
the data tied to it. Darshan Admin (the central login) deactivates the account
on request and processes it on day 30. Until now Restaurant had no way to
remove a customer, so an operator had to do it by hand.

## What was built

Three server-to-server endpoints, called only by Darshan Admin:

```
POST /api/restaurant/darshan/account-deletion/evaluate
POST /api/restaurant/darshan/account-deletion/anonymise
POST /api/restaurant/darshan/account-deletion/revoke-sessions
Authorization: Bearer <RESTAURANT_APP_API_KEY>      (requireRestaurantAppKey)
Content-Type: application/json

{ "service_token": "<RS256 service assertion from Darshan Admin>" }
```

Files:
- `backend/src/routes/customerDeletion.routes.ts` (mounted in `src/app.ts`)
- `backend/src/services/customerDeletionService.ts`
- `backend/src/lib/centralAuth.ts` → `verifyServiceToken()`
- `backend/src/services/customerAuthService.ts` (re-link refusal, below)
- `backend/prisma/schema.prisma` + migration
  `20261027000000_customer_account_deletion` (additive: `deletion_locked_at`,
  `anonymised_at`, `deleted_subject_ref` + unique index)
- `backend/src/docs/customerDeletion.docs.ts` (OpenAPI)
- `backend/tests/integration/customer-deletion.test.ts`,
  `backend/tests/unit/centralAuth.test.ts`

### Authentication

- App key, as for `/auth` (who is calling).
- `service_token`: verified against the central JWKS (issuer, audience, RS256)
  **plus** `purpose === "account_deletion"` and a lifetime of at most 300 s.
  Its claims name the customer: `restaurant_user_id` (from Darshan's link) and
  `central_user_id`. Nothing else in the body is read.
- A login `central_token` (no `purpose`) is refused here, and a service
  assertion is refused by `/auth` as a login.
- The row is acted on only while `centralUserId` still equals the claim
  (otherwise 409 `identity_mismatch`); an anonymised row is accepted so repeats
  stay no-ops.

### evaluate

Locks the customer (`deletion_locked_at`), revokes every refresh session, and
returns:

```json
{ "locked_at": "…", "blockers": [{ "code": "active_bookings", "count": 1 }],
  "retained": { "booking": [], "payment": [], "refund_eligible_booking": [], "unverified_payment": [] } }
```

Blocker: `active_bookings` = `UPCOMING` bookings dated today or later. Nothing
is cancelled or refunded by this code.

### anonymise

Only with no blockers (rechecked under a `SELECT … FOR UPDATE` row lock), in
one transaction:

| Data | Action |
|---|---|
| `restaurant_users` | **kept** (bookings and payments reference it): `name = "Deleted user"`, `phone = "deleted:<ref>"`, `email`, `playerId`, `centralUserId` = null, `anonymisedAt`, `deletedSubjectRef` set |
| `refresh_sessions`, `notifications` | deleted |
| `restaurant_bookings` | **kept**; `fullName = "Deleted user"`, `mobileNumber = ""`, `email`, `specialRequest` = null |
| `booking_preorder_items` | kept; `note` = null |
| `payments` | **kept untouched** (Razorpay ids, amounts) |

Responses (`{ status, message, data }` envelope):

| Status | Meaning |
|---|---|
| 200 | `data = { outcome: "anonymised", subject_ref, anonymised_at, retained }` — also on a repeat |
| 401 | bad app key or service token |
| 404 | `message = "not_found"` — no such customer; nothing left to clean |
| 409 | `data.outcome = "blocked"` with `blockers` (nothing changed), or `message = "identity_mismatch"` |

The `retained` ids become retention holds in Darshan Admin. Restaurant returns a
`retention_until` deadline based on `CUSTOMER_DATA_RETENTION_YEARS`, which
defaults to **8 years** from the deletion/anonymisation event. Cancelled bookings
with `refundEligible` and payments still `CREATED` are listed separately for
Finance, because nothing here records whether a refund was paid out or an
unverified order was captured.

### Same phone number, different person

`authenticateCentralUser` (POST `/api/restaurant/auth`) now refuses with 409:
- a customer locked for deletion or anonymised;
- a customer that already belongs to a **different** central user — a phone
  number alone never moves an account to another person.

After anonymisation the old row no longer has the number, so the next sign-in
with it creates a new, empty customer. Darshan Admin also refuses to link a new
account while an earlier deletion of that number has Restaurant unfinished.

## Tests (2026-10-27)

`npx vitest run` with test env values: **93 passed, 1 failed**. The failure,
`auth-boundaries › rejects a request missing the shared client key entirely`,
fails the same way on an untouched `HEAD` and is not related. New:
`customer-deletion.test.ts` 12/12, `centralAuth.test.ts` +5. `tsc --noEmit`
clean.

## Deployment checklist

- [ ] **Deploy:** `npx prisma migrate deploy`, then the code. Then set
      `ACCOUNT_DELETION_RESTAURANT_CLEANUP=true` in Darshan Admin (staging
      first).
- [x] **Retention:** kept bookings and payments have an 8-year minimum retention
  period, configured with `CUSTOMER_DATA_RETENTION_YEARS` (default `8`).
- [ ] **Legal/Finance:** confirm whether any records require a longer legal hold;
  confirm how a refund-eligible cancellation is confirmed as paid.
- [ ] **Product:** whether upcoming bookings should be cancelled and refunded
      through the normal path instead of blocking (today they block).
