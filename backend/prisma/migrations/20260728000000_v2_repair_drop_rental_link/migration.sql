-- 수선에서 렌탈 흔적 제거: repair_requests.rental_inventory_item_id 컬럼 삭제.
-- 렌탈 수선은 렌탈 진행(RENTAL 트랙 수선요청·입고·출고)에서 관리하므로
-- 수선 도메인은 렌탈 실물을 접수 대상으로도, 표시 대상으로도 다루지 않는다.

-- 이관 전 데이터가 남아 있는 환경을 위해, 어떤 실물이었는지는 수선 내용 앞에 보존한다.
UPDATE "repair_requests" r
   SET "description" = i."management_code" || ' ' || r."description"
  FROM "rental_inventory_items" i
 WHERE r."rental_inventory_item_id" = i."id"
   AND POSITION(i."management_code" IN r."description") = 0;

-- FK 제약도 컬럼과 함께 제거된다.
ALTER TABLE "repair_requests" DROP COLUMN "rental_inventory_item_id";
