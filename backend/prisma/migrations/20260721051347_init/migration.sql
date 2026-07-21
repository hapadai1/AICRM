-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "login_id" VARCHAR(80) NOT NULL,
    "display_name" VARCHAR(80) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMPTZ(6),
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" UUID NOT NULL,
    "storage_key" VARCHAR(255) NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum_sha256" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_files" (
    "id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "entity_type" VARCHAR(50) NOT NULL,
    "entity_id" UUID NOT NULL,
    "purpose" VARCHAR(30) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "action" VARCHAR(50) NOT NULL,
    "entity_type" VARCHAR(60) NOT NULL,
    "entity_id" UUID NOT NULL,
    "before_json" JSONB,
    "after_json" JSONB,
    "reason" TEXT,
    "ip_address" INET,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "phone" VARCHAR(30) NOT NULL,
    "phone_normalized" VARCHAR(20) NOT NULL,
    "email" VARCHAR(255),
    "customer_status" VARCHAR(20) NOT NULL DEFAULT 'PROSPECT',
    "first_reserved_at" TIMESTAMPTZ(6),
    "contracted_at" TIMESTAMPTZ(6),
    "notes" TEXT,
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_purposes" (
    "id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "appointment_purposes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "source" VARCHAR(20) NOT NULL,
    "external_id" VARCHAR(100),
    "purpose_id" UUID NOT NULL,
    "scheduled_start" TIMESTAMPTZ(6) NOT NULL,
    "scheduled_end" TIMESTAMPTZ(6),
    "status" VARCHAR(20) NOT NULL DEFAULT 'RESERVED',
    "notes" TEXT,
    "naver_updated_at" TIMESTAMPTZ(6),
    "synced_at" TIMESTAMPTZ(6),
    "local_override" BOOLEAN NOT NULL DEFAULT false,
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consultations" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "appointment_id" UUID,
    "consulted_at" TIMESTAMPTZ(6) NOT NULL,
    "consultation_category" VARCHAR(30),
    "content" TEXT NOT NULL,
    "staff_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "consultations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_types" (
    "id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contract_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_type_lines" (
    "id" UUID NOT NULL,
    "contract_type_id" UUID NOT NULL,
    "transaction_type" VARCHAR(20) NOT NULL,
    "product_category" VARCHAR(20) NOT NULL,
    "default_quantity" INTEGER NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contract_type_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" UUID NOT NULL,
    "contract_no" VARCHAR(40) NOT NULL,
    "customer_id" UUID NOT NULL,
    "contract_type_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "current_version_id" UUID,
    "contracted_at" TIMESTAMPTZ(6),
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_versions" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "version_status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "change_reason" TEXT,
    "total_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deposit_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "balance_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "completion_due_date" DATE,
    "photo_date" DATE,
    "wedding_date" DATE,
    "confirmed_by" UUID,
    "confirmed_at" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contract_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_lines" (
    "id" UUID NOT NULL,
    "contract_version_id" UUID NOT NULL,
    "transaction_type" VARCHAR(20) NOT NULL,
    "product_category" VARCHAR(20) NOT NULL,
    "item_description" VARCHAR(150),
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(14,2),
    "line_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "order_no" VARCHAR(40) NOT NULL,
    "contract_id" UUID NOT NULL,
    "transaction_type" VARCHAR(20) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'CREATED',
    "completion_due_date" DATE,
    "photo_date" DATE,
    "wedding_date" DATE,
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "source_contract_line_id" UUID NOT NULL,
    "product_category" VARCHAR(20) NOT NULL,
    "sequence_no" INTEGER NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'CREATED',
    "cancelled_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_components" (
    "id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "component_type" VARCHAR(20) NOT NULL,
    "sequence_no" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(30) NOT NULL DEFAULT 'CREATED',
    "expected_inbound_date" DATE,
    "actual_inbound_at" TIMESTAMPTZ(6),
    "actual_outbound_at" TIMESTAMPTZ(6),
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "order_item_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_sets" (
    "id" UUID NOT NULL,
    "product_category" VARCHAR(20) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "active_version_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "option_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_set_versions" (
    "id" UUID NOT NULL,
    "option_set_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "effective_from" DATE,
    "description" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "option_set_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_stages" (
    "id" UUID NOT NULL,
    "option_set_version_id" UUID NOT NULL,
    "stage_code" VARCHAR(40) NOT NULL,
    "stage_name" VARCHAR(100) NOT NULL,
    "sequence_no" INTEGER NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "option_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_choices" (
    "id" UUID NOT NULL,
    "option_stage_id" UUID NOT NULL,
    "choice_code" CHAR(1) NOT NULL,
    "choice_name" VARCHAR(100) NOT NULL,
    "factory_label" VARCHAR(100),
    "image_file_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "option_choices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_selection_sessions" (
    "id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "option_set_version_id" UUID NOT NULL,
    "selection_version_no" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'NOT_STARTED',
    "current_stage_id" UUID,
    "fabric_name" VARCHAR(150),
    "started_at" TIMESTAMPTZ(6),
    "last_saved_at" TIMESTAMPTZ(6),
    "reviewed_at" TIMESTAMPTZ(6),
    "confirmed_at" TIMESTAMPTZ(6),
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "option_selection_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_selection_values" (
    "id" UUID NOT NULL,
    "selection_session_id" UUID NOT NULL,
    "option_stage_id" UUID NOT NULL,
    "option_choice_id" UUID NOT NULL,
    "selected_by" UUID NOT NULL,
    "selected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "option_selection_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "measurement_sessions" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "related_order_id" UUID,
    "version_no" INTEGER NOT NULL,
    "measurement_date" DATE NOT NULL,
    "measurement_type" VARCHAR(20) NOT NULL DEFAULT 'INITIAL',
    "previous_session_id" UUID,
    "fit_preference" VARCHAR(100),
    "body_notes" TEXT,
    "notes" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "measurement_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "measurement_values" (
    "id" UUID NOT NULL,
    "measurement_session_id" UUID NOT NULL,
    "body_section" VARCHAR(20) NOT NULL,
    "measurement_code" VARCHAR(40) NOT NULL,
    "numeric_value" DECIMAL(8,2),
    "text_value" VARCHAR(40),
    "unit" VARCHAR(10) NOT NULL DEFAULT 'CM',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "measurement_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_measurements" (
    "id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "measurement_session_id" UUID NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "linked_by" UUID NOT NULL,
    "linked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_item_measurements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_orders" (
    "id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "current_version_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_versions" (
    "id" UUID NOT NULL,
    "work_order_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "source_option_session_id" UUID NOT NULL,
    "source_measurement_session_id" UUID NOT NULL,
    "option_snapshot" JSONB NOT NULL,
    "measurement_snapshot" JSONB NOT NULL,
    "source_hash" VARCHAR(64) NOT NULL,
    "change_reason" TEXT,
    "output_file_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ISSUED',
    "issued_by" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL,
    "sent_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "work_order_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_events" (
    "id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "component_id" UUID,
    "event_type" VARCHAR(40) NOT NULL,
    "previous_status" VARCHAR(30),
    "new_status" VARCHAR(30) NOT NULL,
    "expected_date" DATE,
    "event_date" DATE NOT NULL,
    "notes" TEXT,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fitting_sessions" (
    "id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "appointment_id" UUID,
    "fitting_date" DATE NOT NULL,
    "notes" TEXT,
    "next_appointment_date" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fitting_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fitting_adjustments" (
    "id" UUID NOT NULL,
    "fitting_session_id" UUID NOT NULL,
    "component_id" UUID,
    "area" VARCHAR(80) NOT NULL,
    "instruction" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fitting_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rental_skus" (
    "id" UUID NOT NULL,
    "component_type" VARCHAR(20) NOT NULL,
    "design" VARCHAR(100) NOT NULL,
    "color" VARCHAR(80) NOT NULL,
    "size" VARCHAR(40) NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rental_skus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rental_inventory_items" (
    "id" UUID NOT NULL,
    "management_code" VARCHAR(60) NOT NULL,
    "rental_sku_id" UUID NOT NULL,
    "status" VARCHAR(25) NOT NULL DEFAULT 'AVAILABLE',
    "available_from" DATE,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "acquired_at" DATE,
    "retired_at" DATE,
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rental_inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rental_allocations" (
    "id" UUID NOT NULL,
    "order_item_component_id" UUID NOT NULL,
    "rental_inventory_item_id" UUID NOT NULL,
    "pickup_date" DATE NOT NULL,
    "return_due_date" DATE NOT NULL,
    "availability_end_date" DATE NOT NULL,
    "actual_pickup_at" TIMESTAMPTZ(6),
    "actual_return_at" TIMESTAMPTZ(6),
    "status" VARCHAR(25) NOT NULL DEFAULT 'RESERVED',
    "assigned_by" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rental_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rental_allocation_events" (
    "id" UUID NOT NULL,
    "rental_allocation_id" UUID NOT NULL,
    "event_type" VARCHAR(30) NOT NULL,
    "old_inventory_item_id" UUID,
    "new_inventory_item_id" UUID,
    "reason" TEXT,
    "actor_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rental_allocation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rental_inventory_status_events" (
    "id" UUID NOT NULL,
    "rental_inventory_item_id" UUID NOT NULL,
    "previous_status" VARCHAR(25),
    "new_status" VARCHAR(25) NOT NULL,
    "available_from" DATE,
    "reason" TEXT,
    "actor_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rental_inventory_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repair_requests" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_id" UUID,
    "order_item_id" UUID,
    "component_id" UUID,
    "rental_inventory_item_id" UUID,
    "repair_type" VARCHAR(30) NOT NULL,
    "request_date" DATE NOT NULL,
    "due_date" DATE,
    "status" VARCHAR(25) NOT NULL DEFAULT 'RECEIVED',
    "description" TEXT NOT NULL,
    "cost" DECIMAL(14,2),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "repair_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repair_status_events" (
    "id" UUID NOT NULL,
    "repair_request_id" UUID NOT NULL,
    "previous_status" VARCHAR(25),
    "new_status" VARCHAR(25) NOT NULL,
    "event_date" DATE NOT NULL,
    "notes" TEXT,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repair_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "payment_type" VARCHAR(20) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "payment_date" DATE NOT NULL,
    "payment_method" VARCHAR(30),
    "status" VARCHAR(20) NOT NULL DEFAULT 'COMPLETED',
    "memo" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" UUID NOT NULL,
    "code" VARCHAR(60) NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "body" TEXT NOT NULL,
    "approval_status" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_rules" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "trigger_type" VARCHAR(40) NOT NULL,
    "auto_send" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_history" (
    "id" UUID NOT NULL,
    "template_id" UUID,
    "customer_id" UUID NOT NULL,
    "order_id" UUID,
    "recipient_phone" VARCHAR(30) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'REQUESTED',
    "sent_at" TIMESTAMPTZ(6),
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared_notes" (
    "id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "target_user_id" UUID,
    "author_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "shared_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_task_actions" (
    "id" UUID NOT NULL,
    "task_type" VARCHAR(30) NOT NULL,
    "entity_type" VARCHAR(40) NOT NULL,
    "entity_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACKNOWLEDGED',
    "memo" TEXT,
    "action_by" UUID NOT NULL,
    "action_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_task_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "user_id" UUID,
    "endpoint" VARCHAR(150) NOT NULL,
    "response_json" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_login_id_key" ON "users"("login_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "files_storage_key_key" ON "files"("storage_key");

-- CreateIndex
CREATE INDEX "entity_files_entity_type_entity_id_idx" ON "entity_files"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_created_at_idx" ON "audit_logs"("entity_type", "entity_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE UNIQUE INDEX "customers_phone_normalized_key" ON "customers"("phone_normalized");

-- CreateIndex
CREATE INDEX "customers_name_idx" ON "customers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_purposes_code_key" ON "appointment_purposes"("code");

-- CreateIndex
CREATE INDEX "appointments_scheduled_start_status_idx" ON "appointments"("scheduled_start", "status");

-- CreateIndex
CREATE INDEX "appointments_customer_id_idx" ON "appointments"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_source_external_id_key" ON "appointments"("source", "external_id");

-- CreateIndex
CREATE INDEX "consultations_customer_id_consulted_at_idx" ON "consultations"("customer_id", "consulted_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "contract_types_code_key" ON "contract_types"("code");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_contract_no_key" ON "contracts"("contract_no");

-- CreateIndex
CREATE INDEX "contracts_customer_id_contracted_at_idx" ON "contracts"("customer_id", "contracted_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "contract_versions_contract_id_version_no_key" ON "contract_versions"("contract_id", "version_no");

-- CreateIndex
CREATE INDEX "contract_lines_contract_version_id_transaction_type_product_idx" ON "contract_lines"("contract_version_id", "transaction_type", "product_category");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_no_key" ON "orders"("order_no");

-- CreateIndex
CREATE UNIQUE INDEX "orders_contract_id_transaction_type_key" ON "orders"("contract_id", "transaction_type");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_order_id_product_category_sequence_no_key" ON "order_items"("order_id", "product_category", "sequence_no");

-- CreateIndex
CREATE INDEX "order_item_components_order_item_id_component_type_idx" ON "order_item_components"("order_item_id", "component_type");

-- CreateIndex
CREATE UNIQUE INDEX "option_sets_product_category_key" ON "option_sets"("product_category");

-- CreateIndex
CREATE UNIQUE INDEX "option_set_versions_option_set_id_version_no_key" ON "option_set_versions"("option_set_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "option_stages_option_set_version_id_stage_code_key" ON "option_stages"("option_set_version_id", "stage_code");

-- CreateIndex
CREATE UNIQUE INDEX "option_stages_option_set_version_id_sequence_no_key" ON "option_stages"("option_set_version_id", "sequence_no");

-- CreateIndex
CREATE UNIQUE INDEX "option_choices_option_stage_id_choice_code_key" ON "option_choices"("option_stage_id", "choice_code");

-- CreateIndex
CREATE INDEX "option_selection_sessions_order_item_id_is_current_status_idx" ON "option_selection_sessions"("order_item_id", "is_current", "status");

-- CreateIndex
CREATE UNIQUE INDEX "option_selection_sessions_order_item_id_selection_version_n_key" ON "option_selection_sessions"("order_item_id", "selection_version_no");

-- CreateIndex
CREATE UNIQUE INDEX "option_selection_values_selection_session_id_option_stage_i_key" ON "option_selection_values"("selection_session_id", "option_stage_id");

-- CreateIndex
CREATE INDEX "measurement_sessions_customer_id_measurement_date_idx" ON "measurement_sessions"("customer_id", "measurement_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "measurement_sessions_customer_id_version_no_key" ON "measurement_sessions"("customer_id", "version_no");

-- CreateIndex
CREATE INDEX "measurement_values_body_section_idx" ON "measurement_values"("body_section");

-- CreateIndex
CREATE UNIQUE INDEX "measurement_values_measurement_session_id_measurement_code_key" ON "measurement_values"("measurement_session_id", "measurement_code");

-- CreateIndex
CREATE INDEX "order_item_measurements_order_item_id_is_current_idx" ON "order_item_measurements"("order_item_id", "is_current");

-- CreateIndex
CREATE UNIQUE INDEX "work_orders_order_item_id_key" ON "work_orders"("order_item_id");

-- CreateIndex
CREATE INDEX "work_order_versions_work_order_id_issued_at_idx" ON "work_order_versions"("work_order_id", "issued_at" DESC);

-- CreateIndex
CREATE INDEX "work_order_versions_source_hash_idx" ON "work_order_versions"("source_hash");

-- CreateIndex
CREATE UNIQUE INDEX "work_order_versions_work_order_id_version_no_key" ON "work_order_versions"("work_order_id", "version_no");

-- CreateIndex
CREATE INDEX "production_events_order_item_id_event_date_idx" ON "production_events"("order_item_id", "event_date");

-- CreateIndex
CREATE INDEX "production_events_event_type_idx" ON "production_events"("event_type");

-- CreateIndex
CREATE INDEX "production_events_expected_date_new_status_idx" ON "production_events"("expected_date", "new_status");

-- CreateIndex
CREATE INDEX "fitting_sessions_fitting_date_idx" ON "fitting_sessions"("fitting_date");

-- CreateIndex
CREATE INDEX "rental_skus_component_type_design_color_size_idx" ON "rental_skus"("component_type", "design", "color", "size");

-- CreateIndex
CREATE UNIQUE INDEX "rental_inventory_items_management_code_key" ON "rental_inventory_items"("management_code");

-- CreateIndex
CREATE INDEX "rental_inventory_items_status_available_from_idx" ON "rental_inventory_items"("status", "available_from");

-- CreateIndex
CREATE INDEX "rental_allocations_rental_inventory_item_id_pickup_date_ava_idx" ON "rental_allocations"("rental_inventory_item_id", "pickup_date", "availability_end_date");

-- CreateIndex
CREATE INDEX "rental_allocations_return_due_date_status_idx" ON "rental_allocations"("return_due_date", "status");

-- CreateIndex
CREATE INDEX "rental_allocation_events_rental_allocation_id_event_type_idx" ON "rental_allocation_events"("rental_allocation_id", "event_type");

-- CreateIndex
CREATE INDEX "rental_inventory_status_events_rental_inventory_item_id_occ_idx" ON "rental_inventory_status_events"("rental_inventory_item_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "repair_requests_request_date_idx" ON "repair_requests"("request_date");

-- CreateIndex
CREATE INDEX "repair_requests_due_date_status_idx" ON "repair_requests"("due_date", "status");

-- CreateIndex
CREATE INDEX "repair_status_events_repair_request_id_event_date_idx" ON "repair_status_events"("repair_request_id", "event_date");

-- CreateIndex
CREATE INDEX "payments_contract_id_payment_type_idx" ON "payments"("contract_id", "payment_type");

-- CreateIndex
CREATE INDEX "payments_payment_date_status_idx" ON "payments"("payment_date", "status");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_code_key" ON "notification_templates"("code");

-- CreateIndex
CREATE INDEX "notification_rules_trigger_type_idx" ON "notification_rules"("trigger_type");

-- CreateIndex
CREATE INDEX "notification_history_customer_id_created_at_idx" ON "notification_history"("customer_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "dashboard_task_actions_task_type_entity_type_entity_id_idx" ON "dashboard_task_actions"("task_type", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_key_key" ON "idempotency_keys"("key");

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_files" ADD CONSTRAINT "entity_files_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_purpose_id_fkey" FOREIGN KEY ("purpose_id") REFERENCES "appointment_purposes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_type_lines" ADD CONSTRAINT "contract_type_lines_contract_type_id_fkey" FOREIGN KEY ("contract_type_id") REFERENCES "contract_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_contract_type_id_fkey" FOREIGN KEY ("contract_type_id") REFERENCES "contract_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "contract_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_lines" ADD CONSTRAINT "contract_lines_contract_version_id_fkey" FOREIGN KEY ("contract_version_id") REFERENCES "contract_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_source_contract_line_id_fkey" FOREIGN KEY ("source_contract_line_id") REFERENCES "contract_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_components" ADD CONSTRAINT "order_item_components_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_sets" ADD CONSTRAINT "option_sets_active_version_id_fkey" FOREIGN KEY ("active_version_id") REFERENCES "option_set_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_set_versions" ADD CONSTRAINT "option_set_versions_option_set_id_fkey" FOREIGN KEY ("option_set_id") REFERENCES "option_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_set_versions" ADD CONSTRAINT "option_set_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_stages" ADD CONSTRAINT "option_stages_option_set_version_id_fkey" FOREIGN KEY ("option_set_version_id") REFERENCES "option_set_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_choices" ADD CONSTRAINT "option_choices_option_stage_id_fkey" FOREIGN KEY ("option_stage_id") REFERENCES "option_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_choices" ADD CONSTRAINT "option_choices_image_file_id_fkey" FOREIGN KEY ("image_file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_selection_sessions" ADD CONSTRAINT "option_selection_sessions_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_selection_sessions" ADD CONSTRAINT "option_selection_sessions_option_set_version_id_fkey" FOREIGN KEY ("option_set_version_id") REFERENCES "option_set_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_selection_sessions" ADD CONSTRAINT "option_selection_sessions_current_stage_id_fkey" FOREIGN KEY ("current_stage_id") REFERENCES "option_stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_selection_values" ADD CONSTRAINT "option_selection_values_selection_session_id_fkey" FOREIGN KEY ("selection_session_id") REFERENCES "option_selection_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_selection_values" ADD CONSTRAINT "option_selection_values_option_stage_id_fkey" FOREIGN KEY ("option_stage_id") REFERENCES "option_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_selection_values" ADD CONSTRAINT "option_selection_values_option_choice_id_fkey" FOREIGN KEY ("option_choice_id") REFERENCES "option_choices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_selection_values" ADD CONSTRAINT "option_selection_values_selected_by_fkey" FOREIGN KEY ("selected_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurement_sessions" ADD CONSTRAINT "measurement_sessions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurement_sessions" ADD CONSTRAINT "measurement_sessions_related_order_id_fkey" FOREIGN KEY ("related_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurement_sessions" ADD CONSTRAINT "measurement_sessions_previous_session_id_fkey" FOREIGN KEY ("previous_session_id") REFERENCES "measurement_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurement_sessions" ADD CONSTRAINT "measurement_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurement_values" ADD CONSTRAINT "measurement_values_measurement_session_id_fkey" FOREIGN KEY ("measurement_session_id") REFERENCES "measurement_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_measurements" ADD CONSTRAINT "order_item_measurements_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_measurements" ADD CONSTRAINT "order_item_measurements_measurement_session_id_fkey" FOREIGN KEY ("measurement_session_id") REFERENCES "measurement_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_measurements" ADD CONSTRAINT "order_item_measurements_linked_by_fkey" FOREIGN KEY ("linked_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "work_order_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_versions" ADD CONSTRAINT "work_order_versions_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_versions" ADD CONSTRAINT "work_order_versions_source_option_session_id_fkey" FOREIGN KEY ("source_option_session_id") REFERENCES "option_selection_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_versions" ADD CONSTRAINT "work_order_versions_source_measurement_session_id_fkey" FOREIGN KEY ("source_measurement_session_id") REFERENCES "measurement_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_versions" ADD CONSTRAINT "work_order_versions_output_file_id_fkey" FOREIGN KEY ("output_file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_versions" ADD CONSTRAINT "work_order_versions_issued_by_fkey" FOREIGN KEY ("issued_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_events" ADD CONSTRAINT "production_events_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_events" ADD CONSTRAINT "production_events_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "order_item_components"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_events" ADD CONSTRAINT "production_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fitting_sessions" ADD CONSTRAINT "fitting_sessions_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fitting_sessions" ADD CONSTRAINT "fitting_sessions_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fitting_adjustments" ADD CONSTRAINT "fitting_adjustments_fitting_session_id_fkey" FOREIGN KEY ("fitting_session_id") REFERENCES "fitting_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fitting_adjustments" ADD CONSTRAINT "fitting_adjustments_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "order_item_components"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_inventory_items" ADD CONSTRAINT "rental_inventory_items_rental_sku_id_fkey" FOREIGN KEY ("rental_sku_id") REFERENCES "rental_skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_allocations" ADD CONSTRAINT "rental_allocations_order_item_component_id_fkey" FOREIGN KEY ("order_item_component_id") REFERENCES "order_item_components"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_allocations" ADD CONSTRAINT "rental_allocations_rental_inventory_item_id_fkey" FOREIGN KEY ("rental_inventory_item_id") REFERENCES "rental_inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_allocations" ADD CONSTRAINT "rental_allocations_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_allocation_events" ADD CONSTRAINT "rental_allocation_events_rental_allocation_id_fkey" FOREIGN KEY ("rental_allocation_id") REFERENCES "rental_allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_allocation_events" ADD CONSTRAINT "rental_allocation_events_old_inventory_item_id_fkey" FOREIGN KEY ("old_inventory_item_id") REFERENCES "rental_inventory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_allocation_events" ADD CONSTRAINT "rental_allocation_events_new_inventory_item_id_fkey" FOREIGN KEY ("new_inventory_item_id") REFERENCES "rental_inventory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_allocation_events" ADD CONSTRAINT "rental_allocation_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_inventory_status_events" ADD CONSTRAINT "rental_inventory_status_events_rental_inventory_item_id_fkey" FOREIGN KEY ("rental_inventory_item_id") REFERENCES "rental_inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_inventory_status_events" ADD CONSTRAINT "rental_inventory_status_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_requests" ADD CONSTRAINT "repair_requests_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_requests" ADD CONSTRAINT "repair_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_requests" ADD CONSTRAINT "repair_requests_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_requests" ADD CONSTRAINT "repair_requests_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "order_item_components"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_requests" ADD CONSTRAINT "repair_requests_rental_inventory_item_id_fkey" FOREIGN KEY ("rental_inventory_item_id") REFERENCES "rental_inventory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_status_events" ADD CONSTRAINT "repair_status_events_repair_request_id_fkey" FOREIGN KEY ("repair_request_id") REFERENCES "repair_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_status_events" ADD CONSTRAINT "repair_status_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "notification_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_history" ADD CONSTRAINT "notification_history_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "notification_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_history" ADD CONSTRAINT "notification_history_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_history" ADD CONSTRAINT "notification_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared_notes" ADD CONSTRAINT "shared_notes_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared_notes" ADD CONSTRAINT "shared_notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_task_actions" ADD CONSTRAINT "dashboard_task_actions_action_by_fkey" FOREIGN KEY ("action_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
