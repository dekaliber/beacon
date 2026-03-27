ALTER TABLE "instruments" ADD COLUMN "is_manual" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "manual_investments" ADD COLUMN "instrument_id" TEXT;
ALTER TABLE "manual_investments" ADD CONSTRAINT "manual_investments_instrument_id_fkey"
  FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
