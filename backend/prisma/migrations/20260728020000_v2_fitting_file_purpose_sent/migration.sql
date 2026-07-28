-- 가봉 첨부의 용도 태그 정정 (현업 확정 2026-07-28).
-- 이 첨부는 "공장이 회신한 파일"이 아니라 "공장에 보낸 가봉 작업지시서"의 보관본이다.
-- 값 태그만 바꾸는 것이라 파일·링크는 그대로 유지된다.
UPDATE "entity_files"
   SET "purpose" = 'FACTORY_SENT'
 WHERE "entity_type" = 'FITTING_SESSION'
   AND "purpose" = 'FACTORY_REPLY';
