import { Router } from "express";
import { z } from "zod";
import { optionalCustomerAuth, requireCustomerAuth } from "../../middleware/auth.js";
import { getRestaurantDetail, listRestaurantCategories, listRestaurants } from "../../services/restaurantService.js";
import { getMenu } from "../../services/menuService.js";
import { getArrivalWindow } from "../../services/arrivalService.js";
// import { getTableAvailability } from "../../services/tableService.js"; // Table booking disabled
import { createBooking } from "../../services/bookingService.js";
import { TABLE_PREFERENCE_LABELS } from "../../constants/bookingOptions.js";
import { asyncHandler, idParam, sendSuccess, validateBody, validateQuery } from "../../utils/http.js";

const router = Router();

const coordinate = z.coerce.number().min(-180).max(180).optional();

const listQuerySchema = z.object({
  city: z.string().trim().optional(),
  category: z.string().trim().optional(),
  q: z.string().trim().optional(),
  latitude: coordinate,
  longitude: coordinate,
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// OpenAPI docs: src/docs/user/restaurants.docs.ts
router.get(
  "/",
  optionalCustomerAuth,
  asyncHandler(async (req, res) => {
    const query = validateQuery(listQuerySchema, req.query);
    const result = await listRestaurants({ ...query, lang: req.lang, customerId: req.customer?.id });
    sendSuccess(res, { restaurants: result.restaurants, pagination: result.pagination });
  }),
);

// Category filter chips ("Pure Veg", ...). Declared before "/:id" so "categories" isn't read as an id.
router.get(
  "/categories",
  asyncHandler(async (req, res) => {
    sendSuccess(res, await listRestaurantCategories(req.lang));
  }),
);

const detailQuerySchema = z.object({ latitude: coordinate, longitude: coordinate });

router.get(
  "/:id",
  optionalCustomerAuth,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const query = validateQuery(detailQuerySchema, req.query);
    const userLocation = query.latitude !== undefined && query.longitude !== undefined ? { latitude: query.latitude, longitude: query.longitude } : undefined;
    const restaurant = await getRestaurantDetail(id, userLocation, req.lang, req.customer?.id);
    sendSuccess(res, restaurant);
  }),
);

router.get(
  "/:id/menu",
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const menu = await getMenu(id, req.lang);
    sendSuccess(res, menu);
  }),
);

// Today's allowed arrival times (orders are same-day only): from now + prep time until closing.
router.get(
  "/:id/arrival-window",
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    sendSuccess(res, await getArrivalWindow(id));
  }),
);

// Table booking disabled — customer table availability endpoint turned off for now.
// const tableAvailabilityQuerySchema = z.object({
//   date: z.string().min(1, "date is required"),
//   time: z.string().min(1, "time is required"),
//   people: z.coerce.number().int().min(1).default(1),
//   tablePreference: z.enum(Object.values(TABLE_PREFERENCE_LABELS) as [string, ...string[]]).optional(),
// });
//
// router.get(
//   "/:id/tables/availability",
//   asyncHandler(async (req, res) => {
//     const id = idParam(req);
//     const query = validateQuery(tableAvailabilityQuerySchema, req.query);
//     const availability = await getTableAvailability(id, query.date, query.time, query.people, query.tablePreference);
//     sendSuccess(res, availability);
//   }),
// );

const bookingSchema = z.object({
  /** Optional: orders are same-day only, so this defaults to today and must be today if sent. */
  date: z.string().min(1).optional(),
  /** Arrival time, e.g. "1:30 PM". */
  time: z.string().min(1),
  people: z.coerce.number().int().min(1),
  // Table booking disabled — kept optional so older app builds that still send it keep working.
  tablePreference: z.enum(Object.values(TABLE_PREFERENCE_LABELS) as [string, ...string[]]).optional(),
  specialRequest: z.string().trim().max(500).optional(),
  fullName: z.string().trim().min(1),
  mobileNumber: z.string().trim().min(6),
  email: z.email().optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  payment: z.object({
    razorpay_order_id: z.string().min(1),
    razorpay_payment_id: z.string().min(1),
  }),
  // tableId: z.string().uuid().optional(), // Table booking disabled
  preorderItems: z.array(z.object({ menuItemId: z.string().uuid(), quantity: z.coerce.number().int().min(1).max(50), note: z.string().trim().max(500).optional() })).min(1, "Select at least one menu item").max(50),
});

router.post(
  "/:id/bookings",
  requireCustomerAuth,
  asyncHandler(async (req, res) => {
    const restaurantId = idParam(req);
    const body = validateBody(bookingSchema, req.body);
    const booking = await createBooking(req.customer!.id, restaurantId, {
      date: body.date,
      time: body.time,
      people: body.people,
      tablePreference: body.tablePreference,
      specialRequest: body.specialRequest,
      fullName: body.fullName,
      mobileNumber: body.mobileNumber,
      email: body.email,
      latitude: body.latitude,
      longitude: body.longitude,
      razorpayOrderId: body.payment.razorpay_order_id,
      razorpayPaymentId: body.payment.razorpay_payment_id,
      // tableId: body.tableId, // Table booking disabled
      preorderItems: body.preorderItems,
    }, req.lang);
    sendSuccess(res, booking, "Order placed", 201);
  }),
);

export default router;
