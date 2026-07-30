-- 수선 대상을 계약 등록 품목 연결에서 "품목 자유 선택"으로 바꾼다.
--
-- 수선은 우리가 만든 옷만 들어오지 않는다. 접수 화면에서 그 고객의 주문 품목·구성품을
-- 찾아 연결하도록 강제하니, 계약 이력이 없거나 구성품으로 쪼개지지 않은 물건은 접수가 막혔다.
-- → 상의/하의/베스트/셔츠/구두(component-type 코드) 중에서 그냥 고른다.
--
-- order_item_id·component_id 컬럼은 남긴다 — 이전 방식으로 접수된 건의 연결 이력이다.

ALTER TABLE repair_requests ADD COLUMN "target_product" VARCHAR(30);

-- 기존 행은 연결돼 있던 구성품/품목에서 대상 품목을 채워 목록 표시가 비지 않게 한다.
UPDATE repair_requests r
   SET target_product = c.component_type
  FROM order_item_components c
 WHERE r.component_id = c.id;

UPDATE repair_requests r
   SET target_product = CASE i.product_category
                          WHEN 'SHIRT' THEN 'SHIRT'
                          WHEN 'SHOES' THEN 'SHOES'
                          ELSE NULL
                        END
  FROM order_items i
 WHERE r.target_product IS NULL
   AND r.order_item_id = i.id;
