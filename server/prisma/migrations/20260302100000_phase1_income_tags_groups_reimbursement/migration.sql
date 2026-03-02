-- CreateEnum
CREATE TYPE "IncomeSource" AS ENUM ('DIVIDENDS', 'INTEREST', 'CAPITAL_GAINS', 'GIFTS', 'OTHER');

-- AlterTable: add reimbursement fields to expenses
ALTER TABLE "expenses"
  ADD COLUMN "isReimbursementExpected" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reimbursementNote" TEXT,
  ADD COLUMN "transactionGroupId" TEXT;

-- CreateTable: transaction_groups
CREATE TABLE "transaction_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "transaction_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable: incomes
CREATE TABLE "incomes" (
    "id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "source" "IncomeSource" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "accountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "transactionGroupId" TEXT,
    CONSTRAINT "incomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable: tags
CREATE TABLE "tags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable: expense_tags
CREATE TABLE "expense_tags" (
    "expenseId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    CONSTRAINT "expense_tags_pkey" PRIMARY KEY ("expenseId","tagId")
);

-- CreateTable: income_tags
CREATE TABLE "income_tags" (
    "incomeId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    CONSTRAINT "income_tags_pkey" PRIMARY KEY ("incomeId","tagId")
);

-- CreateIndex
CREATE UNIQUE INDEX "tags_name_key" ON "tags"("name");

-- CreateIndex
CREATE INDEX "incomes_date_idx" ON "incomes"("date");

-- CreateIndex
CREATE INDEX "incomes_accountId_idx" ON "incomes"("accountId");

-- AddForeignKey: expenses -> transaction_groups
ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_transactionGroupId_fkey"
  FOREIGN KEY ("transactionGroupId") REFERENCES "transaction_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: incomes -> accounts
ALTER TABLE "incomes"
  ADD CONSTRAINT "incomes_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: incomes -> transaction_groups
ALTER TABLE "incomes"
  ADD CONSTRAINT "incomes_transactionGroupId_fkey"
  FOREIGN KEY ("transactionGroupId") REFERENCES "transaction_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: expense_tags -> expenses
ALTER TABLE "expense_tags"
  ADD CONSTRAINT "expense_tags_expenseId_fkey"
  FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: expense_tags -> tags
ALTER TABLE "expense_tags"
  ADD CONSTRAINT "expense_tags_tagId_fkey"
  FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: income_tags -> incomes
ALTER TABLE "income_tags"
  ADD CONSTRAINT "income_tags_incomeId_fkey"
  FOREIGN KEY ("incomeId") REFERENCES "incomes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: income_tags -> tags
ALTER TABLE "income_tags"
  ADD CONSTRAINT "income_tags_tagId_fkey"
  FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
