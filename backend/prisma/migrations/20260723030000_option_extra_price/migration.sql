-- 옵션 선택지 추가금액
-- - option_choices.extra_price: 마스터 단가
-- - option_selection_values.extra_price_snapshot: 선택 시점 단가 복사본(마스터 변경에 영향받지 않음)
-- - option_selection_sessions.surcharge_applied(_at): 계약금액에 반영한 누계(계약 버전은 올리지 않는다)

ALTER TABLE "option_choices"
  ADD COLUMN "extra_price" DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE "option_selection_values"
  ADD COLUMN "extra_price_snapshot" DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE "option_selection_sessions"
  ADD COLUMN "surcharge_applied" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "surcharge_applied_at" TIMESTAMPTZ(6);
