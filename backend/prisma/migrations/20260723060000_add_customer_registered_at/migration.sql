-- 고객 정식 등록 시각. 예약으로 자동 생성된 고객(PROSPECT)은 null = 미등록이며 고객 목록에서 제외된다.
ALTER TABLE "customers" ADD COLUMN "registered_at" TIMESTAMPTZ(6);

-- 기존 데이터 보정:
--  1) 계약 고객은 이미 정식 고객이므로 계약 시각(없으면 생성 시각)으로 등록 처리
UPDATE "customers"
SET "registered_at" = COALESCE("contracted_at", "created_at")
WHERE "customer_status" = 'CONTRACTED';

--  2) 예약 이력이 전혀 없는 고객은 수동 등록된 고객이므로 생성 시각으로 등록 처리
UPDATE "customers" c
SET "registered_at" = c."created_at"
WHERE c."registered_at" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "appointments" a WHERE a."customer_id" = c."id");

-- 나머지(예약만 있고 계약 없는 고객)는 null로 남아 [예약 고객 등록] 대상이 된다.
CREATE INDEX "customers_registered_at_idx" ON "customers" ("registered_at");
