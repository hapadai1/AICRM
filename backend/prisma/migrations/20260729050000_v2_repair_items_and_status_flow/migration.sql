-- 수선 접수를 "품목 여러 줄(품목·개수)"로 바꾸고, 상태 흐름에서 '수선 중'을 뺀다.
--
-- 1) 접수 1건에 상의 1·하의 2처럼 여러 품목이 들어온다. 단일 target_product 컬럼으로는
--    표현할 수 없어 자식 테이블로 옮긴다.
-- 2) 상태 '수선 중'(IN_PROGRESS)은 담당자가 따로 누를 일이 없는 껍데기 단계였다.
--    업무 버튼(수선요청 완료·입고 완료·고객요청·출고 완료)과 1:1로 맞도록 흐름에서 뺀다.
--    접수 → 수선 요청 → 수선 입고 → 고객 연락 → 출고 완료.

-- 1) 품목·개수 테이블 ---------------------------------------------------------

CREATE TABLE "repair_request_items" (
  "id"                UUID PRIMARY KEY,
  "repair_request_id" UUID        NOT NULL,
  "target_product"    VARCHAR(30) NOT NULL,
  "quantity"          INTEGER     NOT NULL DEFAULT 1,
  "sequence_no"       INTEGER     NOT NULL,
  CONSTRAINT "repair_request_items_repair_request_id_fkey"
    FOREIGN KEY ("repair_request_id") REFERENCES "repair_requests"("id") ON DELETE CASCADE
);

CREATE INDEX "repair_request_items_repair_request_id_sequence_no_idx"
  ON "repair_request_items" ("repair_request_id", "sequence_no");

-- 기존 단일 대상 품목을 첫 줄(개수 1)로 옮긴다.
INSERT INTO repair_request_items (id, repair_request_id, target_product, quantity, sequence_no)
SELECT gen_random_uuid(), id, target_product, 1, 1
  FROM repair_requests
 WHERE target_product IS NOT NULL;

ALTER TABLE repair_requests DROP COLUMN "target_product";

-- 2) '수선 중' 상태 제거 -------------------------------------------------------

UPDATE repair_requests SET status = 'REQUESTED' WHERE status = 'IN_PROGRESS';

-- 이력: '수선 중' 진입 이벤트는 지우고, 그 뒤 이벤트의 직전 상태를 '수선 요청'으로 잇는다.
UPDATE repair_status_events SET previous_status = 'REQUESTED' WHERE previous_status = 'IN_PROGRESS';
DELETE FROM repair_status_events WHERE new_status = 'IN_PROGRESS';
