-- 매장 계약서 양식(슈트에이전시 계약서) 기재 항목.
-- 결제방법·입금자명·결제날짜·무상 AS 기간·메모·특약 2종·체크리스트 동의,
-- 그리고 계약담당자 서명("위 내용을 전달하였습니다")을 고객 서명과 함께 받는다.
ALTER TABLE "contract_versions"
  ADD COLUMN "payment_method" VARCHAR(20),
  ADD COLUMN "depositor_name" VARCHAR(80),
  ADD COLUMN "payment_date" DATE,
  ADD COLUMN "as_period" VARCHAR(20) NOT NULL DEFAULT 'SIX_MONTHS',
  ADD COLUMN "memo" TEXT,
  ADD COLUMN "urgent_production_term" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "tr_fabric_term" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "checklist_agreed_at" TIMESTAMPTZ(6),
  ADD COLUMN "staff_signature_file_id" UUID,
  ADD COLUMN "staff_signer_id" UUID,
  ADD COLUMN "staff_signer_name" VARCHAR(80),
  ADD COLUMN "staff_signed_at" TIMESTAMPTZ(6);

ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_staff_signature_file_id_fkey" FOREIGN KEY ("staff_signature_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_staff_signer_id_fkey" FOREIGN KEY ("staff_signer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
