import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../utils/http.js";
import { haversineDistanceKm } from "../utils/geo.js";
import { resolveAssetUrl } from "../utils/images.js";
import { pagination } from "../utils/query.js";
import { to12Hour } from "../utils/slotTime.js";
import { DEFAULT_LANGUAGE, type Language } from "../i18n/languages.js";
import { translator } from "../i18n/translations.js";

const restaurantInclude = {
  categories: { include: { category: true } },
} satisfies Prisma.RestaurantInclude;

type RestaurantWithCategories = Prisma.RestaurantGetPayload<{ include: typeof restaurantInclude }>;

const toPublicRestaurant = (restaurant: RestaurantWithCategories, lang: Language, userLocation?: { latitude: number; longitude: number }, isWishlisted = false) => {
  const t = translator(restaurant.translations, lang);
  return {
    id: restaurant.id,
    name: t("name", restaurant.name),
    banner: resolveAssetUrl(restaurant.banner ?? undefined) ?? null,
    gallery: ((restaurant.gallery as string[] | null) ?? []).map((url) => resolveAssetUrl(url)),
    categories: restaurant.categories.map((link) => link.category.key),
    cuisineLabel: t("cuisineLabel", restaurant.cuisineLabel),
    isPureVeg: restaurant.isPureVeg,
    rating: Number(restaurant.rating),
    ratingCount: restaurant.ratingCount,
    isWishlisted,
    prepTimeMin: restaurant.prepTimeMin,
    prepTimeMax: restaurant.prepTimeMax,
    opensAt: to12Hour(restaurant.opensAt),
    closesAt: to12Hour(restaurant.closesAt),
    priceForTwo: restaurant.priceForTwo,
    offerText: t("offerText", restaurant.offerText),
    offerSubText: t("offerSubText", restaurant.offerSubText),
    about: t("about", restaurant.about),
    address: {
      line: t("addressLine", restaurant.addressLine),
      city: t("city", restaurant.city),
      state: t("state", restaurant.state),
      country: restaurant.country,
      pincode: restaurant.pincode,
    },
    phone: restaurant.phone,
    latitude: Number(restaurant.latitude),
    longitude: Number(restaurant.longitude),
    maxPartySize: restaurant.maxPartySize,
    distanceKm:
      userLocation && Number.isFinite(userLocation.latitude) && Number.isFinite(userLocation.longitude)
        ? haversineDistanceKm(userLocation, { latitude: Number(restaurant.latitude), longitude: Number(restaurant.longitude) })
        : null,
  };
};

export type ListRestaurantsInput = {
  city?: string;
  category?: string;
  q?: string;
  latitude?: number;
  longitude?: number;
  page: number;
  limit: number;
  lang?: Language;
  customerId?: string;
  restaurantIds?: string[];
};

export const listRestaurants = async (input: ListRestaurantsInput) => {
  const where: Prisma.RestaurantWhereInput = {
    status: "ACTIVE",
    ...(input.restaurantIds ? { id: { in: input.restaurantIds } } : {}),
    ...(input.city ? { city: { equals: input.city } } : {}),
    ...(input.category ? { categories: { some: { category: { key: input.category } } } } : {}),
    ...(input.q
      ? {
          OR: [
            { name: { contains: input.q } },
            { cuisineLabel: { contains: input.q } },
            // Customers searching in their own language should find translated names too.
            ...(input.lang && input.lang !== DEFAULT_LANGUAGE
              ? [
                  { translations: { path: `$.${input.lang}.name`, string_contains: input.q } },
                  { translations: { path: `$.${input.lang}.cuisineLabel`, string_contains: input.q } },
                ]
              : []),
          ],
        }
      : {}),
  };

  const [restaurants, total] = await Promise.all([
    prisma.restaurant.findMany({
      where,
      include: restaurantInclude,
      orderBy: { createdAt: "desc" },
      skip: (input.page - 1) * input.limit,
      take: input.limit,
    }),
    prisma.restaurant.count({ where }),
  ]);

  const userLocation =
    input.latitude !== undefined && input.longitude !== undefined ? { latitude: input.latitude, longitude: input.longitude } : undefined;

  const wishlistedIds = input.customerId ? new Set((await prisma.restaurantWishlist.findMany({ where: { restaurantUserId: input.customerId, restaurantId: { in: restaurants.map((r) => r.id) } }, select: { restaurantId: true } })).map((row) => row.restaurantId)) : new Set<string>();
  return {
    restaurants: restaurants.map((restaurant) => toPublicRestaurant(restaurant, input.lang ?? DEFAULT_LANGUAGE, userLocation, wishlistedIds.has(restaurant.id))),
    pagination: pagination(input.page, input.limit, total),
  };
};

export const getRestaurantDetail = async (id: string, userLocation?: { latitude: number; longitude: number }, lang: Language = DEFAULT_LANGUAGE, customerId?: string) => {
  const restaurant = await prisma.restaurant.findUnique({ where: { id }, include: restaurantInclude });
  if (!restaurant || restaurant.status !== "ACTIVE") throw new ApiError(404, "Restaurant not found");
  const wishlistEntry = customerId ? await prisma.restaurantWishlist.findUnique({ where: { restaurantUserId_restaurantId: { restaurantUserId: customerId, restaurantId: id } } }) : null;
  return toPublicRestaurant(restaurant, lang, userLocation, !!wishlistEntry);
};

/** Internal helper for services that need the raw record (booking, admin, arrival window). */
export const getActiveRestaurantOrThrow = async (id: string) => {
  const restaurant = await prisma.restaurant.findUnique({ where: { id } });
  if (!restaurant || restaurant.status !== "ACTIVE") throw new ApiError(404, "Restaurant not found");
  return restaurant;
};

/** Active restaurant categories ("Pure Veg", ...) with labels in the requested language. */
export const listRestaurantCategories = async (lang: Language = DEFAULT_LANGUAGE) => {
  const categories = await prisma.restaurantCategory.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } });
  return categories.map((category) => ({ key: category.key, label: translator(category.translations, lang)("label", category.label) }));
};
