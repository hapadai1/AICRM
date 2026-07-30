-- 폐기한 실물의 관리코드를 새 실물에 다시 쓸 수 있게 한다.
--
-- 옷에 붙은 코드표는 현장에서 재사용된다. 지금은 management_code가 전역 UNIQUE라
-- 폐기한 옷과 같은 코드로는 다시 등록할 수 없는데, 폐기 이력은 보존해야 하므로
-- 예전 행을 지울 수도 없다. → "살아 있는 실물들 사이에서만" 유일하도록 바꾼다.
--
-- 폐기(RETIRED) 행은 제약 밖에 있으므로 같은 코드가 이력으로 여러 벌 쌓여도 된다.

DROP INDEX IF EXISTS "rental_inventory_items_management_code_key";

CREATE UNIQUE INDEX "rental_inventory_items_management_code_active_key"
  ON rental_inventory_items (management_code)
  WHERE status <> 'RETIRED';

-- 폐기 행까지 훑는 조회(이력 확인)를 위해 일반 인덱스도 남긴다.
CREATE INDEX "rental_inventory_items_management_code_idx"
  ON rental_inventory_items (management_code);
