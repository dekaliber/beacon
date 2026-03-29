-- Cash Flow Phase 1: credit card settings, dividend elections, transfers, statement overrides

-- ── New enum ──────────────────────────────────────────────────────────────────
CREATE TYPE "DividendElection" AS ENUM ('REINVEST', 'CASH');

-- ── Account additions ─────────────────────────────────────────────────────────
-- Balance tracking
ALTER TABLE "accounts" ADD COLUMN "balanceUpdatedAt" TIMESTAMP(3);

-- Credit card settings
ALTER TABLE "accounts" ADD COLUMN "closingDay" INTEGER;
ALTER TABLE "accounts" ADD COLUMN "dueDay" INTEGER;
ALTER TABLE "accounts" ADD COLUMN "linkedBankAccountId" TEXT;

-- Investment dividend settings
ALTER TABLE "accounts" ADD COLUMN "dividendElection" "DividendElection";
ALTER TABLE "accounts" ADD COLUMN "defaultCashAccountId" TEXT;

-- Foreign keys for self-relations
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_linkedBankAccountId_fkey"
  FOREIGN KEY ("linkedBankAccountId") REFERENCES "accounts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "accounts" ADD CONSTRAINT "accounts_defaultCashAccountId_fkey"
  FOREIGN KEY ("defaultCashAccountId") REFERENCES "accounts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── PendingDividend: estimated payment date ───────────────────────────────────
ALTER TABLE "pending_dividends" ADD COLUMN "paymentDate" DATE;

-- ── TransferRule ─────────────────────────────────────────────────────────────
CREATE TABLE "transfer_rules" (
  "id"             TEXT NOT NULL,
  "description"    TEXT NOT NULL,
  "amount"         DECIMAL(12,2) NOT NULL,
  "frequency"      "Frequency" NOT NULL,
  "interval"       INTEGER NOT NULL DEFAULT 1,
  "startDate"      TIMESTAMP(3) NOT NULL,
  "endDate"        TIMESTAMP(3),
  "nextOccurrence" TIMESTAMP(3) NOT NULL,
  "fromAccountId"  TEXT NOT NULL,
  "toAccountId"    TEXT NOT NULL,
  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "transfer_rules_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "transfer_rules" ADD CONSTRAINT "transfer_rules_fromAccountId_fkey"
  FOREIGN KEY ("fromAccountId") REFERENCES "accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "transfer_rules" ADD CONSTRAINT "transfer_rules_toAccountId_fkey"
  FOREIGN KEY ("toAccountId") REFERENCES "accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Transfer ─────────────────────────────────────────────────────────────────
CREATE TABLE "transfers" (
  "id"             TEXT NOT NULL,
  "description"    TEXT NOT NULL,
  "amount"         DECIMAL(12,2) NOT NULL,
  "date"           TIMESTAMP(3) NOT NULL,
  "notes"          TEXT,
  "fromAccountId"  TEXT NOT NULL,
  "toAccountId"    TEXT NOT NULL,
  "transferRuleId" TEXT,
  "isConfirmed"    BOOLEAN NOT NULL DEFAULT false,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "transfers_date_idx" ON "transfers"("date");
CREATE INDEX "transfers_fromAccountId_idx" ON "transfers"("fromAccountId");
CREATE INDEX "transfers_toAccountId_idx" ON "transfers"("toAccountId");

ALTER TABLE "transfers" ADD CONSTRAINT "transfers_fromAccountId_fkey"
  FOREIGN KEY ("fromAccountId") REFERENCES "accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "transfers" ADD CONSTRAINT "transfers_toAccountId_fkey"
  FOREIGN KEY ("toAccountId") REFERENCES "accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "transfers" ADD CONSTRAINT "transfers_transferRuleId_fkey"
  FOREIGN KEY ("transferRuleId") REFERENCES "transfer_rules"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── StatementOverride ─────────────────────────────────────────────────────────
CREATE TABLE "statement_overrides" (
  "id"          TEXT NOT NULL,
  "accountId"   TEXT NOT NULL,
  "periodStart" DATE NOT NULL,
  "periodEnd"   DATE NOT NULL,
  "amount"      DECIMAL(12,2) NOT NULL,
  "notes"       TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "statement_overrides_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "statement_overrides_accountId_periodStart_key" UNIQUE ("accountId", "periodStart")
);

CREATE INDEX "statement_overrides_accountId_idx" ON "statement_overrides"("accountId");

ALTER TABLE "statement_overrides" ADD CONSTRAINT "statement_overrides_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
