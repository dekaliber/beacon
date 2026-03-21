-- Prevent duplicate recurring expense instances for the same rule on the same date.
-- The application-level findFirst guard is not safe under concurrent execution;
-- this constraint makes the database the source of truth.
-- Uses a partial index so the constraint only applies to top-level recurring rows
-- (i.e. not offset children, and not manually-created expenses).
CREATE UNIQUE INDEX "expenses_recurrence_rule_date_unique"
  ON "expenses" ("recurrenceRuleId", CAST(date AS date))
  WHERE "recurrenceRuleId" IS NOT NULL
    AND "parentExpenseId" IS NULL;
