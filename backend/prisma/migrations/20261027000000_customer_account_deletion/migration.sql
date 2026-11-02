-- Darshan account deletion: lock, then anonymise a customer in place.
-- Additive only (three nullable columns and one unique index); no existing row changes.

-- AlterTable
ALTER TABLE `restaurant_users`
    ADD COLUMN `deletion_locked_at` DATETIME(3) NULL,
    ADD COLUMN `anonymised_at` DATETIME(3) NULL,
    ADD COLUMN `deleted_subject_ref` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `restaurant_users_deleted_subject_ref_key` ON `restaurant_users`(`deleted_subject_ref`);
