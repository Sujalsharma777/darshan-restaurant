/**
 * @openapi
 * /api/restaurant-wishlist:
 *   get:
 *     tags: ["User: Engagement"]
 *     summary: Get the signed-in customer's wishlisted restaurants
 *     security:
 *       - ClientKey: []
 *         CustomerBearer: []
 *     responses:
 *       200:
 *         description: Wishlist using the standard restaurant card format
 *         content:
 *           application/json:
 *             schema: { $ref: "#/components/schemas/SuccessEnvelope" }
 *       401:
 *         $ref: "#/components/responses/Unauthorized"
 *   post:
 *     tags: ["User: Engagement"]
 *     summary: Add a restaurant to the signed-in customer's wishlist (idempotent)
 *     security:
 *       - ClientKey: []
 *         CustomerBearer: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [restaurantId]
 *             properties:
 *               restaurantId: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Restaurant added or already present
 *       404:
 *         $ref: "#/components/responses/NotFound"
 *       401:
 *         $ref: "#/components/responses/Unauthorized"
 * /api/restaurant-wishlist/{restaurantId}:
 *   delete:
 *     tags: ["User: Engagement"]
 *     summary: Remove a restaurant from the signed-in customer's wishlist
 *     security:
 *       - ClientKey: []
 *         CustomerBearer: []
 *     parameters:
 *       - in: path
 *         name: restaurantId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Restaurant removed; safe to call if it was already absent
 *       401:
 *         $ref: "#/components/responses/Unauthorized"
 * /api/restaurant-reviews:
 *   post:
 *     tags: ["User: Engagement"]
 *     summary: Review a completed booking
 *     description: One review is allowed per booking. The booking must belong to the signed-in customer, match the restaurant, and have completed status.
 *     security:
 *       - ClientKey: []
 *         CustomerBearer: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [restaurantId, bookingId, rating]
 *             properties:
 *               restaurantId: { type: string, format: uuid }
 *               bookingId: { type: string, format: uuid }
 *               rating: { type: integer, minimum: 1, maximum: 5 }
 *               comment: { type: string, maxLength: 5000, default: "" }
 *     responses:
 *       201:
 *         description: Review submitted
 *       400:
 *         description: Booking is not completed or does not match the restaurant
 *       409:
 *         description: Booking has already been reviewed
 *         content:
 *           application/json:
 *             example: { status: false, code: ALREADY_REVIEWED, message: "You have already reviewed this visit." }
 *       401:
 *         $ref: "#/components/responses/Unauthorized"
 * /api/restaurants/{id}/reviews:
 *   get:
 *     tags: ["User: Engagement"]
 *     summary: List a restaurant's reviews
 *     security:
 *       - ClientKey: []
 *         CustomerBearer: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated reviews
 *         content:
 *           application/json:
 *             schema: { $ref: "#/components/schemas/SuccessEnvelope" }
 *       401:
 *         $ref: "#/components/responses/Unauthorized"
 */
export {};
