-- Add inclusive gender option and optional LGBTQ+ self-identification text.
ALTER TYPE "Gender" ADD VALUE IF NOT EXISTS 'OTHER';

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "genderIdentity" TEXT;
