-- 고객 연락을 상태(CUSTOMER_NOTIFIED)에서 발송 액션으로 분리한다.
-- 상태로 남기지 않고, 마지막 발송 시각만 repair_requests에 찍는다(값이 있으면 [재발송]).

ALTER TABLE "repair_requests" ADD COLUMN "last_notified_at" TIMESTAMPTZ(6);

-- 기존에 CUSTOMER_NOTIFIED 상태로 남아 있던 건은, 그 전이 시각을 마지막 발송 시각으로 옮기고
-- 상태 자체는 수선 입고(RETURNED_TO_SHOP)로 되돌린다 — 고객 연락은 더는 상태가 아니다.
UPDATE "repair_requests" r
SET "last_notified_at" = e.max_date
FROM (
  SELECT "repair_request_id", MAX("created_at") AS max_date
  FROM "repair_status_events"
  WHERE "new_status" = 'CUSTOMER_NOTIFIED'
  GROUP BY "repair_request_id"
) e
WHERE r."id" = e."repair_request_id";

UPDATE "repair_requests"
SET "status" = 'RETURNED_TO_SHOP'
WHERE "status" = 'CUSTOMER_NOTIFIED';
