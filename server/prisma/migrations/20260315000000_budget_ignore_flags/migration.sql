-- Add ignoreInBudget flag to expenses and categories
ALTER TABLE "expenses" ADD COLUMN "ignoreInBudget" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "categories" ADD COLUMN "ignoreInBudget" BOOLEAN NOT NULL DEFAULT false;
