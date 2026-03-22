-- CreateTable
CREATE TABLE "ticker_price_history" (
    "id" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "closePrice" DECIMAL(12,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticker_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ticker_price_history_ticker_date_key" ON "ticker_price_history"("ticker", "date");

-- CreateIndex
CREATE INDEX "ticker_price_history_ticker_idx" ON "ticker_price_history"("ticker");
