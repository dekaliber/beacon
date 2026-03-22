-- AlterTable: expand pricePerShare from Decimal(12,4) to Decimal(18,6)
ALTER TABLE "investment_activities" ALTER COLUMN "pricePerShare" TYPE DECIMAL(18,6);
