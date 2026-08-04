-- 계약 라인 옵션 추가금액 롤업 플래그 (스타일 컨설팅 반영, 2026-08-04).
--
-- 스타일 컨설팅에서 고른 옵션의 추가금액을 모두 합쳐 계약 품목 리스트 맨 아래에
-- '옵션(추가금액)' 한 줄로 싣기 위한 시스템 라인 식별자다. 이 라인은 백엔드
-- (syncOptionRollupLine)가 확정 세션들의 추가금액 합계로 소유·재생성하며,
-- 화면 편집·저장 본문·컨설팅 대상 품목(ContractItem)·주문 물리화·계약서 출력
-- 라인에서는 제외한다. 기존 라인은 전부 false(일반 품목)로 남는다.
ALTER TABLE "contract_lines"
  ADD COLUMN "is_option_rollup" BOOLEAN NOT NULL DEFAULT false;
