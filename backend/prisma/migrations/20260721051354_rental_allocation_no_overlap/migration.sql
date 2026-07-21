-- 렌탈 실물 기간 중복 예약 방지 (데이터모델설계서 11.6)
-- 애플리케이션 사전 조회와 별개로 동시 요청에서도 DB 수준에서 중복 배정을 차단한다.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE rental_allocations ADD CONSTRAINT rental_allocation_no_overlap
  EXCLUDE USING gist (
    rental_inventory_item_id WITH =,
    daterange(pickup_date, availability_end_date, '[]') WITH &&
  )
  WHERE (status <> 'CANCELLED');
