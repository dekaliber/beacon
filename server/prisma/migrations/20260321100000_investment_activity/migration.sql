-- Migration: investment_activity
-- Adds InvestmentActivity model (event log for sales and dividends on holdings)
-- and extends Income with subtype, taxableAmount, and activityId fields.

-- Step 1: Create IncomeSubtype enum
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IncomeSubtype') THEN
    CREATE TYPE "IncomeSubtype" AS ENUM ('REGULAR', 'DIVIDEND', 'CAPITAL_GAIN');
  END IF;
END $$;

-- Step 2: Create InvestmentActivityType enum
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InvestmentActivityType') THEN
    CREATE TYPE "InvestmentActivityType" AS ENUM ('DIVIDEND', 'SALE');
  END IF;
END $$;

-- Step 3: Create investment_activities table
CREATE TABLE IF NOT EXISTS "investment_activities" (
    "id"            TEXT NOT NULL,
    "accountId"     TEXT NOT NULL,
    "holdingId"     TEXT,
    "ticker"        TEXT NOT NULL,
    "type"          "InvestmentActivityType" NOT NULL,
    "date"          TIMESTAMP(3) NOT NULL,
    "shares"        DECIMAL(18,6),
    "pricePerShare" DECIMAL(12,4),
    "amount"        DECIMAL(12,2) NOT NULL,
    "fees"          DECIMAL(12,2),
    "costBasis"     DECIMAL(12,2),
    "shortTermGain" DECIMAL(12,2),
    "longTermGain"  DECIMAL(12,2),
    "notes"         TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "investment_activities_pkey" PRIMARY KEY ("id")
);

-- Step 4: FK investment_activities.accountId → accounts.id
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'investment_activities_accountId_fkey'
  ) THEN
    ALTER TABLE "investment_activities"
      ADD CONSTRAINT "investment_activities_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- Step 5: FK investment_activities.holdingId → investment_holdings.id (SET NULL on delete)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'investment_activities_holdingId_fkey'
  ) THEN
    ALTER TABLE "investment_activities"
      ADD CONSTRAINT "investment_activities_holdingId_fkey"
      FOREIGN KEY ("holdingId") REFERENCES "investment_holdings"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Step 6: Indexes on investment_activities
CREATE INDEX IF NOT EXISTS "investment_activities_accountId_idx" ON "investment_activities"("accountId");
CREATE INDEX IF NOT EXISTS "investment_activities_date_idx"      ON "investment_activities"("date");
CREATE INDEX IF NOT EXISTS "investment_activities_holdingId_idx" ON "investment_activities"("holdingId");

-- Step 7: Add subtype column to incomes (IncomeSubtype, NOT NULL, default REGULAR)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'incomes' AND column_name = 'subtype'
  ) THEN
    ALTER TABLE "incomes" ADD COLUMN "subtype" "IncomeSubtype" NOT NULL DEFAULT 'REGULAR';
  END IF;
END $$;

-- Step 8: Add taxableAmount column to incomes (nullable Decimal)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'incomes' AND column_name = 'taxableAmount'
  ) THEN
    ALTER TABLE "incomes" ADD COLUMN "taxableAmount" DECIMAL(12,2);
  END IF;
END $$;

-- Step 9: Add activityId column to incomes (nullable FK)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'incomes' AND column_name = 'activityId'
  ) THEN
    ALTER TABLE "incomes" ADD COLUMN "activityId" TEXT;
  END IF;
END $$;

-- Step 10: FK incomes.activityId → investment_activities.id (SET NULL on delete)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'incomes_activityId_fkey'
  ) THEN
    ALTER TABLE "incomes"
      ADD CONSTRAINT "incomes_activityId_fkey"
      FOREIGN KEY ("activityId") REFERENCES "investment_activities"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Step 11: Index on incomes.activityId
CREATE INDEX IF NOT EXISTS "incomes_activityId_idx" ON "incomes"("activityId");
