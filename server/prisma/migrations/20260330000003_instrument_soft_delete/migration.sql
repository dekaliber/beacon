-- Soft-delete support for instruments: inactive instruments are hidden on the
-- Securities page but retain their asset class weights so they can be restored
-- automatically if the ticker is added back to any investment account.
ALTER TABLE "instruments" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
