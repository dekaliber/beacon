-- Migration: budget_overhaul
-- Replaces the old single-amount per-month Budget model with a flexible
-- AnnualBudget + MonthlyBudget (override) hierarchy, and adds BudgetSettings
-- for the joint split ratio.

-- Drop old budget table (no longer used)
DROP TABLE IF EXISTS "budgets";

-- Budget type enum
CREATE TYPE "BudgetType" AS ENUM ('PERSONAL', 'JOINT');

-- Annual budget record per type per year.
-- annualAmount is nullable to support users who prefer month-by-month control.
CREATE TABLE "annual_budgets" (
    "id"           TEXT NOT NULL,
    "type"         "BudgetType" NOT NULL,
    "year"         INTEGER NOT NULL,
    "annualAmount" DECIMAL(12,2),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "annual_budgets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "annual_budgets_type_year_key" ON "annual_budgets"("type", "year");

-- Per-month override amounts (optional).  Resolution: use this if present,
-- otherwise fall back to annualBudget.annualAmount / 12.
CREATE TABLE "monthly_budgets" (
    "id"             TEXT NOT NULL,
    "annualBudgetId" TEXT NOT NULL,
    "month"          INTEGER NOT NULL,
    "amount"         DECIMAL(12,2) NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monthly_budgets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "monthly_budgets_annualBudgetId_month_key"
    ON "monthly_budgets"("annualBudgetId", "month");

ALTER TABLE "monthly_budgets"
    ADD CONSTRAINT "monthly_budgets_annualBudgetId_fkey"
    FOREIGN KEY ("annualBudgetId")
    REFERENCES "annual_budgets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Single-row settings table for global budget configuration.
-- jointSplitRatio: fraction of joint expenses counted toward the user's
-- Total budget (default 0.5 for a 50/50 split).
CREATE TABLE "budget_settings" (
    "id"              TEXT NOT NULL,
    "jointSplitRatio" DECIMAL(4,3) NOT NULL DEFAULT 0.5,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_settings_pkey" PRIMARY KEY ("id")
);
