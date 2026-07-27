-- AlterTable
ALTER TABLE "journey_stages" ADD COLUMN     "completion_mode" VARCHAR(10) NOT NULL DEFAULT 'GATED',
ADD COLUMN     "target_scope" VARCHAR(20) NOT NULL DEFAULT 'ORDER_ITEMS';

-- CreateTable
CREATE TABLE "journey_stage_item_completions" (
    "id" UUID NOT NULL,
    "journey_id" UUID NOT NULL,
    "stage_code" VARCHAR(30) NOT NULL,
    "target_type" VARCHAR(20) NOT NULL,
    "target_id" UUID NOT NULL,
    "completed_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_by" UUID NOT NULL,
    "notes" TEXT,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journey_stage_item_completions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "journey_stage_item_completions_journey_id_stage_code_idx" ON "journey_stage_item_completions"("journey_id", "stage_code");

-- CreateIndex
CREATE UNIQUE INDEX "journey_stage_item_completions_journey_id_stage_code_target_key" ON "journey_stage_item_completions"("journey_id", "stage_code", "target_type", "target_id");

-- AddForeignKey
ALTER TABLE "journey_stage_item_completions" ADD CONSTRAINT "journey_stage_item_completions_journey_id_fkey" FOREIGN KEY ("journey_id") REFERENCES "customer_journeys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journey_stage_item_completions" ADD CONSTRAINT "journey_stage_item_completions_completed_by_fkey" FOREIGN KEY ("completed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
