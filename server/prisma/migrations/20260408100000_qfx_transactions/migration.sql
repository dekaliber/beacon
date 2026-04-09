-- CreateEnum
CREATE TYPE "QfxTransactionType" AS ENUM ('BUY', 'SELL', 'REINVEST');

-- CreateTable
CREATE TABLE "qfx_transactions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "fitId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "type" "QfxTransactionType" NOT NULL,
    "date" DATE NOT NULL,
    "shares" DECIMAL(18,6) NOT NULL,
    "pricePerShare" DECIMAL(18,6) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qfx_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "qfx_transactions_accountId_fitId_key" ON "qfx_transactions"("accountId", "fitId");

-- CreateIndex
CREATE INDEX "qfx_transactions_accountId_idx" ON "qfx_transactions"("accountId");

-- CreateIndex
CREATE INDEX "qfx_transactions_accountId_ticker_idx" ON "qfx_transactions"("accountId", "ticker");

-- AddForeignKey
ALTER TABLE "qfx_transactions" ADD CONSTRAINT "qfx_transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
