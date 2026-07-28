-- v2 설계서 07 §5 — 고객 식별 통합 (D2)
--
-- 예약으로 자동 생성된 "미등록 고객"(registered_at IS NULL) 개념을 폐기한다.
-- 접점이 생긴 사람은 모두 고객으로 등록하고, 화면마다 필요한 고객만 골라 보여준다.
--
-- registered_at 컬럼은 감사로그 before/after 스냅샷에 이미 기록되어 있어 drop하지 않는다.
-- 의미만 "고객 행이 생성된 시각"으로 재정의하고 기존 NULL을 백필한다.
-- 등록 시각은 최초 예약일이 있으면 그것을, 없으면 행 생성 시각을 쓴다.
--
-- DDL 없음(데이터 백필만). 되돌릴 필요가 없다 — registered_at이 채워져도
-- 조회 조건에서 이 컬럼을 더 이상 쓰지 않으므로 어떤 기능도 영향받지 않는다.

UPDATE "customers"
   SET "registered_at" = COALESCE("registered_at", "first_reserved_at", "created_at")
 WHERE "registered_at" IS NULL;
