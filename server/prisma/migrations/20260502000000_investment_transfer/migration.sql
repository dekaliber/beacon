-- AlterEnum
ALTER TYPE "InvestmentActivityType" ADD VALUE 'TRANSFER';

-- AlterTable
ALTER TABLE "investment_activities" ADD COLUMN "transferAccountId" TEXT;
