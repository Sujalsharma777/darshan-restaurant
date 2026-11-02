import type { BookingStatus, NotificationType, Prisma, RestaurantBooking } from "../../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { getActiveRestaurantOrThrow } from "./restaurantService.js";
import { assertArrivalTime } from "./arrivalService.js";
// Table booking flow is disabled for now — bookings are menu orders with an arrival time.
// import { findAvailableTable } from "./tableService.js";
import { calculateMenuTotal } from "./paymentService.js";
import { cancelReminder, scheduleReminder } from "../queues/reminderQueue.js";
import { bookingNotificationMessage, notifyCustomer } from "./notificationService.js";
import { emitToCustomer, emitToRestaurant } from "../socket/server.js";
import { socketEvents } from "../socket/socketEvents.js";
import { policy, decideRefund } from "../config/policy.js";
import { ApiError } from "../utils/http.js";
import { resolveAssetUrl } from "../utils/images.js";
import { businessNow, combineDateAndTime, formatDateOnly, parseDateOnly } from "../utils/dates.js";
import { isValidTime12, to12Hour, to24Hour } from "../utils/slotTime.js";
import { generateHumanBookingId } from "../utils/bookingId.js";
import { haversineDistanceKm } from "../utils/geo.js";
import { DEFAULT_LANGUAGE, type Language } from "../i18n/languages.js";
import { cancellationReasonLabel, statusLabel, type NotificationEvent } from "../i18n/messages.js";
import { BOOKING_SNAPSHOT_FIELDS, pickTranslations, translator } from "../i18n/translations.js";
import { CANCELLATION_REASON_BY_LABEL, CANCELLATION_REASON_LABELS, TABLE_PREFERENCE_BY_LABEL, TABLE_PREFERENCE_LABELS } from "../constants/bookingOptions.js";
import {
  ACTIVE_BOOKING_STATUSES,
  CLOSED_BOOKING_STATUSES,
  CUSTOMER_CANCELLABLE_STATUSES,
  CUSTOMER_MODIFIABLE_STATUSES,
  NEXT_BOOKING_STATUS,
  REJECTABLE_STATUSES,
  RESTAURANT_CANCELLABLE_STATUSES,
  fromClientStatus,
  toClientStatus,
  type BookingClientStatus,
} from "../constants/bookingStatus.js";

export type { BookingClientStatus } from "../constants/bookingStatus.js";

/**
 * Restaurant name, cuisine and item names come from the translations snapshotted when the order
 * was placed (English when missing); status/cancellation labels are fixed copy in `lang`.
 */
