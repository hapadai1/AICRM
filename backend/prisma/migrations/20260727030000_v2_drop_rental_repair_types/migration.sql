-- 수선구분에서 렌탈 유형(RENTAL_PRE·RENTAL_POST) 제거.
-- 렌탈 수선은 수선 도메인이 아니라 렌탈 진행(RENTAL 트랙 수선요청·입고·출고)에서 관리한다.

-- 기존 접수 건은 일반 수선으로 이관한다.
-- 어떤 실물의 수선이었는지는 rental_inventory_item_id 연결로 이력에 그대로 남는다.
UPDATE "repair_requests"
   SET "repair_type" = 'GENERAL'
 WHERE "repair_type" IN ('RENTAL_PRE', 'RENTAL_POST');

-- 관리자 화면에서 바꿔둔 표시명 오버라이드도 함께 정리한다.
DELETE FROM "master_code_labels"
 WHERE "domain" = 'repair-type'
   AND "code" IN ('RENTAL_PRE', 'RENTAL_POST');
