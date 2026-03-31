-- Add settlement cash balance fields to investment accounts
ALTER TABLE "accounts" ADD COLUMN "cashBalance" DECIMAL(12,2);
ALTER TABLE "accounts" ADD COLUMN "cashBalanceUpdatedAt" TIMESTAMP(3);
