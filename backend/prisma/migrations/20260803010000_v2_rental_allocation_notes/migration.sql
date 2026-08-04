-- 대여 건에 붙는 비고 — 연락·회신·변경·메모 (현업 확정 2026-08-03).
--
-- 발송 이력(notification_history)은 고객·주문까지만 엮여 있어 "이 대여 건에 몇 번 연락했나"를
-- 셀 수 없었고, 보낸 사람도 감사로그에만 남아 목록에서 쓸 수 없었다. 전화로 받은 답을 적을 곳도
-- 없었다. 반납일이 밀리는 사정도 배정 기간을 고치지 않고 여기에만 남긴다 — 원래 기간으로
-- 걸어 둔 기간 잠금(rental_allocation_no_overlap)을 흔들지 않으려는 것이다.
CREATE TABLE "rental_allocation_notes" (
  "id" UUID NOT NULL,
  "rental_allocation_id" UUID NOT NULL,
  -- CONTACT(연락 발송) · REPLY(고객 회신) · CHANGE(반납일 등 변경) · MEMO
  "kind" VARCHAR(20) NOT NULL,
  "body" TEXT NOT NULL,
  "actor_id" UUID NOT NULL,
  "notification_history_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rental_allocation_notes_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "rental_allocation_notes"
  ADD CONSTRAINT "rental_allocation_notes_rental_allocation_id_fkey"
  FOREIGN KEY ("rental_allocation_id") REFERENCES "rental_allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "rental_allocation_notes"
  ADD CONSTRAINT "rental_allocation_notes_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "rental_allocation_notes"
  ADD CONSTRAINT "rental_allocation_notes_notification_history_id_fkey"
  FOREIGN KEY ("notification_history_id") REFERENCES "notification_history"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 목록은 건별 최근 한 줄만 뽑아 쓴다.
CREATE INDEX "rental_allocation_notes_rental_allocation_id_created_at_idx"
  ON "rental_allocation_notes"("rental_allocation_id", "created_at" DESC);
