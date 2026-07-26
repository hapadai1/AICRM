-- AlterTable
ALTER TABLE "option_stages" ADD COLUMN     "component_group" VARCHAR(20);

-- CreateTable
CREATE TABLE "option_selection_component_attrs" (
    "id" UUID NOT NULL,
    "selection_session_id" UUID NOT NULL,
    "component_group" VARCHAR(20) NOT NULL,
    "fabric_name" VARCHAR(150),
    "color_name" VARCHAR(150),
    "pattern_name" VARCHAR(150),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "option_selection_component_attrs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rental_colors" (
    "id" UUID NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rental_colors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rental_sizes" (
    "id" UUID NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rental_sizes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rental_selection_sessions" (
    "id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "selection_version_no" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(20) NOT NULL DEFAULT 'IN_PROGRESS',
    "confirmed_at" TIMESTAMPTZ(6),
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rental_selection_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rental_selection_lines" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "order_item_component_id" UUID NOT NULL,
    "component_type" VARCHAR(20) NOT NULL,
    "color_code" VARCHAR(30),
    "size_code" VARCHAR(30),
    "notes" TEXT,
    "selected_inventory_item_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rental_selection_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "option_selection_component_attrs_selection_session_id_compo_key" ON "option_selection_component_attrs"("selection_session_id", "component_group");

-- CreateIndex
CREATE UNIQUE INDEX "rental_colors_code_key" ON "rental_colors"("code");

-- CreateIndex
CREATE UNIQUE INDEX "rental_sizes_code_key" ON "rental_sizes"("code");

-- CreateIndex
CREATE INDEX "rental_selection_sessions_order_item_id_is_current_idx" ON "rental_selection_sessions"("order_item_id", "is_current");

-- CreateIndex
CREATE UNIQUE INDEX "rental_selection_sessions_order_item_id_selection_version_n_key" ON "rental_selection_sessions"("order_item_id", "selection_version_no");

-- CreateIndex
CREATE UNIQUE INDEX "rental_selection_lines_session_id_order_item_component_id_key" ON "rental_selection_lines"("session_id", "order_item_component_id");

-- AddForeignKey
ALTER TABLE "option_selection_component_attrs" ADD CONSTRAINT "option_selection_component_attrs_selection_session_id_fkey" FOREIGN KEY ("selection_session_id") REFERENCES "option_selection_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_selection_sessions" ADD CONSTRAINT "rental_selection_sessions_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_selection_lines" ADD CONSTRAINT "rental_selection_lines_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "rental_selection_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_selection_lines" ADD CONSTRAINT "rental_selection_lines_order_item_component_id_fkey" FOREIGN KEY ("order_item_component_id") REFERENCES "order_item_components"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_selection_lines" ADD CONSTRAINT "rental_selection_lines_selected_inventory_item_id_fkey" FOREIGN KEY ("selected_inventory_item_id") REFERENCES "rental_inventory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
