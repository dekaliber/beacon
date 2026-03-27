-- Add isCashReceived to incomes
ALTER TABLE "incomes" ADD COLUMN "isCashReceived" BOOLEAN NOT NULL DEFAULT true;
