-- AlterTable
ALTER TABLE "expenses" ADD COLUMN "vendor" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "recurrence_rules" ADD COLUMN "vendor" TEXT NOT NULL DEFAULT '';
