-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_contract_id_fkey";

-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_created_by_fkey";

-- AlterTable
ALTER TABLE "repair_requests" DROP COLUMN "cost";

-- DropTable
DROP TABLE "payments";

