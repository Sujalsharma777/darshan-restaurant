import swaggerJsdoc from "swagger-jsdoc";
import { env } from "./env.js";
import { SUPPORTED_LANGUAGES, TRANSLATION_LANGUAGES } from "../i18n/languages.js";

/**
 * OpenAPI spec generated from `@openapi` JSDoc blocks in src/docs/** (mirrors src/routes/**
 * 1:1 by filename — e.g. routes/admin/menu.routes.ts <-> docs/admin/menu.docs.ts). Docs live
 * apart from the routes themselves because a single endpoint's schema/response block is
 * routinely longer than its handler; keeping them separate keeps route files readable while
 * the mirrored filenames make "where are this endpoint's docs" a non-question.
 * Served as interactive docs at /api/docs and raw JSON at /api/docs.json (see app.ts).
 */
const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.3",
    info: {
      title: "Restaurant Backend API",
      version: "1.0.0",
      description:
        "REST API for the Restaurant admin/customer platform: customer-facing discovery/booking/payments, " +
        "the admin/superadmin back office, and the Darshan Admin central-auth server-to-server bridge.\n\n" +
        "**Languages.** Every `User:` endpoint accepts `?lang=` (or an `Accept-Language` header; `?lang=` wins) with one of " +
        `${SUPPORTED_LANGUAGES.map((lang) => `\`${lang}\``).join(", ")}. ` +
        "Restaurant, category and menu text is returned in that language, falling back to English per field when no translation exists; " +
        "unknown or missing languages mean English. The response envelope carries the language used as `lang` (and the `Content-Language` header). " +
        "When a signed-in customer sends a language it is saved, and push notifications are written in it. " +
        "Admin endpoints are not localized: they return English plus the full `translations` object for editing.",
    },
    servers: [{ url: `${env.publicOrigin}`, description: env.nodeEnv === "production" ? "Production" : "Current environment" }],
    // Tags are role-based first, resource-based second ("User: X" / "Admin: X"), so Swagger UI
    // groups into a User section and an Admin section instead of interleaving both roles under
    // one resource heading. Listed in that order here since swagger-ui-express preserves it.
    tags: [
      { name: "Health", description: "Service health check" },
      { name: "Restaurant Central Auth", description: "Server-to-server bridge used only by Darshan Admin (central auth) to mint app sessions" },

      { name: "User: Auth", description: "Session refresh/logout for the app (login/registration happens via the central auth bridge)" },
      { name: "User: Restaurants", description: "Restaurant discovery (read-only)" },
      { name: "User: Menu", description: "Menu categories and items (read-only)" },
      { name: "User: Arrival", description: "Same-day arrival-time window for ordering" },
      { name: "User: Tables", description: "Physical table availability for a specific date/time/party size" },
      { name: "User: Bookings", description: "The signed-in customer's own bookings and pre-orders" },
      { name: "User: Engagement", description: "Customer wishlist and restaurant reviews" },
      { name: "User: Payments", description: "Razorpay payment order creation and verification" },

      { name: "Admin: Auth", description: "Admin/SuperAdmin login and account" },
      { name: "Admin: Restaurants", description: "Restaurant management (admin/superadmin write access)" },
      { name: "Admin: Menu", description: "Menu categories and items (admin write access)" },
      { name: "Admin: Tables", description: "Physical table management and availability" },
      { name: "Admin: Bookings", description: "Booking management across restaurants" },
      { name: "Admin: Categories", description: "Restaurant category taxonomy (superadmin write, admin read)" },
      { name: "Admin: Admins", description: "Admin account management (superadmin only)" },
      { name: "Admin: Uploads", description: "Image uploads" },
    ],
    components: {
      securitySchemes: {
        ClientKey: {
          type: "apiKey",
          in: "header",
          name: "x-client-key",
          description: "Shared secret for the admin web frontend. Required on every /api/* route except the /api/restaurant/* bridge.",
        },
        AdminBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Admin/SuperAdmin session token from POST /api/admin/auth/login.",
        },
        CustomerBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Customer access token, issued by the central auth bridge and renewed via POST /api/auth/refresh.",
        },
        RestaurantAppKey: {
          type: "http",
          scheme: "bearer",
          description: "Server-to-server app key for the Darshan Admin (central auth) bridge. Distinct trust boundary from ClientKey.",
        },
      },
      parameters: {
        Lang: {
          in: "query",
          name: "lang",
          required: false,
          schema: { type: "string", enum: [...SUPPORTED_LANGUAGES], default: "en" },
          description: "Response language. Falls back to Accept-Language, then English.",
        },
      },
      schemas: {
        SuccessEnvelope: {
          type: "object",
          properties: {
            status: { type: "boolean", example: true },
            message: { type: "string", example: "OK" },
            lang: { type: "string", enum: [...SUPPORTED_LANGUAGES], example: "hi", description: "Customer-app (User:) endpoints only: the language the response is in." },
            data: {},
          },
          required: ["status", "message"],
        },
        ErrorEnvelope: {
          type: "object",
          properties: {
            status: { type: "boolean", example: false },
            message: { type: "string", example: "Something went wrong" },
          },
          required: ["status", "message"],
        },
        ValidationErrorEnvelope: {
          type: "object",
          properties: {
            status: { type: "boolean", example: false },
            message: { type: "string", example: "Validation failed" },
            errors: { type: "array", items: { type: "object" } },
          },
          required: ["status", "message", "errors"],
        },
        AdminSummary: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            email: { type: "string", format: "email" },
            role: { type: "string", enum: ["ADMIN", "SUPERADMIN"] },
            status: { type: "string", enum: ["ACTIVE", "INACTIVE"] },
          },
        },
        Translations: {
          type: "object",
          description:
            "Other-language copies of a record's text fields, keyed by language then field. English stays in the regular fields. " +
            "Blank values are dropped; on update the object replaces the stored one as a whole (send {} to clear).",
          properties: Object.fromEntries(TRANSLATION_LANGUAGES.map((lang) => [lang, { type: "object", additionalProperties: { type: "string" } }])),
          example: { hi: { name: "पनीर टिक्का", description: "तंदूर में पका पनीर" }, ta: { name: "பனீர் டிக்கா" } },
        },
        Pagination: {
          type: "object",
          properties: {
            page: { type: "integer", example: 1 },
            limit: { type: "integer", example: 20 },
            total: { type: "integer", example: 42 },
            totalPages: { type: "integer", example: 3 },
          },
        },
      },
      responses: {
        Unauthorized: {
          description: "Missing/invalid credentials",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
        },
        Forbidden: {
          description: "Authenticated but not allowed to perform this action",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
        },
        NotFound: {
          description: "Resource not found",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
        },
        ValidationError: {
          description: "Request failed schema validation",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ValidationErrorEnvelope" } } },
        },
      },
    },
    security: [{ ClientKey: [] }],
  },
  // Both patterns are globbed (unmatched ones are simply empty) so docs work equally
  // from `tsx` (reads .ts source) and from a `tsc` build run as `node dist/src/server.js`
  // (reads the compiled .js, since dist ships without the original .ts comments' source).
  apis: ["./src/docs/**/*.ts", "./dist/src/docs/**/*.js"],
};

const USER_PATH_PREFIXES = ["/api/auth", "/api/restaurants", "/api/payments", "/api/my-restaurant-bookings", "/api/restaurant-bookings", "/api/restaurant-wishlist", "/api/restaurant-reviews"];

/** Adds the shared `lang` parameter to every customer-app operation (see resolveLanguage middleware). */
const withLangParameter = (spec: any) => {
  for (const [path, operations] of Object.entries<Record<string, any>>(spec.paths ?? {})) {
    if (!USER_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) continue;
    for (const operation of Object.values(operations)) {
      if (!operation || typeof operation !== "object") continue;
      operation.parameters = [...(operation.parameters ?? []), { $ref: "#/components/parameters/Lang" }];
    }
  }
  return spec;
};

export const swaggerSpec = withLangParameter(swaggerJsdoc(options));
