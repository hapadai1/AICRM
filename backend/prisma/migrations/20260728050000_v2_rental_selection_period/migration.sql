-- 렌탈 스타일 선택에 대여 기간 추가 (현업 확정 2026-07-28: 대여 날짜는 필수값).
-- 기존 행을 살리려고 컬럼은 nullable로 두고, 후보 검색·확정 시점에 앱이 필수 검증한다.
ALTER TABLE "rental_selection_sessions" ADD COLUMN "pickup_date" DATE;
ALTER TABLE "rental_selection_sessions" ADD COLUMN "return_due_date" DATE;
