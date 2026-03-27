-- Add instrumentId to investment_holdings
ALTER TABLE "investment_holdings" ADD COLUMN "instrumentId" TEXT;

-- CreateTable: instruments
CREATE TABLE "instruments" (
    "id" TEXT NOT NULL,
    "primaryTicker" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instruments_pkey" PRIMARY KEY ("id")
);

-- CreateTable: instrument_tickers
CREATE TABLE "instrument_tickers" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instrument_tickers_pkey" PRIMARY KEY ("id")
);

-- CreateTable: asset_classes
CREATE TABLE "asset_classes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "parentId" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable: asset_class_targets
CREATE TABLE "asset_class_targets" (
    "id" TEXT NOT NULL,
    "assetClassId" TEXT NOT NULL,
    "targetPct" DECIMAL(5,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_class_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable: instrument_asset_class_weights
CREATE TABLE "instrument_asset_class_weights" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "assetClassId" TEXT NOT NULL,
    "weight" DECIMAL(5,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instrument_asset_class_weights_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX "instruments_primaryTicker_key" ON "instruments"("primaryTicker");
CREATE UNIQUE INDEX "instrument_tickers_ticker_key" ON "instrument_tickers"("ticker");
CREATE UNIQUE INDEX "asset_classes_slug_key" ON "asset_classes"("slug");
CREATE UNIQUE INDEX "asset_class_targets_assetClassId_key" ON "asset_class_targets"("assetClassId");
CREATE UNIQUE INDEX "instrument_asset_class_weights_instrumentId_assetClassId_key" ON "instrument_asset_class_weights"("instrumentId", "assetClassId");

-- Foreign keys
ALTER TABLE "investment_holdings" ADD CONSTRAINT "investment_holdings_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instruments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "instrument_tickers" ADD CONSTRAINT "instrument_tickers_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "asset_classes" ADD CONSTRAINT "asset_classes_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "asset_classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_class_targets" ADD CONSTRAINT "asset_class_targets_assetClassId_fkey" FOREIGN KEY ("assetClassId") REFERENCES "asset_classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "instrument_asset_class_weights" ADD CONSTRAINT "instrument_asset_class_weights_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "instrument_asset_class_weights" ADD CONSTRAINT "instrument_asset_class_weights_assetClassId_fkey" FOREIGN KEY ("assetClassId") REFERENCES "asset_classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
