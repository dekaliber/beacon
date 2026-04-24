-- CreateTable
CREATE TABLE "tax_assumptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "filingStatus" TEXT NOT NULL DEFAULT 'SINGLE',
    "otherOrdinary" DECIMAL(14,2),
    "federalWithheld" DECIMAL(14,2),
    "otherLtcg" DECIMAL(14,2),
    "caWithheld" DECIMAL(14,2),
    "useTmt" BOOLEAN NOT NULL DEFAULT false,
    "useCaTmt" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_assumptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_quarterly_payments" (
    "id" TEXT NOT NULL,
    "taxAssumptionsId" TEXT NOT NULL,
    "quarter" INTEGER NOT NULL,
    "federalAmount" DECIMAL(14,2),
    "caAmount" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_quarterly_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tax_assumptions_userId_idx" ON "tax_assumptions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "tax_assumptions_userId_year_key" ON "tax_assumptions"("userId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "tax_quarterly_payments_taxAssumptionsId_quarter_key" ON "tax_quarterly_payments"("taxAssumptionsId", "quarter");

-- AddForeignKey
ALTER TABLE "tax_quarterly_payments" ADD CONSTRAINT "tax_quarterly_payments_taxAssumptionsId_fkey" FOREIGN KEY ("taxAssumptionsId") REFERENCES "tax_assumptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
