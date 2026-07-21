-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "balance_due_date" DATE;

-- AlterTable
ALTER TABLE "measurement_sessions" ADD COLUMN     "completed_at" TIMESTAMPTZ(6);
