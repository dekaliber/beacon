-- Drop required constraint on name (make nullable)
ALTER TABLE "transaction_groups" ALTER COLUMN "name" DROP NOT NULL;

-- Add primaryExpenseId FK to expenses
ALTER TABLE "transaction_groups" ADD COLUMN "primaryExpenseId" TEXT;
ALTER TABLE "transaction_groups"
  ADD CONSTRAINT "transaction_groups_primaryExpenseId_fkey"
  FOREIGN KEY ("primaryExpenseId") REFERENCES "expenses"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