export const toBookingResponse = (booking: RestaurantBooking & { table?: any; preorder?: any; review?: { id: string } | null }, lang: Language = DEFAULT_LANGUAGE) => {
  const t = translator(booking.translationsSnapshot, lang);
  return {
    id: booking.id,
    humanBookingId: booking.humanBookingId,
    restaurantId: booking.restaurantId,
    restaurantName: t("name", booking.restaurantNameSnapshot),
    restaurantImage: resolveAssetUrl(booking.restaurantImageSnapshot ?? undefined) ?? null,
    rating: Number(booking.ratingSnapshot),
    cuisineLabel: t("cuisineLabel", booking.cuisineLabelSnapshot),
    distanceKm: booking.distanceKmSnapshot !== null ? Number(booking.distanceKmSnapshot) : null,
    /** Arrival date and time. */
    date: formatDateOnly(booking.date),
    time: to12Hour(booking.time),
    people: booking.people,
    tablePreference: TABLE_PREFERENCE_LABELS[booking.tablePreference],
    specialRequest: booking.specialRequest ?? "",
    fullName: booking.fullName,
    mobileNumber: booking.mobileNumber,
    email: booking.email ?? "",
    status: toClientStatus(booking.status),
    isReviewed: !!booking.review,
    /** Display text for `status` in the requested language. */
    statusLabel: statusLabel(booking.status, lang),
    /** What the customer may still do — lets the app show/hide buttons without duplicating the rules. */
    canCancel: CUSTOMER_CANCELLABLE_STATUSES.includes(booking.status),
    canModify: CUSTOMER_MODIFIABLE_STATUSES.includes(booking.status),
    /** Stable English value (what POST /cancel accepts); use cancellationReasonLabel for display. */
    cancellationReason: booking.cancellationReason ? CANCELLATION_REASON_LABELS[booking.cancellationReason] : null,
    cancellationReasonLabel: booking.cancellationReason ? cancellationReasonLabel(booking.cancellationReason, lang) : null,
    cancelledBy: booking.cancelledBy ? (booking.cancelledBy.toLowerCase() as "customer" | "restaurant") : null,
    rejectionReason: booking.rejectionReason ?? null,
    statusTimestamps: {
      createdAt: booking.createdAt,
      acknowledgedAt: booking.acknowledgedAt ?? null,
      preparingAt: booking.preparingAt ?? null,
      readyAt: booking.readyAt ?? null,
      completedAt: booking.completedAt ?? null,
      cancelledAt: booking.cancelledAt ?? null,
      rejectedAt: booking.rejectedAt ?? null,
    },
    advancePaid: Number(booking.advancePaid),
    table: booking.table ? { id: booking.table.id, name: booking.table.name, capacity: booking.table.capacity, preference: booking.table.preference, section: booking.table.section } : null,
    preorder: booking.preorder ? { id: booking.preorder.id, subtotal: Number(booking.preorder.subtotal), total: Number(booking.preorder.total), items: booking.preorder.items?.map((item: any) => ({ id: item.id, menuItemId: item.menuItemId, name: translator(item.translations, lang)("name", item.itemName), unitPrice: Number(item.unitPrice), quantity: item.quantity, note: item.note, lineTotal: Number(item.lineTotal) })) ?? [] } : null,
    refund:
      booking.status === "CANCELLED" || booking.status === "REJECTED"
        ? { eligible: booking.refundEligible ?? false, amount: booking.refundAmount ? Number(booking.refundAmount) : 0 }
        : undefined,
  };
};

export type CreateBookingInput = {
  /** Optional — orders are same-day only; when sent it must be today's date. */
  date?: string;
  /** Arrival time, "h:mm AM/PM". */
  time: string;
  people: number;
  /** Table booking disabled — optional, defaults to "Any Table". */
  tablePreference?: string;
  specialRequest?: string;
  fullName: string;
  mobileNumber: string;
  email?: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  latitude?: number;
  longitude?: number;
  // tableId?: string; // Table booking disabled
  /** Menu items ordered with this booking — required, and their total is what the customer paid. */
  preorderItems: Array<{ menuItemId: string; quantity: number; note?: string }>;
};

const bookingInclude = { table: true, preorder: { include: { items: true } }, review: { select: { id: true } } } as const;

const preparePreorder = async (client: any, restaurantId: string, items: CreateBookingInput["preorderItems"] = []) => {
  if (!items?.length) return null;
  const uniqueIds = [...new Set(items.map((item) => item.menuItemId))];
  const menuItems: any[] = await client.menuItem.findMany({ where: { id: { in: uniqueIds }, isActive: true, menuCategory: { restaurantId, isActive: true } } });
  if (menuItems.length !== uniqueIds.length) throw new ApiError(422, "One or more pre-order menu items are unavailable.");
  const byId = new Map(menuItems.map((item: any) => [item.id, item]));
  return items.map((item) => {
    const menuItem = byId.get(item.menuItemId)!;
    const unitPrice = Number(menuItem.price);
    return { menuItemId: menuItem.id, itemName: menuItem.name, translations: pickTranslations(menuItem.translations, ["name"]), unitPrice, quantity: item.quantity, note: item.note, lineTotal: Math.round(unitPrice * item.quantity * 100) / 100 };
  });
};

/** Orders are same-day only: an explicitly sent date must be today's (business timezone) date. */
const assertToday = (value: string | undefined) => {
  if (value === undefined) return;
  let date: Date;
  try {
    date = parseDateOnly(value);
  } catch {
    throw new ApiError(422, "Invalid date. Use YYYY-MM-DD format.");
  }
  if (date.getTime() !== businessNow().date.getTime()) throw new ApiError(422, "Orders can only be placed for today.");
};

