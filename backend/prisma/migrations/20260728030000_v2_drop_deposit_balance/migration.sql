-- 계약금·잔금 제거 (현업 확정 2026-07-28).
-- 거래가 전부 일시불이라 계약금·잔금 개념을 쓰지 않는다. 총액(total_amount)만 남긴다.
-- 결제 기능 제거(D6)와 같은 취지의 명시적 제거다.
ALTER TABLE "contract_versions" DROP COLUMN "deposit_amount";
ALTER TABLE "contract_versions" DROP COLUMN "balance_amount";
ALTER TABLE "contracts" DROP COLUMN "balance_due_date";
