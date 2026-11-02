import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import path from "node:path";
import swaggerUi from "swagger-ui-express";
import { pinoHttp } from "pino-http";
import type { Request } from "express";
import { env } from "./config/env.js";
import { errorHandler } from "./utils/http.js";
import { requireClientKey } from "./middleware/auth.js";
import { resolveLanguage } from "./middleware/language.js";
import { logger } from "./modules/logger.js";
import { swaggerSpec } from "./config/swagger.js";

import restaurantCentralAuthRoutes from "./routes/restaurantCentralAuth.routes.js";

// User-facing (customer app): only endpoints the app's own users may call.
import userAuthRoutes from "./routes/user/auth.routes.js";
import userRestaurantsRoutes from "./routes/user/restaurants.routes.js";
import userPaymentsRoutes from "./routes/user/payments.routes.js";
import userMyBookingsRoutes from "./routes/user/myBookings.routes.js";
import userRestaurantBookingsRoutes from "./routes/user/restaurantBookings.routes.js";
import userRestaurantEngagementRoutes from "./routes/user/restaurantEngagement.routes.js";

// Admin / SuperAdmin (back office): everything gated behind requireAdminAuth.
import adminAuthRoutes from "./routes/admin/auth.routes.js";
import adminAdminsRoutes from "./routes/admin/admins.routes.js";
import adminRestaurantsRoutes from "./routes/admin/restaurants.routes.js";
import adminMenuRoutes from "./routes/admin/menu.routes.js";
import adminTablesRoutes from "./routes/admin/tables.routes.js";
import adminBookingsRoutes from "./routes/admin/bookings.routes.js";
import adminNotificationsRoutes from "./routes/admin/notifications.routes.js";
import adminCategoriesRoutes from "./routes/admin/categories.routes.js";
import adminUploadsRoutes from "./routes/admin/uploads.routes.js";

export const app = express();

const origins = env.frontendOrigin.split(",").map((origin) => origin.trim());

// Uploaded images are served by this API but rendered by the admin frontend on another
// origin, so the default same-origin CORP would silently block <img> tags from loading them.
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(compression());
app.use(cookieParser());
app.use(pinoHttp({ logger }));
app.use(express.json({ limit: "2mb", verify: (req, _res, buf) => { (req as Request).rawBody = Buffer.from(buf); } }));
app.use(express.urlencoded({ extended: true }));
if (env.nodeEnv === "development") {
  app.use(morgan("dev"));
}
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || origins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  }),
);
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 500 }));
app.use("/uploads", express.static(path.resolve(process.cwd(), "uploads")));

app.get("/", (_req, res) => {
  res.json({ name: "Restaurant Backend API", status: "ok", docs: "/api/health" });
});

// OpenAPI docs: src/docs/health.docs.ts
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/docs.json", (_req, res) => res.json(swaggerSpec));
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, { customSiteTitle: "Restaurant Backend API Docs" }));

// Darshan Admin (central auth) server-to-server bridge — authenticated by its own
// app key (see requireRestaurantAppKey), not the admin frontend's x-client-key, so
// it must be mounted ahead of the requireClientKey gate below.
app.use("/api/restaurant", restaurantCentralAuthRoutes);

app.use("/api", requireClientKey);

// User (customer app) — only endpoints the app's own users may call. These answer in the
// language the app asks for (?lang= / Accept-Language), English by default.
app.use(["/api/auth", "/api/restaurants", "/api/payments", "/api/my-restaurant-bookings", "/api/restaurant-bookings", "/api/restaurant-wishlist", "/api/restaurant-reviews"], resolveLanguage);
app.use("/api/auth", userAuthRoutes);
app.use("/api/restaurants", userRestaurantsRoutes);
app.use("/api/payments", userPaymentsRoutes);
app.use("/api/my-restaurant-bookings", userMyBookingsRoutes);
app.use("/api/restaurant-bookings", userRestaurantBookingsRoutes);
app.use("/api", userRestaurantEngagementRoutes);

// Admin / SuperAdmin — everything gated behind requireAdminAuth.
app.use("/api/admin/auth", adminAuthRoutes);
app.use("/api/admin/admins", adminAdminsRoutes);
app.use("/api/admin/categories", adminCategoriesRoutes);
app.use("/api/admin/restaurants/:restaurantId/menu", adminMenuRoutes);
app.use("/api/admin/restaurants/:restaurantId/tables", adminTablesRoutes);
app.use("/api/admin/restaurants", adminRestaurantsRoutes);
app.use("/api/admin/bookings", adminBookingsRoutes);
app.use("/api/admin/notifications", adminNotificationsRoutes);
// Mounted at /api/uploads (not /api/admin/uploads) to match the existing frontend
// contract; the route file itself lives under routes/admin/ since it requires admin auth.
app.use("/api/uploads", adminUploadsRoutes);

app.use((_req, res) => {
  res.status(404).json({ status: false, message: "Route not found" });
});

app.use(errorHandler);
