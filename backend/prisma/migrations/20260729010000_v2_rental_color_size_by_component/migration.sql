-- 렌탈 재고 재정의 (현업 확정 데이터 반영)
--  1) 디자인 축 폐기 — 실물은 '구분 + 컬러 + 사이즈'로만 식별한다.
--  2) 컬러·사이즈를 품목별로 가른다 — 사이즈 체계가 품목마다 달라(상의 46~60, 하의 80~104,
--     셔츠 95~120, 구두 250~280) 한 목록을 공유하면 등록 화면에 남의 사이즈가 섞인다.
--  3) 기존 렌탈 데이터는 예시값이라 전부 비우고 확정 데이터로 다시 채운다(시드).
--     주문·계약은 건드리지 않는다 — 렌탈 배정만 사라진다.

-- 1. 렌탈 데이터 전체 삭제 (FK 역순: 이벤트 → 배정/선택 → 실물 → SKU)
DELETE FROM rental_selection_lines;
DELETE FROM rental_selection_sessions;
DELETE FROM rental_allocation_events;
DELETE FROM rental_allocations;
DELETE FROM rental_inventory_status_events;
DELETE FROM rental_inventory_items;
DELETE FROM rental_skus;

-- 2. 디자인 축 제거. 기존 인덱스는 design을 포함하므로 먼저 걷어낸다.
DROP INDEX IF EXISTS "rental_skus_component_type_design_color_size_idx";
ALTER TABLE rental_skus DROP COLUMN design;

-- 구분+컬러+사이즈는 이제 SKU를 유일하게 식별한다. 동시 등록으로 같은 SKU가
-- 두 벌 생기던 findOrCreate 경합을 DB 수준에서 막는다.
CREATE UNIQUE INDEX "rental_skus_component_type_color_size_key"
  ON rental_skus (component_type, color, size);

-- 3. 품목별 컬러·사이즈. 빈 배열이면 전 품목 공통으로 읽는다.
ALTER TABLE rental_colors ADD COLUMN component_types text[] NOT NULL DEFAULT '{}';
ALTER TABLE rental_sizes ADD COLUMN component_types text[] NOT NULL DEFAULT '{}';

-- 기존 컬러·사이즈 행도 확정 목록과 맞지 않는 예시값이다. 물리삭제 대신 비활성으로
-- 내려두고(과거 참조 보존), 시드가 확정 코드를 새로 넣는다.
UPDATE rental_colors SET active = false;
UPDATE rental_sizes SET active = false;
