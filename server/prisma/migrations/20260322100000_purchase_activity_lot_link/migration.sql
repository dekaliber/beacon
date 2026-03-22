-- Add PURCHASE value to InvestmentActivityType enum
ALTER TYPE "InvestmentActivityType" ADD VALUE 'PURCHASE';

-- Add lotId column to investment_activities (unique nullable FK to investment_lots)
ALTER TABLE "investment_activities" ADD COLUMN "lotId" TEXT;

ALTER TABLE "investment_activities"
  ADD CONSTRAINT "investment_activities_lotId_fkey"
  FOREIGN KEY ("lotId") REFERENCES "investment_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "investment_activities_lotId_key" ON "investment_activities"("lotId");

CREATE INDEX "investment_activities_lotId_idx" ON "investment_activities"("lotId");
