-- 수선 진행을 품목별로 쪼갠다 (현업 확정 2026-08-01).
--
-- 지금까지 수선은 건 하나에 상태 하나였다. 상의만 먼저 수선집에서 돌아와도 건 전체를
-- '수선 입고'로 넘기거나 아예 안 넘기거나 둘 중 하나라, 여러 벌을 맡긴 건의 진행을
-- 화면만 보고는 알 수 없었다.
--
--  - 수선요청은 접수 줄 단위(상의 2를 한 번에 보낸다)
--  - 입고·출고는 벌 단위 — 수량만큼 유닛을 만들어 각각 누른다
--  - 건 상태는 더 이상 손으로 누르지 않는다. 줄·유닛 진행에서 계산한다(고객 연락만 수동).

-- 1) 수선요청 완료 시점 (줄 단위)
ALTER TABLE "repair_request_items" ADD COLUMN "requested_at" DATE;

-- 2) 입고·출고 단위. PENDING(대기) → RETURNED(입고 완료) → RELEASED(출고 완료)
CREATE TABLE "repair_request_item_units" (
  "id" UUID NOT NULL,
  "repair_request_item_id" UUID NOT NULL,
  "unit_no" INTEGER NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  CONSTRAINT "repair_request_item_units_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "repair_request_item_units_repair_request_item_id_unit_no_key"
  ON "repair_request_item_units" ("repair_request_item_id", "unit_no");

ALTER TABLE "repair_request_item_units"
  ADD CONSTRAINT "repair_request_item_units_repair_request_item_id_fkey"
  FOREIGN KEY ("repair_request_item_id") REFERENCES "repair_request_items" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 3) 이력은 기존 표에 그대로 쌓는다 — 건 단위 이벤트는 두 컬럼이 모두 NULL이라
--    지금까지 쌓인 이력의 의미가 바뀌지 않는다.
ALTER TABLE "repair_status_events" ADD COLUMN "repair_request_item_id" UUID;
ALTER TABLE "repair_status_events" ADD COLUMN "repair_request_item_unit_id" UUID;

ALTER TABLE "repair_status_events"
  ADD CONSTRAINT "repair_status_events_repair_request_item_id_fkey"
  FOREIGN KEY ("repair_request_item_id") REFERENCES "repair_request_items" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "repair_status_events"
  ADD CONSTRAINT "repair_status_events_repair_request_item_unit_id_fkey"
  FOREIGN KEY ("repair_request_item_unit_id") REFERENCES "repair_request_item_units" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 4) 기존 건 이관: 건의 현재 상태를 줄·유닛에 그대로 복사한다.
--    수량만큼 유닛을 만들고(상의 2 → #1·#2), 건이 어디까지 갔는지에 따라 상태를 맞춘다.
INSERT INTO "repair_request_item_units" ("id", "repair_request_item_id", "unit_no", "status")
SELECT
  gen_random_uuid(),
  i."id",
  n,
  CASE
    WHEN r."status" = 'RELEASED' THEN 'RELEASED'
    WHEN r."status" IN ('RETURNED_TO_SHOP', 'CUSTOMER_NOTIFIED') THEN 'RETURNED'
    ELSE 'PENDING'
  END
FROM "repair_request_items" i
JOIN "repair_requests" r ON r."id" = i."repair_request_id"
CROSS JOIN LATERAL generate_series(1, GREATEST(i."quantity", 1)) AS n;

-- 수선요청을 지났으면(취소 제외) 줄도 요청 완료로 본다. 날짜는 그 단계 이벤트가 있으면
-- 그 날짜, 없으면 접수일로 채운다 — 없는 날짜를 지어내지 않는다.
UPDATE "repair_request_items" i
SET "requested_at" = COALESCE(
  (
    SELECT MAX(e."event_date")
    FROM "repair_status_events" e
    WHERE e."repair_request_id" = i."repair_request_id" AND e."new_status" = 'REQUESTED'
  ),
  r."request_date"
)
FROM "repair_requests" r
WHERE r."id" = i."repair_request_id"
  AND r."status" IN ('REQUESTED', 'RETURNED_TO_SHOP', 'CUSTOMER_NOTIFIED', 'RELEASED');
