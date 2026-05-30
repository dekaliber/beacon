-- CreateEnum
CREATE TYPE "PendingSaleStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DISMISSED');

-- CreateTable
CREATE TABLE "pending_sales" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "optionsPositionId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "status" "PendingSaleStatus" NOT NULL DEFAULT 'PENDING',
    "quantity" DECIMAL(18,8) NOT NULL,
    "pricePerShare" DECIMAL(18,8) NOT NULL,
    "saleDate" DATE NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "activityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_sales_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pending_sales_optionsPositionId_key" ON "pending_sales"("optionsPositionId");

-- CreateIndex
CREATE UNIQUE INDEX "pending_sales_activityId_key" ON "pending_sales"("activityId");

-- CreateIndex
CREATE INDEX "pending_sales_accountId_status_idx" ON "pending_sales"("accountId", "status");

-- AddForeignKey
ALTER TABLE "pending_sales" ADD CONSTRAINT "pending_sales_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_sales" ADD CONSTRAINT "pending_sales_optionsPositionId_fkey" FOREIGN KEY ("optionsPositionId") REFERENCES "options_positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_sales" ADD CONSTRAINT "pending_sales_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "investment_activities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
