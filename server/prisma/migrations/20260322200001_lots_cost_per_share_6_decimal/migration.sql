-- AlterTable: expand investment_lots.costPerShare from Decimal(12,4) to Decimal(18,6)
ALTER TABLE "investment_lots" ALTER COLUMN "costPerShare" TYPE DECIMAL(18,6);
