-- Add priceSource to ticker_prices to track which API sourced each price
ALTER TABLE "ticker_prices" ADD COLUMN "priceSource" TEXT NOT NULL DEFAULT 'YAHOO';
