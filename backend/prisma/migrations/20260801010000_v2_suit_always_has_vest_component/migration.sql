-- 정장은 맞춤·렌탈 모두 상의·하의·베스트 세 부위로 만든다 (현업 확정 2026-08-01).
--
-- 계약서는 더 이상 베스트를 다루지 않는다. 계약 시점에는 3피스로 갈지 알 수 없고 베스트
-- 값도 그때그때 달라, 벌마다 뺄지 말지는 스타일 컨설팅의 [베스트 제외] 체크로 정한다.
--
-- 지금까지 렌탈 정장은 상의·하의만 만들어져서, 렌탈 재고에 베스트 SKU가 있는데도
-- 3피스를 빌려줄 자리가 없었다. 진행 중인 계약까지 소급해 채운다(현업 확정 2026-08-01).
-- 이미 베스트 부위가 있는 벌(취소분 포함)은 건드리지 않는다 — 컨설팅에서 뺀 결정을
-- 되살리면 안 되므로 status 를 보지 않고 '행이 있는가'로만 가른다.
INSERT INTO "contract_item_components" (id, contract_item_id, component_type, sequence_no, status, created_at, updated_at)
SELECT gen_random_uuid(), ci.id, 'VEST', 1, 'CREATED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "contract_items" ci
WHERE ci.product_category = 'SUIT'
  AND ci.status <> 'CANCELLED'
  AND NOT EXISTS (
    SELECT 1 FROM "contract_item_components" c
    WHERE c.contract_item_id = ci.id AND c.component_type = 'VEST'
  );
