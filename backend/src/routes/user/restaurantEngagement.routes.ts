import { Router } from "express";
import { z } from "zod";
import { requireCustomerAuth } from "../../middleware/auth.js";
import { prisma } from "../../lib/prisma.js";
import { ApiError, asyncHandler, idParam, sendSuccess, validateBody, validateQuery } from "../../utils/http.js";
import { listRestaurants } from "../../services/restaurantService.js";

const router = Router();

router.post("/restaurant-wishlist", requireCustomerAuth, asyncHandler(async (req, res) => {
  const { restaurantId } = validateBody(z.object({ restaurantId: z.string().min(1) }), req.body);
  const restaurant = await prisma.restaurant.findFirst({ where: { id: restaurantId, status: "ACTIVE" }, select: { id: true } });
  if (!restaurant) throw new ApiError(404, "Restaurant not found");
  await prisma.restaurantWishlist.upsert({ where: { restaurantUserId_restaurantId: { restaurantUserId: req.customer!.id, restaurantId } }, create: { restaurantUserId: req.customer!.id, restaurantId }, update: {} });
  sendSuccess(res, { restaurantId, isWishlisted: true }, "Added to wishlist");
}));

router.delete("/restaurant-wishlist/:restaurantId", requireCustomerAuth, asyncHandler(async (req, res) => {
  const restaurantId = idParam(req, "restaurantId");
  await prisma.restaurantWishlist.deleteMany({ where: { restaurantUserId: req.customer!.id, restaurantId } });
  sendSuccess(res, { restaurantId, isWishlisted: false }, "Removed from wishlist");
}));

router.get("/restaurant-wishlist", requireCustomerAuth, asyncHandler(async (req, res) => {
  const entries = await prisma.restaurantWishlist.findMany({ where: { restaurantUserId: req.customer!.id, restaurant: { status: "ACTIVE" } }, select: { restaurantId: true }, orderBy: { createdAt: "desc" } });
  const ids = entries.map((entry) => entry.restaurantId);
  if (!ids.length) return sendSuccess(res, { restaurants: [], pagination: { page: 1, limit: 100, total: 0, totalPages: 0 } });
  const batches = await Promise.all(Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) => listRestaurants({ page: 1, limit: 100, restaurantIds: ids.slice(index * 100, (index + 1) * 100), customerId: req.customer!.id, lang: req.lang })));
  const byId = new Map(batches.flatMap((batch) => batch.restaurants).map((restaurant) => [restaurant.id, restaurant]));
  sendSuccess(res, { restaurants: ids.flatMap((id) => byId.has(id) ? [byId.get(id)] : []), pagination: { page: 1, limit: ids.length, total: ids.length, totalPages: 1 } });
}));

router.post("/restaurant-reviews", requireCustomerAuth, asyncHandler(async (req, res) => {
  const body = validateBody(z.object({ restaurantId: z.string().min(1), bookingId: z.string().min(1), rating: z.coerce.number().int().min(1).max(5), comment: z.string().trim().max(5000).optional().default("") }), req.body);
  const booking = await prisma.restaurantBooking.findUnique({ where: { id: body.bookingId } });
  if (!booking || booking.restaurantUserId !== req.customer!.id) throw new ApiError(404, "Completed booking not found");
  if (booking.restaurantId !== body.restaurantId) throw new ApiError(400, "Booking does not belong to this restaurant");
  if (booking.status !== "COMPLETED") throw new ApiError(400, "You can review this visit after it is completed.");
  try {
    const review = await prisma.$transaction(async (tx) => {
      const created = await tx.restaurantReview.create({ data: { restaurantUserId: req.customer!.id, restaurantId: body.restaurantId, bookingId: body.bookingId, rating: body.rating, comment: body.comment }, include: { restaurantUser: { select: { name: true } } } });
      const restaurant = await tx.restaurant.findUniqueOrThrow({ where: { id: body.restaurantId }, select: { rating: true, ratingCount: true } });
      const ratingCount = restaurant.ratingCount + 1;
      const rating = (Number(restaurant.rating) * restaurant.ratingCount + body.rating) / ratingCount;
      await tx.restaurant.update({ where: { id: body.restaurantId }, data: { rating: Math.round(rating * 10) / 10, ratingCount } });
      return created;
    });
    sendSuccess(res, { reviewId: review.id, userName: review.restaurantUser.name, rating: review.rating, comment: review.comment, createdAt: review.createdAt }, "Review submitted", 201);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") return res.status(409).json({ status: false, code: "ALREADY_REVIEWED", message: "You have already reviewed this visit." });
    throw error;
  }
}));

router.get("/restaurants/:id/reviews", requireCustomerAuth, asyncHandler(async (req, res) => {
  const restaurantId = idParam(req);
  const query = validateQuery(z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }), req.query);
  const where = { restaurantId };
  const [reviews, total] = await Promise.all([
    prisma.restaurantReview.findMany({ where, include: { restaurantUser: { select: { name: true } } }, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.limit, take: query.limit }),
    prisma.restaurantReview.count({ where }),
  ]);
  sendSuccess(res, { reviews: reviews.map((review) => ({ reviewId: review.id, userName: review.restaurantUser.name, rating: review.rating, comment: review.comment, createdAt: review.createdAt })), pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } });
}));

export default router;
