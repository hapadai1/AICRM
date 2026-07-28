-- 정장 옵션 단계의 부위(component_group) 백필 — 설계서 04 §3.2 / §9-2.
-- 20260726143418_v2_style_consulting에서 컬럼만 추가하고 백필이 빠져 있었다.
-- 부위가 NULL이면 스타일 컨설팅 목록의 상의/하의/베스트 행에 단계가 갈리지 않는다.
--
-- 규칙(stage_code 접두):
--   TROUSER_*        → TROUSERS (하의)
--   VEST_*           → VEST     (베스트)
--   그 외 정장 단계  → JACKET   (상의: JACKET_BUTTON/LAPEL/POCKET/VENT/SLEEVE_BUTTON/STITCH/LINING…)
-- 셔츠·구두 세트는 단일 부위라 NULL로 둔다.
-- 버전 상태(DRAFT/ACTIVE/RETIRED)를 가리지 않고 적용한다 — 과거 확정 세션의 확인서도
-- 같은 부위 축으로 보여야 한다. 값이 이미 있는 단계는 건드리지 않는다.

UPDATE "option_stages" s
SET "component_group" = CASE
    WHEN s."stage_code" LIKE 'TROUSER%' THEN 'TROUSERS'
    WHEN s."stage_code" LIKE 'VEST%'    THEN 'VEST'
    ELSE 'JACKET'
  END
FROM "option_set_versions" v
JOIN "option_sets" os ON os."id" = v."option_set_id"
WHERE s."option_set_version_id" = v."id"
  AND os."product_category" = 'SUIT'
  AND s."component_group" IS NULL;
