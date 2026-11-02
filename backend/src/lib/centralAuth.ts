import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "../config/env.js";
import { ApiError } from "../utils/http.js";
import { logger } from "../modules/logger.js";

export type CentralAuthClaims = {
  sub: string;
  centralUserId: number;
  phoneNumber: string;
  phoneVerified: boolean;
  name?: string;
  email?: string;
};

// Cached for the process lifetime; jose refetches the JWKS itself on a `kid` miss
// (e.g. after Darshan rotates keys) and cools down on repeated failures, matching
// the "fetch once, cache it, pick by kid" contract in the spec.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
const getJwks = () => {
  if (!jwks) jwks = createRemoteJWKSet(new URL(env.centralAuthJwksUrl));
  return jwks;
};

/**
 * Verifies a Darshan Admin `central_token` (RS256, JWKS-backed) and returns its
 * claims. Never trust the request body over these claims — the phone number in
 * particular must be cross-checked by the caller against the body's `phone`.
 */
export const verifyCentralToken = async (token: string): Promise<CentralAuthClaims> => {
  if (!token) throw new ApiError(401, "central_token is required");

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, getJwks(), {
      issuer: env.centralAuthIssuer,
      audience: env.centralAuthAudience,
      algorithms: ["RS256"],
      clockTolerance: 60,
    }));
  } catch (error) {
    logger.warn({ err: error }, "central_token verification failed");
    const reason = error instanceof Error ? error.message : "signature verification failed";
    throw new ApiError(401, `Invalid central_token: ${reason}`);
  }

  // A service assertion (verifyServiceToken) proves an operation, never a person.
  if (payload.purpose !== undefined) {
    throw new ApiError(401, "Invalid central_token: service assertions cannot sign in");
  }
  if (payload.phone_verified !== true) {
    throw new ApiError(401, "Invalid central_token: phone is not verified");
  }
  if (typeof payload.phone_number !== "string" || !payload.phone_number) {
    throw new ApiError(401, "Invalid central_token: missing phone_number claim");
  }
  if (typeof payload.sub !== "string") {
    throw new ApiError(401, "Invalid central_token: missing sub claim");
  }

  const centralUserId = Number(payload.central_user_id ?? payload.sub);
  if (!Number.isFinite(centralUserId)) {
    throw new ApiError(401, "Invalid central_token: missing central_user_id claim");
  }

  return {
    sub: payload.sub,
    centralUserId,
    phoneNumber: payload.phone_number,
    phoneVerified: true,
    name: typeof payload.name === "string" ? payload.name : undefined,
    email: typeof payload.email === "string" ? payload.email : undefined,
  };
};

/** Longest lifetime accepted on a service assertion; Darshan Admin mints them for 120s. */
const SERVICE_MAX_TTL_SECONDS = 300;

export type CentralServiceClaims = Record<string, unknown> & { purpose: string };

/**
 * Verifies a Darshan Admin server-to-server assertion for one operation (today only
 * `account_deletion`). Same key, issuer, audience and algorithm as a login token, plus:
 * `purpose` must be the one the route expects — a login token has none and is refused —
 * and the token may live at most five minutes. It carries no phone number; the claims
 * name what the operation acts on.
 */
export const verifyServiceToken = async (token: string, purpose: string): Promise<CentralServiceClaims> => {
  if (!token) throw new ApiError(401, "service_token is required");

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, getJwks(), {
      issuer: env.centralAuthIssuer,
      audience: env.centralAuthAudience,
      algorithms: ["RS256"],
      clockTolerance: 60,
    }));
  } catch (error) {
    logger.warn({ err: error }, "service_token verification failed");
    throw new ApiError(401, "Invalid service_token");
  }

  if (payload.purpose !== purpose) {
    throw new ApiError(401, "Invalid service_token: wrong purpose");
  }
  if (
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    payload.exp - payload.iat > SERVICE_MAX_TTL_SECONDS
  ) {
    throw new ApiError(401, "Invalid service_token: lifetime too long");
  }

  return payload as CentralServiceClaims;
};
