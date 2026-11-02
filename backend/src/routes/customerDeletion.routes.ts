import { Router } from "express";
import { z } from "zod";
import { verifyServiceToken } from "../lib/centralAuth.js";
import { requireRestaurantAppKey } from "../middleware/auth.js";
import {
  anonymiseCustomer,
  evaluateCustomerDeletion,
  findCustomerForDeletion,
  revokeCustomerSessions,
} from "../services/customerDeletionService.js";
import { asyncHandler, sendSuccess, validateBody } from "../utils/http.js";

/**
 * Day 30 of a Darshan account deletion, called only by Darshan Admin. Two credentials,
 * as for /auth: the app key (who is calling) and a signed service assertion with
 * purpose `account_deletion` whose claims name the customer (`restaurant_user_id`,
 * `central_user_id`). Nothing else in the body is read.
 *
 * OpenAPI docs: src/docs/customerDeletion.docs.ts
 */
const router = Router();

const bodySchema = z.object({ service_token: z.string().min(1, "service_token is required") });

const customerFrom = async (body: unknown) => {
  const { service_token } = validateBody(bodySchema, body);
  return findCustomerForDeletion(await verifyServiceToken(service_token, "account_deletion"));
};

// Day 0: the customer's sessions, revoked when the deletion is requested. The
// customer-facing /api/auth/logout sits behind the admin frontend's client key, which
// Darshan does not (and should not) hold.
router.post(
  "/revoke-sessions",
  requireRestaurantAppKey,
  asyncHandler(async (req, res) => {
    sendSuccess(res, await revokeCustomerSessions(await customerFrom(req.body)), "Sessions revoked");
  }),
);

router.post(
  "/evaluate",
  requireRestaurantAppKey,
  asyncHandler(async (req, res) => {
    sendSuccess(res, await evaluateCustomerDeletion(await customerFrom(req.body)));
  }),
);

router.post(
  "/anonymise",
  requireRestaurantAppKey,
  asyncHandler(async (req, res) => {
    const result = await anonymiseCustomer(await customerFrom(req.body));

    if (result.outcome === "blocked") {
      res.status(409).json({ status: false, message: "Outstanding bookings", data: result });
      return;
    }

    sendSuccess(res, result, "Customer anonymised");
  }),
);

export default router;
