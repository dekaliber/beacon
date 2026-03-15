-- Remove BIWEEKLY and QUARTERLY from Frequency enum
-- No records use these values (confirmed via query before migration)

CREATE TYPE "Frequency_new" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY');

ALTER TABLE "recurrence_rules"
  ALTER COLUMN "frequency" TYPE "Frequency_new"
  USING "frequency"::text::"Frequency_new";

DROP TYPE "Frequency";

ALTER TYPE "Frequency_new" RENAME TO "Frequency";
