-- v2 D6: 결제 기능 완전 제거의 잔여분.
-- payments 테이블은 20260726220426_v2_remove_payments에서 삭제됐고,
-- 결제수단 기준정보(payment_methods)는 사용처가 사라져 함께 제거한다(06 §3.3·3.9).
DROP TABLE "payment_methods";
