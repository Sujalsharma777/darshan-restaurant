import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { signCustomerAccessToken } from "../middleware/auth.js";
import { ApiError } from "../utils/http.js";
import { logger } from "../modules/logger.js";

const hashToken = (raw: string) => crypto.createHash("sha256").update(raw).digest("hex");
const generateRefreshToken = () => crypto.randomBytes(48).toString("hex");

const refreshExpiry = () => new Date(Date.now() + env.customerRefreshTokenTtlDays * 24 * 60 * 60 * 1000);

const issueSession = async (restaurantUserId: string) => {
  const rawRefreshToken = generateRefreshToken();
  await prisma.refreshSession.create({
    data: {
      restaurantUserId,
      tokenHash: hashToken(rawRefreshToken),
      expiresAt: refreshExpiry(),
    },
  });
  const accessToken = signCustomerAccessToken(restaurantUserId);
  const { exp, iat } = jwt.decode(accessToken) as { exp: number; iat: number };
  return { accessToken, refreshToken: rawRefreshToken, expiresIn: exp - iat };
};

/**
 * Login-or-register by phone number for the Darshan Admin (central auth) bridge.
 * Phone is the matching key: an existing row is returned untouched aside from
 * backfilling name/email/player_id, never recreated — order history, addresses
 * and saved cards must survive every call, since central auth calls this on
 * every login for the same user.
 */
export const authenticateCentralUser = async (input: {
  phone: string;
  centralUserId: number;
  name?: string;
  email?: string;
  playerId?: string;
}) => {
  const existing = await prisma.restaurantUser.findUnique({ where: { phone: input.phone } });

  // A customer whose Darshan account was deleted is never handed out again by phone
  // number: whoever holds that number now may not be the same person. Anonymised rows no
  // longer carry the number; this covers the window between the day-30 lock and
  // anonymisation (an upcoming booking, say).
  if (existing && (existing.deletionLockedAt || existing.anonymisedAt)) {
    throw new ApiError(409, "This restaurant account was closed. Please contact support.");
  }
  // Same rule for a row that already belongs to a different central user: the phone
  // number alone never moves an account from one person to another.
  if (existing && existing.centralUserId !== null && existing.centralUserId !== input.centralUserId) {
    throw new ApiError(409, "This phone number is linked to another account. Please contact support.");
  }

  const user = existing
    ? await prisma.restaurantUser.update({
        where: { id: existing.id },
        data: {
          centralUserId: input.centralUserId,
          name: input.name?.trim() || existing.name,
          email: input.email?.trim() || existing.email,
          playerId: input.playerId ?? existing.playerId,
        },
      })
    : await prisma.restaurantUser.create({
        data: {
          phone: input.phone,
          centralUserId: input.centralUserId,
          name: input.name?.trim() || "Guest",
          email: input.email?.trim(),
          playerId: input.playerId,
        },
      });

  const session = await issueSession(user.id);
  return { user, ...session, isNewUser: !existing };
};

export const refreshCustomerSession = async (rawRefreshToken: string) => {
  if (!rawRefreshToken) throw new ApiError(401, "Refresh token is required");
  const tokenHash = hashToken(rawRefreshToken);

  const session = await prisma.refreshSession.findUnique({ where: { tokenHash } });
  if (!session) throw new ApiError(401, "Invalid refresh token");

  if (session.revokedAt) {
    // Reuse of an already-rotated/revoked token — treat as compromised and kill every
    // active session for this user so a stolen token can't keep minting access tokens.
    logger.warn({ restaurantUserId: session.restaurantUserId }, "Refresh token reuse detected; revoking all sessions");
    await prisma.refreshSession.updateMany({
      where: { restaurantUserId: session.restaurantUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new ApiError(401, "Refresh token has already been used");
  }

  if (session.expiresAt < new Date()) throw new ApiError(401, "Refresh token has expired");

  const rawNewToken = generateRefreshToken();
  const newSession = await prisma.$transaction(async (tx) => {
    const created = await tx.refreshSession.create({
      data: {
        restaurantUserId: session.restaurantUserId,
        tokenHash: hashToken(rawNewToken),
        expiresAt: refreshExpiry(),
      },
    });
    await tx.refreshSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), replacedById: created.id },
    });
    return created;
  });

  return {
    accessToken: signCustomerAccessToken(session.restaurantUserId),
    refreshToken: rawNewToken,
    restaurantUserId: session.restaurantUserId,
    sessionId: newSession.id,
  };
};

export const logoutCustomer = async (rawRefreshToken: string) => {
  if (!rawRefreshToken) return;
  const tokenHash = hashToken(rawRefreshToken);
  await prisma.refreshSession.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
};
