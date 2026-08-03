-- 반납 후 정비(세탁) 기간을 색 계열로 가른다 (현업 확정 2026-08-01).
--
-- 렌탈이 입고되면 세탁 여부를 확인해야 해서 바로 다시 빌려줄 수 없다. 화이트·베이지
-- 계열은 오염이 그대로 보여 +2일, 나머지(블랙 타입)는 +1일이면 된다.
-- 지금까지는 반납 화면이 무조건 "오늘+2일"을 프리필했을 뿐 근거가 없었다.

-- 1) 색 계열: LIGHT(화이트·베이지 계열) / DARK(그 외). 기본은 DARK.
ALTER TABLE "rental_colors" ADD COLUMN "tone" VARCHAR(10) NOT NULL DEFAULT 'DARK';

-- 화이트·베이지 그 자체인 색만 LIGHT다. 숄카라·스트라이프는 바탕이 화이트/베이지라
-- 원색과 같이 묶고, 셔츠 흰색도 세탁이 확실히 필요해 포함한다.
-- 그레이·카키·하운투스는 블랙 타입으로 둔다(현업 확정) — 밝기가 애매하면 관리자 화면에서 바꾼다.
UPDATE "rental_colors"
SET "tone" = 'LIGHT'
WHERE "code" IN ('WHITE', 'WHITE_SHAWL', 'BEIGE', 'BEIGE_STRIPE', 'SHIRT_WHITE');

-- 2) 정비 기준. 매장이 하나라 기준도 하나 — 항상 단일 행이며 id는 서버 상수와 같다.
CREATE TABLE "rental_return_policies" (
  "id" UUID NOT NULL,
  "light_cleaning_days" INTEGER NOT NULL DEFAULT 2,
  "dark_cleaning_days" INTEGER NOT NULL DEFAULT 1,
  "auto_release" BOOLEAN NOT NULL DEFAULT true,
  "updated_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rental_return_policies_pkey" PRIMARY KEY ("id")
);

INSERT INTO "rental_return_policies" ("id", "light_cleaning_days", "dark_cleaning_days", "auto_release")
VALUES ('00000000-0000-4000-8000-00000000c1ea', 2, 1, true)
ON CONFLICT ("id") DO NOTHING;
