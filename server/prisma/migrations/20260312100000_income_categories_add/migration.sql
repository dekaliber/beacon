-- Step 1: Create CategoryKind enum
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CategoryKind') THEN
    CREATE TYPE "CategoryKind" AS ENUM ('EXPENSE', 'INCOME');
  END IF;
END $$;

-- Step 2: Add kind column to categories (default EXPENSE for all existing rows)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'categories' AND column_name = 'kind'
  ) THEN
    ALTER TABLE "categories" ADD COLUMN "kind" "CategoryKind" NOT NULL DEFAULT 'EXPENSE';
  END IF;
END $$;

-- Step 3: Add categoryId column to incomes
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'incomes' AND column_name = 'categoryId'
  ) THEN
    ALTER TABLE "incomes" ADD COLUMN "categoryId" TEXT;
  END IF;
END $$;

-- Step 4: Seed the five income categories (idempotent)
INSERT INTO "categories" ("id", "name", "kind", "isDefault", "parentId", "createdAt", "updatedAt")
VALUES
  ('income_cat_dividends', 'Dividends',     'INCOME', false, NULL, NOW(), NOW()),
  ('income_cat_interest',  'Interest',      'INCOME', false, NULL, NOW(), NOW()),
  ('income_cat_capgains',  'Capital Gains', 'INCOME', false, NULL, NOW(), NOW()),
  ('income_cat_gifts',     'Gifts',         'INCOME', false, NULL, NOW(), NOW()),
  ('income_cat_other',     'Other',         'INCOME', false, NULL, NOW(), NOW())
ON CONFLICT ("id") DO NOTHING;

-- Step 5: Migrate existing income records to reference the new categories
UPDATE "incomes" SET "categoryId" = 'income_cat_dividends' WHERE "type" = 'DIVIDENDS'     AND "categoryId" IS NULL;
UPDATE "incomes" SET "categoryId" = 'income_cat_interest'  WHERE "type" = 'INTEREST'      AND "categoryId" IS NULL;
UPDATE "incomes" SET "categoryId" = 'income_cat_capgains'  WHERE "type" = 'CAPITAL_GAINS' AND "categoryId" IS NULL;
UPDATE "incomes" SET "categoryId" = 'income_cat_gifts'     WHERE "type" = 'GIFTS'         AND "categoryId" IS NULL;
UPDATE "incomes" SET "categoryId" = 'income_cat_other'     WHERE "type" = 'OTHER'         AND "categoryId" IS NULL;

-- Step 6: Add FK constraint (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'incomes_categoryId_fkey'
  ) THEN
    ALTER TABLE "incomes"
      ADD CONSTRAINT "incomes_categoryId_fkey"
      FOREIGN KEY ("categoryId") REFERENCES "categories"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Step 7: Add index
CREATE INDEX IF NOT EXISTS "incomes_categoryId_idx" ON "incomes"("categoryId");
