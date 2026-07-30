-- 계약 상태를 4개로 줄인다 (현업 확정 2026-07-30).
--
-- 새 흐름: DRAFT(작성중) → SIGNED(서명완료) → COMPLETED(계약완료) → 수정하기(버전업) → DRAFT …
-- 없어진 상태:
--   CONFIRMED(등록) — 컨설팅이 작성중 단계로 내려와 등록을 앞세울 이유가 사라졌다.
--   CHANGED(변경 확정) — 재서명이 그 역할을 대신한다.
--
-- 기존 데이터 정합화: CONFIRMED·CHANGED 계약은 이미 주문으로 물리화된(주문·주문품목이 있는)
-- 계약이므로 새 모델에서 가장 가까운 상태는 COMPLETED다. 상태 문자열만 옮기고
-- 주문·품목·컨설팅 데이터는 건드리지 않는다.

UPDATE "contracts"
SET "status" = 'COMPLETED'
WHERE "status" IN ('CONFIRMED', 'CHANGED');

-- 계약일이 비어 있는 완료 계약은 확정 버전의 확정 시각으로 채운다(목록 기간 조회 기준).
UPDATE "contracts" c
SET "contracted_at" = v."confirmed_at"
FROM "contract_versions" v
WHERE v."id" = c."current_version_id"
  AND c."status" = 'COMPLETED'
  AND c."contracted_at" IS NULL
  AND v."confirmed_at" IS NOT NULL;