const assertValidTime = (value: string) => {
  if (!isValidTime12(value)) throw new ApiError(422, 'Invalid time format. Use e.g. "12:00 PM".');
  return to24Hour(value);
};

/** Reminder push before arrival; skipped when that moment has already passed (short-notice orders). */
const scheduleArrivalReminder = async (bookingId: string, date: Date, time24: string) => {
  const reminderAt = new Date(combineDateAndTime(date, time24).getTime() - policy.reminderMinutesBefore * 60_000);
  if (reminderAt.getTime() <= Date.now()) return null;
  return scheduleReminder(bookingId, reminderAt);
};

export const createBooking = async (customerId: string, restaurantId: string, input: CreateBookingInput, lang: Language = DEFAULT_LANGUAGE) => {
  const restaurant = await getActiveRestaurantOrThrow(restaurantId);
  assertToday(input.date);
  const time24 = assertValidTime(input.time);
  // Creating a booking always requires a verified payment, so the arrival time gets a short grace
  // period: a customer who picked a valid time and paid just after it became too soon still gets their order.
  const date = assertArrivalTime(restaurant, time24, { graceMinutes: policy.paidBookingGraceMinutes });

  if (!Number.isInteger(input.people) || input.people < 1 || input.people > restaurant.maxPartySize) {
    throw new ApiError(422, `people must be between 1 and ${restaurant.maxPartySize}.`);
  }

  const tablePreference = TABLE_PREFERENCE_BY_LABEL[input.tablePreference ?? TABLE_PREFERENCE_LABELS.ANY];
  if (!tablePreference) throw new ApiError(422, "Invalid tablePreference.");
  if (!input.preorderItems?.length) throw new ApiError(422, "Select at least one menu item.");

  const payment = await prisma.payment.findUnique({ where: { razorpayOrderId: input.razorpayOrderId } });
  if (!payment || payment.restaurantUserId !== customerId) throw new ApiError(404, "Payment order not found.");
  if (payment.status !== "VERIFIED") throw new ApiError(402, "Payment has not been verified.");
  if (payment.razorpayPaymentId !== input.razorpayPaymentId) throw new ApiError(400, "Payment id mismatch.");

  const alreadyUsed = await prisma.restaurantBooking.findUnique({ where: { paymentId: payment.id } });
  if (alreadyUsed) throw new ApiError(409, "This payment has already been used for a booking.");

  // The payment was created for a specific basket; the booking must carry the same basket total,
  // otherwise a customer could pay for one item and book with more.
  const orderTotal = await calculateMenuTotal(prisma, restaurantId, input.preorderItems);
  if (Math.abs(orderTotal - Number(payment.amount)) > 0.009) {
    throw new ApiError(409, "Selected menu items do not match the paid amount. Please pay again.");
  }

  const distanceKm =
    input.latitude !== undefined && input.longitude !== undefined
      ? haversineDistanceKm({ latitude: input.latitude, longitude: input.longitude }, { latitude: Number(restaurant.latitude), longitude: Number(restaurant.longitude) })
      : null;

  const booking = await prisma.$transaction(async (tx) => {
    const preorderItems = await preparePreorder(tx, restaurantId, input.preorderItems);
    return tx.restaurantBooking.create({
      data: {
        humanBookingId: generateHumanBookingId(restaurant.name),
        restaurantId,
        restaurantUserId: customerId,
        restaurantNameSnapshot: restaurant.name,
        restaurantImageSnapshot: restaurant.banner,
        ratingSnapshot: restaurant.rating,
        cuisineLabelSnapshot: restaurant.cuisineLabel,
        translationsSnapshot: pickTranslations(restaurant.translations, BOOKING_SNAPSHOT_FIELDS),
        distanceKmSnapshot: distanceKm,
        date,
        time: time24,
        people: input.people,
        tablePreference,
        specialRequest: input.specialRequest,
        fullName: input.fullName,
        mobileNumber: input.mobileNumber,
        email: input.email,
        advancePaid: payment.amount,
        paymentId: payment.id,
        // tableId: selection.table?.id, // Table booking disabled
        ...(preorderItems ? { preorder: { create: { subtotal: preorderItems.reduce((sum, item) => sum + item.lineTotal, 0), total: preorderItems.reduce((sum, item) => sum + item.lineTotal, 0), items: { create: preorderItems } } } } : {}),
      },
      include: bookingInclude,
    });
  });

  const reminderJobId = await scheduleArrivalReminder(booking.id, date, time24);
  if (reminderJobId) {
    await prisma.restaurantBooking.update({ where: { id: booking.id }, data: { reminderJobId } });
  }

  await notifyCustomer({
    restaurantUserId: customerId,
    type: "BOOKING_CONFIRMED",
    bookingId: booking.id,
    message: bookingNotificationMessage("placed", booking),
  });
  emitToRestaurant(restaurantId, socketEvents.bookingNew, booking);

  return toBookingResponse(booking, lang);
};

