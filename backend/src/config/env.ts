import "dotenv/config";

const required = (key: string, fallback?: string) => {
  const value = process.env[key] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  publicOrigin: (process.env.PUBLIC_ORIGIN ?? `http://localhost:${process.env.PORT ?? 4000}`).replace(/\/$/, ""),
  databaseUrl: required("DATABASE_URL"),

  jwtSecret: required("JWT_SECRET"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN,

  customerJwtSecret: required("CUSTOMER_JWT_SECRET"),
  customerAccessTokenTtl: process.env.CUSTOMER_ACCESS_TOKEN_TTL ?? "15m",
  customerRefreshTokenTtlDays: Number(process.env.CUSTOMER_REFRESH_TOKEN_TTL_DAYS ?? 30),

  frontendOrigin: process.env.FRONTEND_ORIGIN ?? "*",
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  redisPassword: process.env.REDIS_PASSWORD,
  logLevel: process.env.LOG_LEVEL ?? "info",

  superAdminName: process.env.SUPERADMIN_NAME ?? "Super Admin",
  superAdminEmail: process.env.SUPERADMIN_EMAIL,
  superAdminPassword: process.env.SUPERADMIN_PASSWORD,

  // Darshan Admin (central auth) server-to-server bridge — see
  // RESTAURANT_CENTRAL_AUTH_SPEC.md. The app key is required: this endpoint mints
  // real sessions, so it must never run open even by accidental misconfiguration.
  restaurantAppApiKey: required("RESTAURANT_APP_API_KEY"),
  centralAuthJwksUrl: process.env.CENTRAL_AUTH_JWKS_URL ?? "https://darshanadmin.bharatotel.com/api/darshan/auth/jwks.json",
  centralAuthIssuer: process.env.CENTRAL_AUTH_ISSUER ?? "https://darshanadmin.bharatotel.com",
  centralAuthAudience: process.env.CENTRAL_AUTH_AUDIENCE ?? "bharatotel-modules",
  customerDataRetentionYears: Number(process.env.CUSTOMER_DATA_RETENTION_YEARS ?? 8),

  razorpayKeyId: process.env.RAZORPAY_KEY_ID,
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET,
  restaurantBookingAdvanceInr: Number(process.env.RESTAURANT_BOOKING_ADVANCE_INR ?? 99),

  oneSignalAppId: process.env.ONESIGNAL_APP_ID,
  oneSignalApiKey: process.env.ONESIGNAL_API_KEY,

  bookingReminderMinutesBefore: Number(process.env.BOOKING_REMINDER_MINUTES_BEFORE ?? 120),
  businessTimeZone: process.env.BUSINESS_TIMEZONE ?? "Asia/Kolkata",

  appClientKey: process.env.APP_CLIENT_KEY,
};
