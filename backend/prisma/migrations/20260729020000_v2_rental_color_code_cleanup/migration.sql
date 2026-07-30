-- 컬러 코드에서 '3피스 / 2피스 / 상의'를 걷어낸다.
-- 이건 색 이름이 아니라 "그 색으로 몇 벌이 있는가"이고, 이미 component_types가 담고 있다.
--   BLACK_3P → 코드는 BLACK, "상의·하의·베스트로 있다"는 component_types가 말한다.
-- 셔츠·구두의 SHIRT_/SHOE_ 접두어는 남긴다 — 개수가 아니라 "어느 품목의 색인지"를
-- 가르는 구분이고, 코드가 전역 유일이라 화이트·블랙·브라운이 정장과 겹치기 때문이다.
--
-- 이름만 바꾸는 UPDATE로는 못 간다: 초기 시드가 남긴 BLACK·WHITE 등 예전 코드가
-- 비활성으로 아직 살아 있어 BLACK_3P → BLACK 이 UNIQUE 제약에 걸린다.
-- 렌탈 컬러·SKU·실물은 전부 시드가 결정론적으로 다시 만드는 카탈로그이므로
-- (앞 마이그레이션에서 이미 한 번 비웠다) 비우고 시드가 채우게 한다.
-- 배정이 걸린 실물이 있으면 FK가 막아 주므로 데이터를 조용히 잃지 않는다.

DELETE FROM rental_inventory_status_events;
DELETE FROM rental_inventory_items;
DELETE FROM rental_skus;
DELETE FROM rental_colors;
