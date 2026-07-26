-- 수선 접수 시 자동 생성되는 REPAIR 진행 트랙 ↔ RepairRequest 연결 (설계서 02 §7.2·§9.2)
-- 신규 nullable 컬럼 + 부분 unique(접수 1건 = 진행 1건). 무손상.

-- AlterTable
ALTER TABLE "customer_journeys" ADD COLUMN "source_repair_request_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "customer_journeys_source_repair_request_id_key" ON "customer_journeys"("source_repair_request_id");

-- AddForeignKey
ALTER TABLE "customer_journeys" ADD CONSTRAINT "customer_journeys_source_repair_request_id_fkey" FOREIGN KEY ("source_repair_request_id") REFERENCES "repair_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
