-- Move dividend scan state from InvestmentHolding to Instrument.
-- Scan timing is now tracked per unique ticker (instrument) rather than per
-- holding, so each ticker is scanned once regardless of how many accounts hold it.

ALTER TABLE "instruments"
  ADD COLUMN "lastDividendScanAt"    TIMESTAMP(3),
  ADD COLUMN "lastDividendAttemptAt" TIMESTAMP(3);

ALTER TABLE "investment_holdings"
  DROP COLUMN "lastDividendScanAt",
  DROP COLUMN "lastDividendAttemptAt";
