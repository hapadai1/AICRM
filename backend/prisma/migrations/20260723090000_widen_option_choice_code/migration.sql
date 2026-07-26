-- 선택지 코드 자리 확장: CHAR(1) → VARCHAR(2).
-- 구두는 부위별 단계 없이 완성 스타일 29종을 한 단계에 펼치므로 A~Z(26자)로는 모자라
-- AA~ 두 자리까지 쓴다. CHAR(1)은 뒤에 공백을 채우는 성질도 있어 VARCHAR로 바꾼다.
ALTER TABLE "option_choices" ALTER COLUMN "choice_code" TYPE VARCHAR(2);

-- CHAR(1) 시절 값에 공백이 붙어 있었다면 정리한다.
UPDATE "option_choices" SET "choice_code" = BTRIM("choice_code") WHERE "choice_code" <> BTRIM("choice_code");
