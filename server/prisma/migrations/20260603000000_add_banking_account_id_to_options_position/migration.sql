-- AlterTable
ALTER TABLE "options_positions" ADD COLUMN "bankingAccountId" TEXT;

-- AddForeignKey
ALTER TABLE "options_positions" ADD CONSTRAINT "options_positions_bankingAccountId_fkey" FOREIGN KEY ("bankingAccountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
