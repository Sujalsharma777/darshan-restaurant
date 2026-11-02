import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const jwtVerify = vi.fn();
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: (...args: unknown[]) => jwtVerify(...args),
}));

let verifyCentralToken: typeof import("../../src/lib/centralAuth.js").verifyCentralToken;
let verifyServiceToken: typeof import("../../src/lib/centralAuth.js").verifyServiceToken;

beforeAll(async () => {
  ({ verifyCentralToken, verifyServiceToken } = await import("../../src/lib/centralAuth.js"));
});

afterEach(() => {
  vi.clearAllMocks();
});

const validPayload = {
  sub: "42",
  central_user_id: 42,
  phone_number: "+919876543210",
  phone_verified: true,
  name: "Sujal Sharma",
  email: "sujal@example.com",
};

describe("verifyCentralToken", () => {
  it("rejects an empty token without calling jose", async () => {
    await expect(verifyCentralToken("")).rejects.toThrow(/required/i);
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it("wraps a jose verification failure (bad signature, wrong alg, expired, etc.) as a 401 ApiError", async () => {
    jwtVerify.mockRejectedValue(new Error("signature verification failed"));
    await expect(verifyCentralToken("bad-token")).rejects.toMatchObject({
      statusCode: 401,
      message: expect.stringContaining("signature verification failed"),
    });
  });

  it("rejects a token whose phone_verified claim is not true", async () => {
    jwtVerify.mockResolvedValue({ payload: { ...validPayload, phone_verified: false } });
    await expect(verifyCentralToken("tok")).rejects.toMatchObject({ statusCode: 401 });
  });

  it("returns normalized claims for a valid token", async () => {
    jwtVerify.mockResolvedValue({ payload: validPayload });
    const claims = await verifyCentralToken("tok");
    expect(claims).toMatchObject({
      sub: "42",
      centralUserId: 42,
      phoneNumber: "+919876543210",
      phoneVerified: true,
      name: "Sujal Sharma",
      email: "sujal@example.com",
    });
  });
});

describe("verifyServiceToken", () => {
  const now = Math.floor(Date.now() / 1000);
  const service = { purpose: "account_deletion", restaurant_user_id: "cust-1", central_user_id: 42, iat: now, exp: now + 120 };

  it("returns the claims of a valid assertion for the expected purpose", async () => {
    jwtVerify.mockResolvedValue({ payload: service });
    await expect(verifyServiceToken("tok", "account_deletion")).resolves.toMatchObject({ restaurant_user_id: "cust-1" });
  });

  it("rejects a login token, which has no purpose", async () => {
    jwtVerify.mockResolvedValue({ payload: { ...validPayload, iat: now, exp: now + 3600 } });
    await expect(verifyServiceToken("tok", "account_deletion")).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects an assertion minted for another purpose", async () => {
    jwtVerify.mockResolvedValue({ payload: { ...service, purpose: "something_else" } });
    await expect(verifyServiceToken("tok", "account_deletion")).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects an assertion that lives longer than five minutes", async () => {
    jwtVerify.mockResolvedValue({ payload: { ...service, exp: now + 3600 } });
    await expect(verifyServiceToken("tok", "account_deletion")).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe("verifyCentralToken and service assertions", () => {
  it("refuses a service assertion as a login", async () => {
    jwtVerify.mockResolvedValue({ payload: { ...validPayload, purpose: "account_deletion" } });
    await expect(verifyCentralToken("tok")).rejects.toMatchObject({ statusCode: 401 });
  });
});
