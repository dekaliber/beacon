-- Add optional group label to recurrence rules for user-defined grouping in the UI.

ALTER TABLE "recurrence_rules"
  ADD COLUMN "group" TEXT;
