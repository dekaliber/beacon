-- Backfill PURCHASE activities for all existing lots that have an acquiredDate.
-- Must run in a separate migration from the ALTER TYPE ADD VALUE above, because
-- PostgreSQL requires the new enum value to be committed before it can be used
-- in INSERT/UPDATE statements.
INSERT INTO "investment_activities" (
  "id",
  "accountId",
  "holdingId",
  "lotId",
  "ticker",
  "type",
  "date",
  "shares",
  "pricePerShare",
  "amount",
  "createdAt",
  "updatedAt"
)
SELECT
  replace(gen_random_uuid()::text, '-', ''),
  h."accountId",
  l."holdingId",
  l."id",
  h."ticker",
  'PURCHASE'::"InvestmentActivityType",
  l."acquiredDate",
  l."quantity",
  l."costPerShare",
  ROUND(l."quantity" * l."costPerShare", 2),
  now(),
  now()
FROM "investment_lots" l
JOIN "investment_holdings" h ON h."id" = l."holdingId"
WHERE l."acquiredDate" IS NOT NULL
  -- Skip lots that already have a PURCHASE activity (idempotent re-run safety)
  AND NOT EXISTS (
    SELECT 1 FROM "investment_activities" a
    WHERE a."lotId" = l."id" AND a."type" = 'PURCHASE'
  );
