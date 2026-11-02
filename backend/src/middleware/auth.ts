import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { AdminRole } from "../../generated/prisma/enums.js";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { DEFAULT_LANGUAGE, normalizeLanguage } from "../i18n/languages.js";
import { ApiError } from "../utils/http.js";

type AdminJwtPayload = { sub: string; email: string; role: AdminRole; type: "admin" };
type CustomerJwtPayload = { sub: string; type: "customer" };

// --- Admin / SuperAdmin ------------------------------------------------

export const signAdminToken = (payload: Omit<AdminJwtPayload, "type">) =>
  jwt.sign({ ...payload, type: "admin" }, env.jwtSecret, { expiresIn: env.jwtExpiresIn } as jwt.SignOptions);

export const requireAdminAuth = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) throw new ApiError(401, "Missing bearer token");

    const decoded = jwt.verify(token, env.jwtSecret) as AdminJwtPayload;
    if (decoded.type !== "admin") throw new ApiError(403, "This token cannot be used for admin APIs");

    const admin = await prisma.adminUser.findUnique({
      where: { id: decoded.sub },
      select: { id: true, email: true, role: true, status: true },
    });
    if (!admin || admin.status !== "ACTIVE") throw new ApiError(401, "Admin is inactive or does not exist");

    req.admin = { id: admin.id, email: admin.email, role: admin.role };
    next();
  } catch (error) {
    next(error instanceof ApiError ? error : new ApiError(401, "Invalid or expired token"));
  }
};

export const requireSuperAdmin = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.admin) return next(new ApiError(401, "Authentication required"));
  if (req.admin.role !== "SUPERADMIN") return next(new ApiError(403, "SuperAdmin access required"));
  next();
};

/**
 * Scopes a route to restaurants the authenticated admin is allowed to manage.
 * SuperAdmin bypasses the check entirely; a plain Admin must have an
 * AdminRestaurant link for the :restaurantId (or :id) route param.
 */
export const requireRestaurantAccess =
  (paramName = "restaurantId") =>
  async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.admin) throw new ApiError(401, "Authentication required");
      if (req.admin.role === "SUPERADMIN") return next();

      const restaurantId = req.params[paramName];
      if (!restaurantId || typeof restaurantId !== "string") throw new ApiError(400, `Missing route parameter: ${paramName}`);

      const link = await prisma.adminRestaurant.findUnique({
        where: { adminId_restaurantId: { adminId: req.admin.id, restaurantId } },
      });
      if (!link) throw new ApiError(403, "You are not authorized to manage this restaurant");
      next();
    } catch (error) {
      next(error instanceof ApiError ? error : new ApiError(403, "Not authorized"));
    }
  };

// --- Restaurant customer -------------------------------------------------

export const signCustomerAccessToken = (restaurantUserId: string) =>
  jwt.sign({ sub: restaurantUserId, type: "customer" } satisfies CustomerJwtPayload, env.customerJwtSecret, {
    expiresIn: env.customerAccessTokenTtl,
  } as jwt.SignOptions);

export const requireCustomerAuth = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) throw new ApiError(401, "Missing bearer token");

    const decoded = jwt.verify(token, env.customerJwtSecret) as CustomerJwtPayload;
    if (decoded.type !== "customer") throw new ApiError(403, "This token cannot be used for customer APIs");

    const customer = await prisma.restaurantUser.findUnique({
      where: { id: decoded.sub },
      select: { id: true, phone: true, language: true },
    });
    if (!customer) throw new ApiError(401, "Account no longer exists");

    // Remember the language the app is using so push notifications (sent outside any request) match it.
    let language = normalizeLanguage(customer.language) ?? DEFAULT_LANGUAGE;
    if (req.langExplicit && req.lang && req.lang !== language) {
      await prisma.restaurantUser.update({ where: { id: customer.id }, data: { language: req.lang } });
      language = req.lang;
    }

    req.customer = { id: customer.id, phone: customer.phone, language };
    next();
  } catch (error) {
    next(error instanceof ApiError ? error : new ApiError(401, "Invalid or expired token"));
  }
};

/** Adds customer identity for personalized public reads while leaving anonymous reads public. */
export const optionalCustomerAuth = (req: Request, _res: Response, next: NextFunction) => {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (token) {
      const decoded = jwt.verify(token, env.customerJwtSecret) as CustomerJwtPayload;
      if (decoded.type === "customer") req.customer = { id: decoded.sub, phone: "", language: DEFAULT_LANGUAGE };
    }
  } catch { /* Invalid/expired tokens behave like anonymous requests on public reads. */ }
  next();
};

// --- Shared ---------------------------------------------------------------

const timingSafeEqual = (a: string, b: string) => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return crypto.timingSafeEqual(bufA, bufA) && false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
};

export const requireClientKey = (req: Request, _res: Response, next: NextFunction) => {
  if (!env.appClientKey) return next();
  const provided = String(req.headers["x-client-key"] ?? "");
  if (!provided || !timingSafeEqual(provided, env.appClientKey)) {
    return next(new ApiError(401, "Invalid client key"));
  }
  return next();
};

/**
 * Gate for the Darshan Admin (central auth) server-to-server bridge. This is a
 * distinct trust boundary from `requireClientKey`: that one is the admin web
 * frontend's shared secret, this one identifies the central auth caller and is
 * carried as a normal bearer token per the integration spec, not x-client-key.
 */
export const requireRestaurantAppKey = (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!provided || !timingSafeEqual(provided, env.restaurantAppApiKey)) {
    return next(new ApiError(401, "Invalid or missing app key"));
  }
  return next();
};
