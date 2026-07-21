-- AlterTable: 실제 발송 채널·본문·재시도 원본을 이력에 보존한다.
ALTER TABLE "notification_history" ADD COLUMN     "body" TEXT,
ADD COLUMN     "channel" VARCHAR(20) NOT NULL DEFAULT 'ALIMTALK',
ADD COLUMN     "retry_of_id" UUID;

-- 기존 이력의 채널은 템플릿 채널로 보정한다.
UPDATE "notification_history" h
SET "channel" = t."channel"
FROM "notification_templates" t
WHERE h."template_id" = t."id";

-- AlterTable: 템플릿 표시명. 기존 행은 코드로 백필한 뒤 NOT NULL로 승격한다.
ALTER TABLE "notification_templates" ADD COLUMN "name" VARCHAR(120);
UPDATE "notification_templates" SET "name" = "code" WHERE "name" IS NULL;
ALTER TABLE "notification_templates" ALTER COLUMN "name" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "notification_history" ADD CONSTRAINT "notification_history_retry_of_id_fkey" FOREIGN KEY ("retry_of_id") REFERENCES "notification_history"("id") ON DELETE SET NULL ON UPDATE CASCADE;
