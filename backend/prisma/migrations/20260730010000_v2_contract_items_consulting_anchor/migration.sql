-- DropForeignKey
ALTER TABLE "contract_versions" DROP CONSTRAINT "contract_versions_excel_file_id_fkey";

-- DropForeignKey
ALTER TABLE "option_selection_sessions" DROP CONSTRAINT "option_selection_sessions_order_item_id_fkey";

-- DropForeignKey
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_source_contract_line_id_fkey";

-- DropForeignKey
ALTER TABLE "rental_selection_lines" DROP CONSTRAINT "rental_selection_lines_order_item_component_id_fkey";

-- DropForeignKey
ALTER TABLE "rental_selection_sessions" DROP CONSTRAINT "rental_selection_sessions_order_item_id_fkey";

-- DropForeignKey
ALTER TABLE "repair_request_items" DROP CONSTRAINT "repair_request_items_repair_request_id_fkey";

-- DropIndex
DROP INDEX "option_selection_sessions_order_item_id_is_current_status_idx";

-- DropIndex
DROP INDEX "option_selection_sessions_order_item_id_selection_version_n_key";

-- DropIndex
DROP INDEX "rental_selection_lines_session_id_order_item_component_id_key";

-- DropIndex
DROP INDEX "rental_selection_sessions_order_item_id_is_current_idx";

-- DropIndex
DROP INDEX "rental_selection_sessions_order_item_id_selection_version_n_key";

-- AlterTable
ALTER TABLE "option_selection_sessions" DROP COLUMN "order_item_id",
ADD COLUMN     "contract_item_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "order_items" DROP COLUMN "source_contract_line_id",
ADD COLUMN     "source_contract_item_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "rental_colors" ALTER COLUMN "component_types" DROP DEFAULT;

-- AlterTable
ALTER TABLE "rental_selection_lines" DROP COLUMN "order_item_component_id",
ADD COLUMN     "contract_item_component_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "rental_selection_sessions" DROP COLUMN "order_item_id",
ADD COLUMN     "contract_item_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "rental_sizes" ALTER COLUMN "component_types" DROP DEFAULT;

-- CreateTable
CREATE TABLE "contract_items" (
    "id" UUID NOT NULL,
    "contract_version_id" UUID NOT NULL,
    "source_contract_line_id" UUID NOT NULL,
    "transaction_type" VARCHAR(20) NOT NULL,
    "product_category" VARCHAR(20) NOT NULL,
    "sequence_no" INTEGER NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'CREATED',
    "cancelled_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contract_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_item_components" (
    "id" UUID NOT NULL,
    "contract_item_id" UUID NOT NULL,
    "component_type" VARCHAR(20) NOT NULL,
    "sequence_no" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(30) NOT NULL DEFAULT 'CREATED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contract_item_components_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contract_items_contract_version_id_idx" ON "contract_items"("contract_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_items_contract_version_id_transaction_type_product_key" ON "contract_items"("contract_version_id", "transaction_type", "product_category", "sequence_no");

-- CreateIndex
CREATE INDEX "contract_item_components_contract_item_id_component_type_idx" ON "contract_item_components"("contract_item_id", "component_type");

-- CreateIndex
CREATE INDEX "option_selection_sessions_contract_item_id_is_current_statu_idx" ON "option_selection_sessions"("contract_item_id", "is_current", "status");

-- CreateIndex
CREATE UNIQUE INDEX "option_selection_sessions_contract_item_id_selection_versio_key" ON "option_selection_sessions"("contract_item_id", "selection_version_no");

-- CreateIndex
CREATE UNIQUE INDEX "rental_selection_lines_session_id_contract_item_component_i_key" ON "rental_selection_lines"("session_id", "contract_item_component_id");

-- CreateIndex
CREATE INDEX "rental_selection_sessions_contract_item_id_is_current_idx" ON "rental_selection_sessions"("contract_item_id", "is_current");

-- CreateIndex
CREATE UNIQUE INDEX "rental_selection_sessions_contract_item_id_selection_versio_key" ON "rental_selection_sessions"("contract_item_id", "selection_version_no");

-- AddForeignKey
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_excel_file_id_fkey" FOREIGN KEY ("excel_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_items" ADD CONSTRAINT "contract_items_contract_version_id_fkey" FOREIGN KEY ("contract_version_id") REFERENCES "contract_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_items" ADD CONSTRAINT "contract_items_source_contract_line_id_fkey" FOREIGN KEY ("source_contract_line_id") REFERENCES "contract_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_item_components" ADD CONSTRAINT "contract_item_components_contract_item_id_fkey" FOREIGN KEY ("contract_item_id") REFERENCES "contract_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_source_contract_item_id_fkey" FOREIGN KEY ("source_contract_item_id") REFERENCES "contract_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_selection_sessions" ADD CONSTRAINT "option_selection_sessions_contract_item_id_fkey" FOREIGN KEY ("contract_item_id") REFERENCES "contract_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_selection_sessions" ADD CONSTRAINT "rental_selection_sessions_contract_item_id_fkey" FOREIGN KEY ("contract_item_id") REFERENCES "contract_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_selection_lines" ADD CONSTRAINT "rental_selection_lines_contract_item_component_id_fkey" FOREIGN KEY ("contract_item_component_id") REFERENCES "contract_item_components"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_request_items" ADD CONSTRAINT "repair_request_items_repair_request_id_fkey" FOREIGN KEY ("repair_request_id") REFERENCES "repair_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

