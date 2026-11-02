import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../../src/lib/prisma.js", async () => {
  const { createMockPrisma } = await import("../helpers/mockPrisma.js");
  return { prisma: createMockPrisma() };
});

vi.mock("../../src/lib/centralAuth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/centralAuth.js")>()),
  verifyServiceToken: vi.fn(),
}));

let app: import("express").Express;
let prisma: any;
let verifyServiceToken: any;
let appKey: string;
let ApiError: typeof import("../../src/utils/http.js").ApiError;
let authenticateCentralUser: typeof import("../../src/services/customerAuthService.js").authenticateCentralUser;

const customer = (overrides: Record<string, unknown> = {}) => ({
  id: "cust-1",
  phone: "+919876543210",
  name: "Asha",
  email: "asha@example.com",
  playerId: "player-1",
  centralUserId: 42,
  deletionLockedAt: null,
  anonymisedAt: null,
  deletedSubjectRef: null,
  ...overrides,
});

const claims = { purpose: "account_deletion", restaurant_user_id: "cust-1", central_user_id: 42 };

const post = (step: "evaluate" | "anonymise" | "revoke-sessions", key = appKey) =>
  request(app)
    .post(`/api/restaurant/darshan/account-deletion/${step}`)
    .set("Authorization", `Bearer ${key}`)
    .send({ service_token: "signed-service-jwt" });

beforeAll(async () => {
  ({ app } = await import("../../src/app.js"));
  ({ prisma } = await import("../../src/lib/prisma.js"));
  ({ verifyServiceToken } = await import("../../src/lib/centralAuth.js"));
  ({ env: { restaurantAppApiKey: appKey } } = (await import("../../src/config/env.js")) as any);
  ({ ApiError } = await import("../../src/utils/http.js"));
  ({ authenticateCentralUser } = await import("../../src/services/customerAuthService.js"));
});

