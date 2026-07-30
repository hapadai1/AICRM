-- 계약 품목을 버전 소유에서 계약 소유로 옮긴다 (현업 확정 2026-07-30).
--
-- 수정하기(버전업)는 계약서 문서의 버전업이다. 품목과 그에 딸린 컨설팅 선택·주문품목·
-- 작업지시서·입출고는 계약이 살아 있는 동안 이어져야 하는데, 품목이 버전에 매달려 있어서
-- 버전업마다 새 품목이 생기고 연결이 끊겼다(주문품목 중복 생성). 소유를 계약으로 바꾼다.
-- 버전별 수량·금액 이력은 contract_lines 가 그대로 갖는다.

ALTER TABLE "contract_items" ADD COLUMN "contract_id" UUID;

-- 기존 품목: 소속 버전이 가리키는 계약으로 채운다.
UPDATE "contract_items" ci
SET "contract_id" = cv."contract_id"
FROM "contract_versions" cv
WHERE cv."id" = ci."contract_version_id";

-- 같은 계약에 여러 버전의 품목이 남아 있으면 유니크 키(계약·거래방식·품목·순번)가 충돌한다.
-- 가장 최근 버전의 품목만 남기고, 옛 버전의 중복 품목은 제거한다(개발 데이터 기준).
DELETE FROM "contract_item_components"
WHERE "contract_item_id" IN (
  SELECT ci."id"
  FROM "contract_items" ci
  JOIN "contract_versions" cv ON cv."id" = ci."contract_version_id"
  WHERE EXISTS (
    SELECT 1
    FROM "contract_items" ci2
    JOIN "contract_versions" cv2 ON cv2."id" = ci2."contract_version_id"
    WHERE ci2."contract_id" = ci."contract_id"
      AND ci2."transaction_type" = ci."transaction_type"
      AND ci2."product_category" = ci."product_category"
      AND ci2."sequence_no" = ci."sequence_no"
      AND cv2."version_no" > cv."version_no"
  )
);

DELETE FROM "contract_items" ci
USING "contract_versions" cv
WHERE cv."id" = ci."contract_version_id"
  AND EXISTS (
    SELECT 1
    FROM "contract_items" ci2
    JOIN "contract_versions" cv2 ON cv2."id" = ci2."contract_version_id"
    WHERE ci2."contract_id" = ci."contract_id"
      AND ci2."transaction_type" = ci."transaction_type"
      AND ci2."product_category" = ci."product_category"
      AND ci2."sequence_no" = ci."sequence_no"
      AND cv2."version_no" > cv."version_no"
  );

-- 계약을 못 찾은 고아 품목은 남길 수 없다(NOT NULL 전환).
DELETE FROM "contract_item_components"
WHERE "contract_item_id" IN (SELECT "id" FROM "contract_items" WHERE "contract_id" IS NULL);
DELETE FROM "contract_items" WHERE "contract_id" IS NULL;

ALTER TABLE "contract_items" ALTER COLUMN "contract_id" SET NOT NULL;

DROP INDEX IF EXISTS "contract_items_contract_version_id_idx";
DROP INDEX IF EXISTS "contract_items_contract_version_id_transaction_type_product_key";
ALTER TABLE "contract_items" DROP CONSTRAINT IF EXISTS "contract_items_contract_version_id_fkey";
ALTER TABLE "contract_items" DROP COLUMN "contract_version_id";

CREATE INDEX "contract_items_contract_id_idx" ON "contract_items"("contract_id");
CREATE UNIQUE INDEX "contract_items_contract_id_transaction_type_product_categor_key"
  ON "contract_items"("contract_id", "transaction_type", "product_category", "sequence_no");
ALTER TABLE "contract_items"
  ADD CONSTRAINT "contract_items_contract_id_fkey"
  FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
