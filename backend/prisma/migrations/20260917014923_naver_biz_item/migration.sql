-- 네이버 예약 메뉴 원본 보존 (NAVER 출처 예약만 값이 있다).
-- 예약 목적은 CRM 공통 코드로 합쳐져 "예복상담"·"비즈니스 맞춤정장"이 모두 맞춤 상담이 되므로,
-- 네이버 메뉴별로 나눠 보려면 원본이 필요하다.
ALTER TABLE "appointments" ADD COLUMN "naver_biz_item_id" VARCHAR(40),
ADD COLUMN "naver_biz_item_name" VARCHAR(100);

CREATE INDEX "appointments_naver_biz_item_name_idx" ON "appointments"("naver_biz_item_name");
