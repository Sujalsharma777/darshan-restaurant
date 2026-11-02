/**
 * @openapi
 * /api/restaurant/darshan/account-deletion/revoke-sessions:
 *   post:
 *     tags: [Restaurant Central Auth]
 *     summary: Revoke every refresh session of a customer whose Darshan account deletion was requested (server-to-server only)
 *     description: |
 *       Called by Darshan Admin on day 0, when the account is deactivated. Revokes all of
 *       the customer's live refresh sessions; nothing else changes.
 *     security:
 *       - RestaurantAppKey: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [service_token]
 *             properties:
 *               service_token: { type: string }
 *     responses:
 *       200: { description: "`data`: { revoked } — the number of sessions revoked" }
 *       401: { description: Bad app key or service token }
 *       404: { description: No such customer }
 *       409: { description: "`identity_mismatch`" }
 *
 * /api/restaurant/darshan/account-deletion/evaluate:
 *   post:
 *     tags: [Restaurant Central Auth]
 *     summary: Lock a customer for Darshan account deletion and report blockers (server-to-server only)
 *     description: |
 *       Called by Darshan Admin on day 30. Locks the customer (their phone number can no
 *       longer sign in — /auth answers 409), revokes every refresh session, and reports
 *       blockers (`active_bookings`) and the records that will be kept. See
 *       ACCOUNT_DELETION_PENDING.md.
 *     security:
 *       - RestaurantAppKey: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [service_token]
 *             properties:
 *               service_token:
 *                 type: string
 *                 description: RS256 assertion from Darshan Admin, purpose `account_deletion`, claims `restaurant_user_id` and `central_user_id`, lifetime ≤ 5 min
 *     responses:
 *       200: { description: "Locked. `data`: { locked_at, retention_until, blockers[], retained{ booking[], payment[], refund_eligible_booking[], unverified_payment[] } }" }
 *       401: { description: Bad app key or service token }
 *       404: { description: "No such customer (`not_found`) — nothing left to clean" }
 *       409: { description: "`identity_mismatch` — the row no longer belongs to that central user" }
 *
 * /api/restaurant/darshan/account-deletion/anonymise:
 *   post:
 *     tags: [Restaurant Central Auth]
 *     summary: Anonymise a locked customer, keeping bookings and payments (server-to-server only)
 *     security:
 *       - RestaurantAppKey: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [service_token]
 *             properties:
 *               service_token: { type: string }
 *     responses:
 *       200: { description: "Anonymised (or already was). `data`: { outcome: anonymised, subject_ref, anonymised_at, retention_until, retained }" }
 *       401: { description: Bad app key or service token }
 *       404: { description: No such customer }
 *       409: { description: "`data.outcome = blocked` with `blockers` (nothing changed), or `identity_mismatch`" }
 */
export { };
