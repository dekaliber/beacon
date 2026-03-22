-- Add isManaged flag to accounts for robo-advisor / managed investment accounts
ALTER TABLE "accounts" ADD COLUMN "isManaged" BOOLEAN NOT NULL DEFAULT FALSE;