/** "active" = still in progress, "past" = completed, cancelled or rejected. "upcoming" is accepted as an alias of "active". */
export const listMyBookings = async (customerId: string, filter?: "active" | "upcoming" | "past", lang: Language = DEFAULT_LANGUAGE) => {
  const statusFilter = !filter ? {} : { status: { in: filter === "past" ? CLOSED_BOOKING_STATUSES : ACTIVE_BOOKING_STATUSES } };
  const bookings = await prisma.restaurantBooking.findMany({
    where: { restaurantUserId: customerId, ...statusFilter },
    orderBy: [{ date: "desc" }, { time: "desc" }, { createdAt: "desc" }],
    include: bookingInclude,
  });
  return bookings.map((booking) => toBookingResponse(booking, lang));
};

export const getBookingForCustomer = async (customerId: string, id: string, lang: Language = DEFAULT_LANGUAGE) => {
  const booking = await prisma.restaurantBooking.findUnique({ where: { id }, include: bookingInclude });
  if (!booking) throw new ApiError(404, "Booking not found");
  if (booking.restaurantUserId !== customerId) throw new ApiError(403, "You do not have access to this booking");
  return toBookingResponse(booking, lang);
};

export type ModifyBookingInput = { date?: string; time?: string; people?: number };

/** Customers may change arrival time / party size until the restaurant acknowledges the order. */
export const modifyBooking = async (customerId: string, id: string, input: ModifyBookingInput, lang: Language = DEFAULT_LANGUAGE) => {
  const existing = await prisma.restaurantBooking.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "Booking not found");
  if (existing.restaurantUserId !== customerId) throw new ApiError(403, "You do not have access to this booking");
  if (!CUSTOMER_MODIFIABLE_STATUSES.includes(existing.status)) {
    throw new ApiError(409, "This order can no longer be changed because the restaurant has already accepted it.");
  }

  const restaurant = await getActiveRestaurantOrThrow(existing.restaurantId);
  assertToday(input.date);
  const nextTime24 = input.time ? assertValidTime(input.time) : existing.time;
  const nextDate = input.time ? assertArrivalTime(restaurant, nextTime24) : existing.date;

  const nextPeople = input.people ?? existing.people;
  if (!Number.isInteger(nextPeople) || nextPeople < 1 || nextPeople > restaurant.maxPartySize) {
    throw new ApiError(422, `people must be between 1 and ${restaurant.maxPartySize}.`);
  }

  // Guarded on the status so a restaurant acknowledging at the same moment wins cleanly.
  const result = await prisma.restaurantBooking.updateMany({
    where: { id, status: { in: CUSTOMER_MODIFIABLE_STATUSES } },
    data: { date: nextDate, time: nextTime24, people: nextPeople },
  });
  if (result.count === 0) throw new ApiError(409, "This order can no longer be changed because the restaurant has already accepted it.");
  const updated = await prisma.restaurantBooking.findUniqueOrThrow({ where: { id }, include: bookingInclude });

  if (nextTime24 !== existing.time) {
    await cancelReminder(existing.reminderJobId);
    const reminderJobId = await scheduleArrivalReminder(updated.id, nextDate, nextTime24);
    await prisma.restaurantBooking.update({ where: { id: updated.id }, data: { reminderJobId } });
  }

  await notifyCustomer({
    restaurantUserId: customerId,
    type: "BOOKING_MODIFIED",
    bookingId: updated.id,
    message: bookingNotificationMessage("modified", updated),
  });
  emitToRestaurant(existing.restaurantId, socketEvents.bookingModified, updated);

  return toBookingResponse(updated, lang);
};

