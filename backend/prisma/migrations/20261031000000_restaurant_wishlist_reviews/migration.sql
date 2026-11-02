CREATE TABLE `restaurant_wishlists` (
  `id` VARCHAR(191) NOT NULL,
  `restaurant_user_id` VARCHAR(191) NOT NULL,
  `restaurant_id` VARCHAR(191) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `restaurant_wishlists_restaurant_user_id_restaurant_id_key` (`restaurant_user_id`, `restaurant_id`),
  INDEX `restaurant_wishlists_restaurant_id_idx` (`restaurant_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `restaurant_reviews` (
  `id` VARCHAR(191) NOT NULL,
  `restaurant_user_id` VARCHAR(191) NOT NULL,
  `restaurant_id` VARCHAR(191) NOT NULL,
  `booking_id` VARCHAR(191) NOT NULL,
  `rating` INTEGER NOT NULL,
  `comment` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `restaurant_reviews_booking_id_key` (`booking_id`),
  INDEX `restaurant_reviews_restaurant_id_created_at_idx` (`restaurant_id`, `created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `restaurant_wishlists` ADD CONSTRAINT `restaurant_wishlists_restaurant_user_id_fkey` FOREIGN KEY (`restaurant_user_id`) REFERENCES `restaurant_users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `restaurant_wishlists` ADD CONSTRAINT `restaurant_wishlists_restaurant_id_fkey` FOREIGN KEY (`restaurant_id`) REFERENCES `restaurants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `restaurant_reviews` ADD CONSTRAINT `restaurant_reviews_restaurant_user_id_fkey` FOREIGN KEY (`restaurant_user_id`) REFERENCES `restaurant_users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `restaurant_reviews` ADD CONSTRAINT `restaurant_reviews_restaurant_id_fkey` FOREIGN KEY (`restaurant_id`) REFERENCES `restaurants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `restaurant_reviews` ADD CONSTRAINT `restaurant_reviews_booking_id_fkey` FOREIGN KEY (`booking_id`) REFERENCES `restaurant_bookings`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
