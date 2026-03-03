-- Add parentExpenseId for expense offsets (reimbursements, refunds, etc.)
ALTER TABLE "expenses" ADD COLUMN "parentExpenseId" TEXT;

-- Create index for efficient lookups
CREATE INDEX "expenses_parentExpenseId_idx" ON "expenses"("parentExpenseId");

-- Add foreign key with cascade delete (deleting parent removes offsets)
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_parentExpenseId_fkey"
  FOREIGN KEY ("parentExpenseId") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