type StatusChange = {
  from: BookingStatus[];
  to: BookingStatus;
  /** Message when the booking isn't in one of `from`. */
  conflictMessage: (current: BookingStatus) => string;
  data?: Prisma.RestaurantBookingUpdateManyMutationInput;
};

/**
 * Moves a booking to a new status only if it is still in one of the allowed `from` statuses.
 * The check and the write are a single conditional UPDATE, so a customer cancelling while the
 * restaurant starts preparing can never both succeed.
 */
const applyStatusChange = async (existing: RestaurantBooking, change: StatusChange) => {
  if (!change.from.includes(existing.status)) throw new ApiError(409, change.conflictMessage(existing.status));
  const result = await prisma.restaurantBooking.updateMany({
    where: { id: existing.id, status: { in: change.from } },
    data: { status: change.to, ...change.data },
  });
  if (result.count === 0) {
    const latest = await prisma.restaurantBooking.findUnique({ where: { id: existing.id }, select: { status: true } });
    throw new ApiError(409, change.conflictMessage(latest?.status ?? existing.status));
  }
  return prisma.restaurantBooking.findUniqueOrThrow({ where: { id: existing.id }, include: bookingInclude });
};

/** Push + realtime fan-out after any status change. */
const announceStatusChange = async (booking: RestaurantBooking, notification: Pick<Parameters<typeof notifyCustomer>[0], "type" | "message">) => {
  const { lang } = await notifyCustomer({ restaurantUserId: booking.restaurantUserId, bookingId: booking.id, ...notification });
  emitToRestaurant(booking.restaurantId, socketEvents.bookingStatusChanged, booking);
  emitToCustomer(booking.restaurantUserId, socketEvents.customerBookingUpdated, toBookingResponse(booking, lang));
};

export const cancelBooking = async (customerId: string, id: string, reasonLabel: string, lang: Language = DEFAULT_LANGUAGE) => {
  const reason = CANCELLATION_REASON_BY_LABEL[reasonLabel];
  if (!reason) throw new ApiError(422, "Invalid cancellation reason.");

  const existing = await prisma.restaurantBooking.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "Booking not found");
  if (existing.restaurantUserId !== customerId) throw new ApiError(403, "You do not have access to this booking");

  const refund = decideRefund({ advancePaid: Number(existing.advancePaid) });
  const updated = await applyStatusChange(existing, {
    from: CUSTOMER_CANCELLABLE_STATUSES,
    to: "CANCELLED",
    conflictMessage: (current) =>
      current === "CANCELLED" ? "Booking is already cancelled"
        : current === "PREPARING" || current === "READY" ? "Your food is already being prepared, so this order can't be cancelled now."
          : `This order is ${toClientStatus(current)} and can't be cancelled.`,
    data: { cancellationReason: reason, cancelledAt: new Date(), cancelledBy: "CUSTOMER", refundEligible: refund.eligible, refundAmount: refund.amount },
  });

  await cancelReminder(existing.reminderJobId);
  await announceStatusChange(updated, { type: "BOOKING_CANCELLED", message: bookingNotificationMessage("cancelled", updated) });
  emitToRestaurant(existing.restaurantId, socketEvents.bookingCancelled, updated);

  return { booking: toBookingResponse(updated, lang), refund };
};

export type AdminBookingListInput = {
  restaurantId?: string;
  restaurantIds?: string[];
  /** A single status, or "active" for every order still in progress. */
  status?: BookingClientStatus | "active";
  /** Inclusive "YYYY-MM-DD" bounds on the arrival date. */
  from?: string;
  to?: string;
  /** Matches guest name, mobile number or booking ID. */
  search?: string;
  /** By arrival date + time; "asc" puts the soonest bookings first. Defaults to "desc" (latest first). */
  sort?: "asc" | "desc";
  page: number;
  limit: number;
};

