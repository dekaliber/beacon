-- Add lastDividendAttemptAt to investment_holdings to track every scan attempt
-- (success or failure). Used to enforce a 1-hour retry backoff so rate-limited
-- holdings are not retried on every app load within the same session.
ALTER TABLE "investment_holdings" ADD COLUMN "lastDividendAttemptAt" TIMESTAMP(3);
