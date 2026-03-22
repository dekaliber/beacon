-- Make acquiredDate nullable for managed/robo-advisor holdings
ALTER TABLE "investment_lots" ALTER COLUMN "acquiredDate" DROP NOT NULL;

-- Add assetClass to holdings for grouping
ALTER TABLE "investment_holdings" ADD COLUMN IF NOT EXISTS "assetClass" TEXT;

-- Create realized_gain_snapshots table
CREATE TABLE IF NOT EXISTS "realized_gain_snapshots" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "longTermGain" DECIMAL(12,2),
    "shortTermGain" DECIMAL(12,2),
    "longTermLoss" DECIMAL(12,2),
    "shortTermLoss" DECIMAL(12,2),
    "snapshotDate" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "realized_gain_snapshots_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "realized_gain_snapshots" ADD CONSTRAINT "realized_gain_snapshots_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "realized_gain_snapshots_accountId_year_key"
    ON "realized_gain_snapshots"("accountId", "year");