/** Filtering, sorting and pagination all run in the database. */
export const listBookingsForAdmin = async (input: AdminBookingListInput) => {
  const parseBound = (value: string) => {
    try {
      return parseDateOnly(value);
    } catch {
      throw new ApiError(422, "Invalid date. Use YYYY-MM-DD format.");
    }
  };
  const search = input.search?.trim();

  const where: Prisma.RestaurantBookingWhereInput = {
    AND: [
      input.restaurantId ? { restaurantId: input.restaurantId } : input.restaurantIds ? { restaurantId: { in: input.restaurantIds } } : {},
      input.status === "active" ? { status: { in: ACTIVE_BOOKING_STATUSES } } : input.status ? { status: fromClientStatus(input.status) } : {},
      input.from || input.to ? { date: { ...(input.from ? { gte: parseBound(input.from) } : {}), ...(input.to ? { lte: parseBound(input.to) } : {}) } } : {},
      search ? { OR: [{ fullName: { contains: search } }, { mobileNumber: { contains: search } }, { humanBookingId: { contains: search } }] } : {},
    ],
  };
  const direction = input.sort ?? "desc";

  const [bookings, total] = await Promise.all([
    prisma.restaurantBooking.findMany({
      where,
      orderBy: [{ date: direction }, { time: direction }, { createdAt: direction }],
      skip: (input.page - 1) * input.limit,
      take: input.limit,
      include: bookingInclude,
    }),
    prisma.restaurantBooking.count({ where }),
  ]);
  return { bookings: bookings.map((booking) => toBookingResponse(booking)), total };
};

export const getBookingForAdmin = async (id: string) => {
  const booking = await prisma.restaurantBooking.findUnique({ where: { id }, include: bookingInclude });
  if (!booking) throw new ApiError(404, "Booking not found");
  return { booking: toBookingResponse(booking), restaurantId: booking.restaurantId };
};

const assertPreorderEditable = async (customerId: string, bookingId: string) => {
  const booking = await prisma.restaurantBooking.findUnique({ where: { id: bookingId }, include: bookingInclude });
  if (!booking) throw new ApiError(404, "Booking not found");
  if (booking.restaurantUserId !== customerId) throw new ApiError(403, "You do not have access to this booking");
  if (!CUSTOMER_MODIFIABLE_STATUSES.includes(booking.status)) throw new ApiError(409, "This order can no longer be changed.");
  return booking;
};

export const getPreorderForCustomer = async (customerId: string, bookingId: string, lang: Language = DEFAULT_LANGUAGE) => {
  const booking = await getBookingForCustomer(customerId, bookingId, lang);
  return booking.preorder ?? { items: [], subtotal: 0, total: 0 };
};

export const replacePreorderForCustomer = async (customerId: string, bookingId: string, items: NonNullable<CreateBookingInput["preorderItems"]>) => {
  const booking = await assertPreorderEditable(customerId, bookingId);
  const rows = await preparePreorder(prisma, booking.restaurantId, items);
  const subtotal = rows?.reduce((sum, item) => sum + item.lineTotal, 0) ?? 0;
  await prisma.$transaction(async (tx) => {
    await tx.bookingPreorder.deleteMany({ where: { bookingId } });
    if (rows?.length) await tx.bookingPreorder.create({ data: { bookingId, subtotal, total: subtotal, items: { create: rows } } });
  });
  return getPreorderForCustomer(customerId, bookingId);
};

export const removePreorderItemForCustomer = async (customerId: string, bookingId: string, itemId: string) => {
  await assertPreorderEditable(customerId, bookingId);
  const item = await prisma.bookingPreorderItem.findFirst({ where: { id: itemId, preorder: { bookingId } } });
  if (!item) throw new ApiError(404, "Pre-order item not found");
  await prisma.$transaction(async (tx) => {
    await tx.bookingPreorderItem.delete({ where: { id: itemId } });
    const remaining = await tx.bookingPreorderItem.aggregate({ where: { preorderId: item.preorderId }, _sum: { lineTotal: true } });
    const total = Number(remaining._sum.lineTotal ?? 0);
    await tx.bookingPreorder.update({ where: { id: item.preorderId }, data: { subtotal: total, total } });
  });
  return getPreorderForCustomer(customerId, bookingId);
};

const loadBooking = async (id: string) => {
  const existing = await prisma.restaurantBooking.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "Booking not found");
  return existing;
};

