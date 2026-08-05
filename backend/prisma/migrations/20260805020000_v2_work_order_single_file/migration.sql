-- 작업지시서를 버전 없이 파일 하나로 (현업 확정 2026-08-05).
--
-- 출력할 때마다 버전을 쌓고 스냅샷·해시를 남겼는데, **발주하면 옵션도 채촌도 잠기므로**
-- 뒤에 내용이 바뀔 길이 없어 버전이 늘 이유가 없었다. 제작 관리에도 리비전 개념이 없다.
-- 그래서 채촌처럼 파일 하나로 두고 다시 뽑으면 덮어쓴다.
--
-- 상태는 둘뿐이다: 작성중(DRAFT) → 완료(COMPLETED). 발주가 완료로 만든다.
ALTER TABLE "work_orders"
  ADD COLUMN "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "output_file_id" UUID,
  ADD COLUMN "issued_at" TIMESTAMPTZ(6),
  ADD COLUMN "issued_by" UUID,
  ADD COLUMN "uploaded_file_id" UUID,
  ADD COLUMN "uploaded_at" TIMESTAMPTZ(6),
  ADD COLUMN "uploaded_by" UUID,
  ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- 현재본만 옮긴다 — 지난 버전은 버린다(이력은 감사로그에 남는다).
UPDATE "work_orders" w
SET "output_file_id" = v."output_file_id",
    "issued_at"      = v."issued_at",
    "issued_by"      = v."issued_by",
    "uploaded_file_id" = v."uploaded_file_id",
    "uploaded_at"    = v."uploaded_at",
    "uploaded_by"    = v."uploaded_by",
    "status"         = 'COMPLETED'
FROM "work_order_versions" v
WHERE v."id" = w."current_version_id";

ALTER TABLE "work_orders" DROP COLUMN "current_version_id";
DROP TABLE "work_order_versions";

ALTER TABLE "work_orders"
  ADD CONSTRAINT "work_orders_output_file_id_fkey"
  FOREIGN KEY ("output_file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "work_orders"
  ADD CONSTRAINT "work_orders_uploaded_file_id_fkey"
  FOREIGN KEY ("uploaded_file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "work_orders"
  ADD CONSTRAINT "work_orders_issued_by_fkey"
  FOREIGN KEY ("issued_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "work_orders"
  ADD CONSTRAINT "work_orders_uploaded_by_fkey"
  FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
