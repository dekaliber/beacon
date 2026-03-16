-- Convert any existing CASH accounts to CHECKING before removing the enum value
UPDATE "accounts" SET "type" = 'CHECKING' WHERE "type" = 'CASH';

-- Create new enum without CASH
CREATE TYPE "AccountType_new" AS ENUM ('CHECKING', 'SAVINGS', 'CREDIT_CARD', 'INVESTMENT');

-- Migrate column to new enum
ALTER TABLE "accounts" ALTER COLUMN "type" TYPE "AccountType_new" USING "type"::text::"AccountType_new";

-- Swap enum names
DROP TYPE "AccountType";
ALTER TYPE "AccountType_new" RENAME TO "AccountType";
