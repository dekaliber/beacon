-- Rename DividendType enum to TaxClassification
ALTER TYPE "DividendType" RENAME TO "TaxClassification";

-- Rename dividendType column to taxClassification
ALTER TABLE "incomes" RENAME COLUMN "dividendType" TO "taxClassification";
