-- CreateTable
CREATE TABLE "assigned_share_dispositions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "saleActivityId" TEXT NOT NULL,
    "fromOptionsPositionId" TEXT,
    "soldViaPositionId" TEXT,
    "ticker" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "assignmentStrike" DECIMAL(12,2) NOT NULL,
    "assignmentExpiration" DATE NOT NULL,
    "shares" DECIMAL(18,8) NOT NULL,
    "salePricePerShare" DECIMAL(18,8) NOT NULL,
    "saleDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assigned_share_dispositions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assigned_share_dispositions_userId_ticker_idx" ON "assigned_share_dispositions"("userId", "ticker");

-- CreateIndex
CREATE INDEX "assigned_share_dispositions_saleActivityId_idx" ON "assigned_share_dispositions"("saleActivityId");

-- AddForeignKey
ALTER TABLE "assigned_share_dispositions" ADD CONSTRAINT "assigned_share_dispositions_saleActivityId_fkey" FOREIGN KEY ("saleActivityId") REFERENCES "investment_activities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assigned_share_dispositions" ADD CONSTRAINT "assigned_share_dispositions_fromOptionsPositionId_fkey" FOREIGN KEY ("fromOptionsPositionId") REFERENCES "options_positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assigned_share_dispositions" ADD CONSTRAINT "assigned_share_dispositions_soldViaPositionId_fkey" FOREIGN KEY ("soldViaPositionId") REFERENCES "options_positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

