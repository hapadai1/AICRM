/**
 * 렌탈 도메인 상태·코드 (데이터모델설계서 13.3).
 * DB enum 대신 varchar + 상수 배열로 관리한다 (구현표준 1.2).
 */

/** 렌탈 실물 품목 구분 */
export const RENTAL_COMPONENT_TYPES = ['JACKET', 'TROUSERS', 'VEST', 'SHIRT', 'SHOES'];

/** 실물 상태 */
export const RENTAL_ITEM_STATUSES = [
  'AVAILABLE',
  'RESERVED',
  'PREPARING',
  'ALTERATION',
  'CHECKED_OUT',
  'RETURNED_HOLD',
  'UNAVAILABLE',
  'RETIRED',
];

/** 신규 배정 가능 실물 상태 (통합설계서 11.5 — 기간 미중복이면 예약 중 실물도 다른 기간에 배정 가능) */
export const ASSIGNABLE_ITEM_STATUSES = ['AVAILABLE', 'RESERVED'];

/** 배정 상태 */
export const RENTAL_ALLOCATION_STATUSES = ['RESERVED', 'PREPARING', 'CHECKED_OUT', 'RETURNED', 'CANCELLED'];

/** 기간 잠금·실물 점유가 살아 있는 배정 상태 (출고 전·중) */
export const ACTIVE_ALLOCATION_STATUSES = ['RESERVED', 'PREPARING', 'CHECKED_OUT'];

/** 반납 처리 시 실물이 가질 수 있는 다음 상태 (RENT-004) */
export const RETURN_NEXT_ITEM_STATUSES = ['RETURNED_HOLD', 'ALTERATION', 'UNAVAILABLE', 'AVAILABLE'];

/** 배정 이벤트 타입 (데이터모델설계서 11.4) */
export const ALLOCATION_EVENT_TYPES = {
  ASSIGNED: 'ASSIGNED',
  ITEM_CHANGED: 'ITEM_CHANGED',
  PICKED_UP: 'PICKED_UP',
  RETURNED: 'RETURNED',
  CANCELLED: 'CANCELLED',
} as const;

export const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' → UTC 자정 Date (@db.Date 컬럼 저장용) */
export function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Date → 'YYYY-MM-DD' */
export function toDateOnlyString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * rental_allocation_no_overlap EXCLUDE 제약(23P01) 위반 감지.
 * Prisma는 exclusion 제약을 P2002처럼 매핑하지 않으므로 메시지 기반으로 판별한다.
 */
export function isRentalOverlapDbError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('23P01') ||
    message.includes('rental_allocation_no_overlap') ||
    message.includes('exclusion constraint')
  );
}
