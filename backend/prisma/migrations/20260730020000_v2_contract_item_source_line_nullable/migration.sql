-- DropForeignKey
ALTER TABLE "contract_items" DROP CONSTRAINT "contract_items_source_contract_line_id_fkey";

-- AlterTable
ALTER TABLE "contract_items" ALTER COLUMN "source_contract_line_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "contract_items" ADD CONSTRAINT "contract_items_source_contract_line_id_fkey" FOREIGN KEY ("source_contract_line_id") REFERENCES "contract_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

