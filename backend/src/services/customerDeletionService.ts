import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { ApiError } from "../utils/http.js";
import { logger } from "../modules/logger.js";

/**
 * What happens to a restaurant customer when their Darshan account is deleted (day 30).
 * Driven by Darshan Admin over POST /api/restaurant/darshan/account-deletion/*; nothing
 * here runs on its own.
 *
 *   evaluate   Locks the customer (the phone number can no longer sign in to this row —
 *              /auth answers 409 — and every refresh session is revoked), then reports
 *              what stands in the way of anonymising and which records will be kept.
 *
 *   anonymise  Only when nothing stands in the way, in one transaction:
 *     restaurant_users     kept (bookings and payments reference it); name, phone,
 *                          e-mail, OneSignal id and central user id replaced
 *     refresh_sessions,    deleted
 *     notifications
 *     restaurant_bookings  kept with amounts, dates and status; guest name, mobile,
 *                          e-mail and special request removed
 *     preorder items       kept; free-text notes removed
 *     payments             kept untouched (Razorpay ids and amounts)
 *
 * Kept bookings and payments have an eight-year minimum retention hold by default. The
 * deadline is returned to Darshan Admin so it can coordinate any later cleanup review.
 * Repeat calls are no-ops.
 */

const ANONYMISED_PHONE_PREFIX = "deleted:";

const retentionDeadline = (from: Date) => {
  const deadline = new Date(from);
  deadline.setUTCFullYear(deadline.getUTCFullYear() + env.customerDataRetentionYears);
  return deadline.toISOString();
};

export type Blocker = { code: string; count: number };

type Customer = NonNullable<Awaited<ReturnType<typeof prisma.restaurantUser.findUnique>>>;

/**
 * The customer the assertion names, or an ApiError. The id comes from Darshan's link;
 * the row is only acted on while it still belongs to that central user (an anonymised
 * row has had its central user id cleared, and is accepted so repeats stay no-ops).
 */
export const findCustomerForDeletion = async (claims: Record<string, unknown>): Promise<Customer> => {
  const restaurantUserId = typeof claims.restaurant_user_id === "string" ? claims.restaurant_user_id : "";
  const centralUserId = Number(claims.central_user_id);

  const customer = restaurantUserId
    ? await prisma.restaurantUser.findUnique({ where: { id: restaurantUserId } })
    : null;

  if (!customer) throw new ApiError(404, "not_found");

  if (!customer.anonymisedAt && customer.centralUserId !== centralUserId) {
    throw new ApiError(409, "identity_mismatch");
  }

  return customer;
};

type Db = Pick<typeof prisma, "restaurantBooking">;

export const deletionBlockers = async (customerId: string, db: Db = prisma): Promise<Blocker[]> => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const upcoming = await db.restaurantBooking.count({
    where: { restaurantUserId: customerId, status: "UPCOMING", date: { gte: today } },
  });

  return upcoming > 0 ? [{ code: "active_bookings", count: upcoming }] : [];
};

export const retainedRecords = async (customerId: string) => {
  const [bookings, payments] = await Promise.all([
    prisma.restaurantBooking.findMany({
      where: { restaurantUserId: customerId },
      select: { id: true, status: true, refundEligible: true },
    }),
    prisma.payment.findMany({ where: { restaurantUserId: customerId }, select: { id: true, status: true } }),
  ]);

  return {
    booking: bookings.map((b) => b.id),
    payment: payments.map((p) => p.id),
    // Cancelled with a refund due: nothing here records whether it was paid out, so
    // each one needs Finance to confirm.
    refund_eligible_booking: bookings.filter((b) => b.status === "CANCELLED" && b.refundEligible).map((b) => b.id),
    // A Razorpay order that never verified — possibly abandoned, possibly captured.
    unverified_payment: payments.filter((p) => p.status === "CREATED").map((p) => p.id),
  };
};

/**
 * Day 0 of a deletion request: every live refresh session the customer has is revoked,
 * not just the one Darshan last stored — each Darshan login issues a new session and
 * leaves the earlier ones live. Nothing else changes; a cancelled request simply links
 * again on the next login.
 */
export const revokeCustomerSessions = async (customer: Customer) => {
  const { count } = await prisma.refreshSession.updateMany({
    where: { restaurantUserId: customer.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  return { revoked: count };
};

export const evaluateCustomerDeletion = async (customer: Customer) => {
  const lockedAt = customer.deletionLockedAt ?? new Date();

  if (!customer.deletionLockedAt) {
    await prisma.restaurantUser.update({ where: { id: customer.id }, data: { deletionLockedAt: lockedAt } });
  }

  if (!customer.anonymisedAt) {
    await revokeCustomerSessions(customer);
  }

  return {
    locked_at: lockedAt.toISOString(),
    retention_until: retentionDeadline(lockedAt),
    blockers: customer.anonymisedAt ? [] : await deletionBlockers(customer.id),
    retained: await retainedRecords(customer.id),
  };
};

export type AnonymiseResult =
  | {
    outcome: "anonymised";
    subject_ref: string;
    anonymised_at: string;
    retention_until: string;
    retained: Awaited<ReturnType<typeof retainedRecords>>;
  }
  | { outcome: "blocked"; blockers: Blocker[] };

export const anonymiseCustomer = async (customer: Customer): Promise<AnonymiseResult> => {
  if (!customer.deletionLockedAt) await evaluateCustomerDeletion(customer);

  const result = await prisma.$transaction(async (tx) => {
    // Row lock, so a booking made in a race (or a second anonymise call) waits for us.
    await tx.$queryRaw`SELECT id FROM restaurant_users WHERE id = ${customer.id} FOR UPDATE`;
    const current = await tx.restaurantUser.findUnique({ where: { id: customer.id } });
    if (!current) throw new ApiError(404, "not_found");
    if (current.anonymisedAt) return current;

    // Rechecked under the lock: a booking may have landed since evaluate.
    const blockers = await deletionBlockers(customer.id, tx);
    if (blockers.length > 0) return { blockers };

    const ref = current.deletedSubjectRef ?? crypto.randomUUID();

    // Booking and payment history is never deleted — only the person is removed from
    // it. Only sessions and notifications go.
    await tx.refreshSession.deleteMany({ where: { restaurantUserId: customer.id } });
    await tx.notification.deleteMany({ where: { restaurantUserId: customer.id } });
    await tx.restaurantBooking.updateMany({
      where: { restaurantUserId: customer.id },
      data: { fullName: "Deleted user", mobileNumber: "", email: null, specialRequest: null },
    });
    await tx.bookingPreorderItem.updateMany({
      where: { preorder: { booking: { restaurantUserId: customer.id } } },
      data: { note: null },
    });

    return tx.restaurantUser.update({
      where: { id: customer.id },
      data: {
        name: "Deleted user",
        // `phone` is NOT NULL and unique; this can never be a dialable number.
        phone: `${ANONYMISED_PHONE_PREFIX}${ref}`,
        email: null,
        playerId: null,
        centralUserId: null,
        anonymisedAt: new Date(),
        deletedSubjectRef: ref,
      },
    });
  });

  if ("blockers" in result) return { outcome: "blocked", blockers: result.blockers };

  logger.info({ restaurantUserId: customer.id }, "Customer anonymised for Darshan account deletion");

  return {
    outcome: "anonymised",
    subject_ref: result.deletedSubjectRef as string,
    anonymised_at: (result.anonymisedAt as Date).toISOString(),
    retention_until: retentionDeadline(result.anonymisedAt as Date),
    retained: await retainedRecords(customer.id),
  };
};
