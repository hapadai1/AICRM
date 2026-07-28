-- 계약 완료 시점 계약서 엑셀 보관 (설계서 03 M3 확정 2026-07-28).
-- 완료 전에는 null이며, 그때까지 다운로드는 즉석 생성본을 내려준다.
ALTER TABLE "contract_versions" ADD COLUMN "excel_file_id" UUID;

ALTER TABLE "contract_versions"
  ADD CONSTRAINT "contract_versions_excel_file_id_fkey"
  FOREIGN KEY ("excel_file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
