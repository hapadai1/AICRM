-- 작업지시서 수기 최종본 보관 (현업 확정 2026-08-05).
--
-- 시스템이 뽑아 준 Excel을 담당자가 손으로 고쳐 공장에 보내는 일이 있다. 그러면 실제로 나간
-- 서류는 시스템에 없는 파일이 되어, 나중에 "무엇을 보고 만들었나"를 확인할 길이 사라졌다.
--
-- 버전을 새로 만들지 않고 **같은 버전에 파일 하나를 더 다는** 방식이다. 버전 번호가
-- `생성 V1 / 업로드 V1` 두 갈래로 갈리면 지금 공장에 나간 것이 몇 번인지 흐려지기 때문이다.
-- 한 발주(=한 버전)에 서류는 하나가 최종이다.
--
-- 시스템은 이 파일을 **읽지 않는다** — 값을 꺼내거나 대조하지 않고 보관만 한다.
ALTER TABLE "work_order_versions"
  ADD COLUMN "uploaded_file_id" UUID,
  ADD COLUMN "uploaded_by" UUID,
  ADD COLUMN "uploaded_at" TIMESTAMPTZ(6);

ALTER TABLE "work_order_versions"
  ADD CONSTRAINT "work_order_versions_uploaded_file_id_fkey"
  FOREIGN KEY ("uploaded_file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "work_order_versions"
  ADD CONSTRAINT "work_order_versions_uploaded_by_fkey"
  FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
