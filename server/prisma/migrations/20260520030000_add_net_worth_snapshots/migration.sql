CREATE TABLE "net_worth_snapshots" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "investments" DECIMAL(14,2) NOT NULL,
    "investmentCash" DECIMAL(14,2) NOT NULL,
    "bankingCash" DECIMAL(14,2) NOT NULL,
    "creditCardDebt" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "net_worth_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "net_worth_account_snapshots" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "net_worth_account_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "net_worth_snapshots_userId_date_key" ON "net_worth_snapshots"("userId", "date");
CREATE INDEX "net_worth_snapshots_userId_idx" ON "net_worth_snapshots"("userId");
CREATE UNIQUE INDEX "net_worth_account_snapshots_snapshotId_accountId_key" ON "net_worth_account_snapshots"("snapshotId", "accountId");

ALTER TABLE "net_worth_account_snapshots" ADD CONSTRAINT "net_worth_account_snapshots_snapshotId_fkey"
    FOREIGN KEY ("snapshotId") REFERENCES "net_worth_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "net_worth_account_snapshots" ADD CONSTRAINT "net_worth_account_snapshots_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