beforeEach(() => {
  verifyServiceToken.mockResolvedValue(claims);
  prisma.restaurantBooking.count.mockResolvedValue(0);
  prisma.restaurantBooking.findMany.mockResolvedValue([
    { id: "bk-1", status: "CANCELLED", refundEligible: true },
    { id: "bk-2", status: "CANCELLED", refundEligible: false },
  ]);
  prisma.payment.findMany.mockResolvedValue([{ id: "pay-1", status: "VERIFIED" }, { id: "pay-2", status: "CREATED" }]);
  prisma.refreshSession.updateMany.mockResolvedValue({ count: 0 });
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/restaurant/darshan/account-deletion/*", () => {
  it("rejects a call without the app key", async () => {
    const res = await post("evaluate", "wrong-key");
    expect(res.status).toBe(401);
    expect(verifyServiceToken).not.toHaveBeenCalled();
  });

  it("rejects an invalid service token", async () => {
    verifyServiceToken.mockRejectedValue(new ApiError(401, "Invalid service_token"));
    const res = await post("anonymise");
    expect(res.status).toBe(401);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("asks for the account_deletion purpose", async () => {
    prisma.restaurantUser.findUnique.mockResolvedValue(customer());
    await post("evaluate");
    expect(verifyServiceToken).toHaveBeenCalledWith("signed-service-jwt", "account_deletion");
  });

  it("answers 404 for a customer that no longer exists", async () => {
    prisma.restaurantUser.findUnique.mockResolvedValue(null);
    const res = await post("anonymise");
    expect(res.status).toBe(404);
  });

  it("refuses a row that now belongs to a different central user", async () => {
    prisma.restaurantUser.findUnique.mockResolvedValue(customer({ centralUserId: 99 }));
    const res = await post("anonymise");
    expect(res.status).toBe(409);
    expect(res.body.message).toBe("identity_mismatch");
    expect(prisma.restaurantUser.update).not.toHaveBeenCalled();
  });

  it("revoke-sessions revokes every live session of the customer and changes nothing else", async () => {
    prisma.restaurantUser.findUnique.mockResolvedValue(customer());
    prisma.refreshSession.updateMany.mockResolvedValue({ count: 3 });
    const res = await post("revoke-sessions");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ revoked: 3 });
    expect(prisma.refreshSession.updateMany).toHaveBeenCalledWith({
      where: { restaurantUserId: "cust-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prisma.restaurantUser.update).not.toHaveBeenCalled();
  });

  it("revoke-sessions needs the app key and the customer's own central user", async () => {
    expect((await post("revoke-sessions", "wrong-key")).status).toBe(401);

    prisma.restaurantUser.findUnique.mockResolvedValue(customer({ centralUserId: 99 }));
    expect((await post("revoke-sessions")).status).toBe(409);
    expect(prisma.refreshSession.updateMany).not.toHaveBeenCalled();
  });

  it("evaluate locks the customer, revokes sessions and reports retained records", async () => {
    prisma.restaurantUser.findUnique.mockResolvedValue(customer());
    const res = await post("evaluate");

    expect(res.status).toBe(200);
    expect(prisma.restaurantUser.update).toHaveBeenCalledWith({
      where: { id: "cust-1" },
      data: { deletionLockedAt: expect.any(Date) },
    });
    expect(prisma.refreshSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { restaurantUserId: "cust-1", revokedAt: null } }),
    );
    expect(res.body.data.retention_until).toBeTruthy();
    expect(res.body.data.blockers).toEqual([]);
    expect(res.body.data.retained).toEqual({
      booking: ["bk-1", "bk-2"],
      payment: ["pay-1", "pay-2"],
      refund_eligible_booking: ["bk-1"],
      unverified_payment: ["pay-2"],
    });
  });

  it("refuses to anonymise while a booking is upcoming, and changes nothing", async () => {
    prisma.restaurantUser.findUnique.mockResolvedValue(customer({ deletionLockedAt: new Date() }));
    prisma.restaurantBooking.count.mockResolvedValue(1);

    const res = await post("anonymise");

    expect(res.status).toBe(409);
    expect(res.body.data).toEqual({ outcome: "blocked", blockers: [{ code: "active_bookings", count: 1 }] });
    expect(prisma.restaurantUser.update).not.toHaveBeenCalled();
    expect(prisma.notification.deleteMany).not.toHaveBeenCalled();
    expect(prisma.restaurantBooking.updateMany).not.toHaveBeenCalled();
  });

  it("anonymises the customer and their bookings, and keeps every payment", async () => {
    prisma.restaurantUser.findUnique.mockResolvedValue(customer({ deletionLockedAt: new Date() }));
    prisma.restaurantUser.update.mockImplementation((args: any) => ({ ...customer(), ...args.data }));

    const res = await post("anonymise");

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe("anonymised");
    expect(prisma.$queryRaw).toHaveBeenCalled(); // row lock
    expect(prisma.refreshSession.deleteMany).toHaveBeenCalledWith({ where: { restaurantUserId: "cust-1" } });
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({ where: { restaurantUserId: "cust-1" } });
    expect(prisma.restaurantBooking.updateMany).toHaveBeenCalledWith({
      where: { restaurantUserId: "cust-1" },
      data: { fullName: "Deleted user", mobileNumber: "", email: null, specialRequest: null },
    });

    const data = prisma.restaurantUser.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ name: "Deleted user", email: null, playerId: null, centralUserId: null });
    expect(data.phone).toBe(`deleted:${data.deletedSubjectRef}`);
    expect(res.body.data.subject_ref).toBe(data.deletedSubjectRef);
    expect(res.body.data.retention_until).toBeTruthy();

    // Payments are never written to.
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(prisma.payment.deleteMany).not.toHaveBeenCalled();
    expect(prisma.payment.delete).not.toHaveBeenCalled();
    expect(res.body.data.retained.payment).toEqual(["pay-1", "pay-2"]);

    // Booking and payment history is kept: rows are only ever anonymised in place,
    // and the customer row is never deleted (its bookings and payments point at it).
    expect(prisma.restaurantBooking.delete).not.toHaveBeenCalled();
    expect(prisma.restaurantBooking.deleteMany).not.toHaveBeenCalled();
    expect(prisma.bookingPreorder.delete).not.toHaveBeenCalled();
    expect(prisma.bookingPreorder.deleteMany).not.toHaveBeenCalled();
    expect(prisma.bookingPreorderItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.restaurantUser.delete).not.toHaveBeenCalled();
    expect(prisma.restaurantUser.deleteMany).not.toHaveBeenCalled();
    expect(res.body.data.retained.booking).toEqual(["bk-1", "bk-2"]);
  });

  it("is idempotent: an anonymised customer is not changed again", async () => {
    const done = customer({
      deletionLockedAt: new Date(),
      anonymisedAt: new Date("2026-10-27T10:00:00Z"),
      deletedSubjectRef: "ref-1",
      centralUserId: null,
      phone: "deleted:ref-1",
    });
    prisma.restaurantUser.findUnique.mockResolvedValue(done);

    const res = await post("anonymise");

    expect(res.status).toBe(200);
    expect(res.body.data.subject_ref).toBe("ref-1");
    expect(prisma.restaurantUser.update).not.toHaveBeenCalled();
    expect(prisma.notification.deleteMany).not.toHaveBeenCalled();
  });
});

describe("same phone number, different person", () => {
  it("refuses to sign anyone in to a customer locked for deletion", async () => {
    prisma.restaurantUser.findUnique.mockResolvedValue(customer({ deletionLockedAt: new Date() }));

    await expect(authenticateCentralUser({ phone: "+919876543210", centralUserId: 42 })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(prisma.refreshSession.create).not.toHaveBeenCalled();
  });

  it("never moves a customer to a new central user because the phone matches", async () => {
    prisma.restaurantUser.findUnique.mockResolvedValue(customer({ centralUserId: 42 }));

    await expect(authenticateCentralUser({ phone: "+919876543210", centralUserId: 77 })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(prisma.restaurantUser.update).not.toHaveBeenCalled();
  });

  it("after anonymisation the number gets a brand-new customer", async () => {
    // The anonymised row no longer has the number, so the lookup finds nothing.
    prisma.restaurantUser.findUnique.mockResolvedValue(null);
    prisma.restaurantUser.create.mockImplementation((args: any) => ({ id: "cust-2", ...args.data }));
    prisma.refreshSession.create.mockResolvedValue({ id: "s-1" });

    const result = await authenticateCentralUser({ phone: "+919876543210", centralUserId: 77 });

    expect(result.isNewUser).toBe(true);
    expect(result.user.id).toBe("cust-2");
  });
});