const ADVANCE_COPY: Record<string, { timestamp: keyof Prisma.RestaurantBookingUpdateManyMutationInput; type: NotificationType; event: NotificationEvent }> = {
  ACKNOWLEDGED: { timestamp: "acknowledgedAt", type: "BOOKING_ACKNOWLEDGED", event: "acknowledged" },
  PREPARING: { timestamp: "preparingAt", type: "BOOKING_PREPARING", event: "preparing" },
  READY: { timestamp: "readyAt", type: "BOOKING_READY", event: "ready" },
  COMPLETED: { timestamp: "completedAt", type: "BOOKING_COMPLETED", event: "completed" },
};

/**
 * Restaurant moves an order one step forward: upcoming → acknowledged → preparing → ready → completed.
 * `to` must be exactly the next step, so a stale admin screen can't skip or repeat a step.
 */
export const advanceBookingStatus = async (id: string, to: BookingStatus) => {
  const existing = await loadBooking(id);
  const copy = ADVANCE_COPY[to];
  const from = (Object.keys(NEXT_BOOKING_STATUS) as BookingStatus[]).filter((status) => NEXT_BOOKING_STATUS[status] === to);
  if (!copy || !from.length) throw new ApiError(422, `Can't move an order to ${toClientStatus(to)} directly.`);

  const updated = await applyStatusChange(existing, {
    from,
    to,
    conflictMessage: (current) => `This order is ${toClientStatus(current)}, so it can't be marked ${toClientStatus(to)}.`,
    data: { [copy.timestamp]: new Date() },
  });

  if (to === "COMPLETED") await cancelReminder(existing.reminderJobId);
  await announceStatusChange(updated, { type: copy.type, message: bookingNotificationMessage(copy.event, updated) });
  return { booking: toBookingResponse(updated), restaurantId: existing.restaurantId };
};

/** Restaurant declines an order it hasn't acknowledged yet. */
export const rejectBooking = async (id: string, reason?: string) => {
  const existing = await loadBooking(id);
  const refund = decideRefund({ advancePaid: Number(existing.advancePaid) });
  const updated = await applyStatusChange(existing, {
    from: REJECTABLE_STATUSES,
    to: "REJECTED",
    conflictMessage: (current) => `Only new orders can be rejected — this one is already ${toClientStatus(current)}. Cancel it instead.`,
    data: { rejectionReason: reason?.trim() || null, rejectedAt: new Date(), refundEligible: refund.eligible, refundAmount: refund.amount },
  });

  await cancelReminder(existing.reminderJobId);
  await announceStatusChange(updated, {
    type: "BOOKING_REJECTED",
    message: bookingNotificationMessage("rejected", updated, { amount: refund.amount, reason: updated.rejectionReason }),
  });
  return { booking: toBookingResponse(updated), refund, restaurantId: existing.restaurantId };
};

/** Restaurant cancels an order at any point before it is completed. */
export const adminCancelBooking = async (id: string, reasonLabel: string) => {
  const reason = CANCELLATION_REASON_BY_LABEL[reasonLabel] ?? "OTHER";
  const existing = await loadBooking(id);
  const refund = decideRefund({ advancePaid: Number(existing.advancePaid) });

  const updated = await applyStatusChange(existing, {
    from: RESTAURANT_CANCELLABLE_STATUSES,
    to: "CANCELLED",
    conflictMessage: (current) => (current === "CANCELLED" ? "Booking is already cancelled" : `This order is already ${toClientStatus(current)} and can't be cancelled.`),
    data: { cancellationReason: reason, cancelledAt: new Date(), cancelledBy: "RESTAURANT", refundEligible: refund.eligible, refundAmount: refund.amount },
  });

  await cancelReminder(existing.reminderJobId);
  await announceStatusChange(updated, {
    type: "BOOKING_CANCELLED",
    message: bookingNotificationMessage("cancelledByRestaurant", updated, { amount: refund.amount }),
  });
  emitToRestaurant(existing.restaurantId, socketEvents.bookingCancelled, updated);

  return { booking: toBookingResponse(updated), refund, restaurantId: existing.restaurantId };
};
