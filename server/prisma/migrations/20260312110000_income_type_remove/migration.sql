-- Drop the type column from incomes (now replaced by categoryId)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'incomes' AND column_name = 'type'
  ) THEN
    ALTER TABLE "incomes" DROP COLUMN "type";
  END IF;
END $$;

-- Drop IncomeType enum (no longer used)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IncomeType') THEN
    DROP TYPE "IncomeType";
  END IF;
END $$;
