-- AlterTable
ALTER TABLE "User" ADD COLUMN "expoPushToken" TEXT,
ADD COLUMN "pushNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true;
