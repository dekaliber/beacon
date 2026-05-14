-- AlterTable
ALTER TABLE "options_positions" ADD COLUMN "deltaAtOpen" DECIMAL(10,6),
                                ADD COLUMN "deltaAtOpenCapturedAt" TIMESTAMP(3);
