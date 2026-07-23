-- CreateTable
CREATE TABLE "master_code_labels" (
    "id" UUID NOT NULL,
    "domain" VARCHAR(40) NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "master_code_labels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "master_code_labels_domain_code_key" ON "master_code_labels"("domain", "code");
