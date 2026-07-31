-- 계약 라인 베스트(3피스) 필드 (현업 확정 2026-07-30).
--
-- 베스트 추가는 계약서 품목표에서 한다: 정장 라인의 [베스트 제외] 체크를 풀면
-- 베스트 단가 입력이 열리고, 금액 = 수량 × (단가 + 베스트 단가)로 계산된다.
-- 컨설팅 중 베스트를 빼면(옵션 화면 [옵션 선택 안함]) 이 단가만큼 자동 차감한다.
--
-- 기존 라인은 전부 vest_included = false(2피스)로 남는다 — 지금까지 계약 품목에
-- VEST 부위가 만들어진 적이 없으므로 데이터 정합이 그대로 맞는다.
ALTER TABLE "contract_lines"
  ADD COLUMN "vest_included" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "vest_unit_price" DECIMAL(14,2);
