-- AlterTable
ALTER TABLE "consultations" ADD COLUMN     "budget_max" INTEGER,
ADD COLUMN     "budget_min" INTEGER,
ADD COLUMN     "desired_due_date" DATE,
ADD COLUMN     "preferred_style" VARCHAR(200),
ADD COLUMN     "usage_type" VARCHAR(30);

-- AlterTable
ALTER TABLE "fitting_adjustments" ADD COLUMN     "area_code" VARCHAR(20) NOT NULL DEFAULT 'ETC';

-- AlterTable
ALTER TABLE "repair_requests" ADD COLUMN     "delivery_address" VARCHAR(300),
ADD COLUMN     "pickup_address" VARCHAR(300),
ADD COLUMN     "receipt_method" VARCHAR(20),
ADD COLUMN     "release_method" VARCHAR(20);

-- CreateTable
CREATE TABLE "journey_stages" (
    "id" UUID NOT NULL,
    "track_type" VARCHAR(20) NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "sequence_no" INTEGER NOT NULL,
    "template_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "journey_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_journeys" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_id" UUID,
    "track_type" VARCHAR(20) NOT NULL,
    "current_stage_code" VARCHAR(30) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_journeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journey_events" (
    "id" UUID NOT NULL,
    "journey_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "from_stage_code" VARCHAR(30),
    "to_stage_code" VARCHAR(30) NOT NULL,
    "reason" TEXT,
    "notes" TEXT,
    "notification_outcome" VARCHAR(20) NOT NULL DEFAULT 'NONE',
    "notification_history_id" UUID,
    "actor_id" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "journey_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "journey_stages_track_type_code_key" ON "journey_stages"("track_type", "code");

-- CreateIndex
CREATE UNIQUE INDEX "journey_stages_track_type_sequence_no_key" ON "journey_stages"("track_type", "sequence_no");

-- CreateIndex
CREATE INDEX "customer_journeys_customer_id_started_at_idx" ON "customer_journeys"("customer_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "customer_journeys_status_current_stage_code_idx" ON "customer_journeys"("status", "current_stage_code");

-- CreateIndex
CREATE INDEX "journey_events_journey_id_changed_at_idx" ON "journey_events"("journey_id", "changed_at" DESC);

-- CreateIndex
CREATE INDEX "journey_events_notification_outcome_idx" ON "journey_events"("notification_outcome");

-- AddForeignKey
ALTER TABLE "journey_stages" ADD CONSTRAINT "journey_stages_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "notification_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_journeys" ADD CONSTRAINT "customer_journeys_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_journeys" ADD CONSTRAINT "customer_journeys_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journey_events" ADD CONSTRAINT "journey_events_journey_id_fkey" FOREIGN KEY ("journey_id") REFERENCES "customer_journeys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journey_events" ADD CONSTRAINT "journey_events_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "journey_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journey_events" ADD CONSTRAINT "journey_events_notification_history_id_fkey" FOREIGN KEY ("notification_history_id") REFERENCES "notification_history"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journey_events" ADD CONSTRAINT "journey_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
