-- Create IncomeType enum (rename from IncomeSource if it exists, otherwise create)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IncomeType') THEN
    IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IncomeSource') THEN
      ALTER TYPE "IncomeSource" RENAME TO "IncomeType";
    ELSE
      CREATE TYPE "IncomeType" AS ENUM ('DIVIDENDS', 'INTEREST', 'CAPITAL_GAINS', 'GIFTS', 'OTHER');
    END IF;
  END IF;
END $$;

-- Rename source→type column (only if source exists and type doesn't)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'incomes' AND column_name = 'source'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'incomes' AND column_name = 'type'
  ) THEN
    ALTER TABLE "incomes" RENAME COLUMN "source" TO "type";
  END IF;
END $$;

-- Add freeform source TEXT column (only if it doesn't already exist)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'incomes' AND column_name = 'source'
  ) THEN
    ALTER TABLE "incomes" ADD COLUMN "source" TEXT;
  END IF;
END $$;
