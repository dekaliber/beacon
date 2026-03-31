CREATE TYPE "TaxAdvantageType" AS ENUM ('TRADITIONAL', 'ROTH', 'HSA', 'PLAN_529');

ALTER TABLE "accounts" ADD COLUMN "taxAdvantageType" "TaxAdvantageType";
