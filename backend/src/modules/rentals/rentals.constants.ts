/**
 * 렌탈 도메인 상태·코드 (데이터모델설계서 13.3).
 * DB enum 대신 varchar + 상수 배열로 관리한다 (구현표준 1.2).
 */

/** 렌탈 실물 품목 구분 */
export const RENTAL_COMPONENT_TYPES = ['JACKET', 'TROUSERS', 'VEST', 'SHIRT', 'SHOES'];

/**
 * 실물 상태.
 * PREPARING(준비 중)은 제거했다 — 어떤 흐름도 이 상태로 전이시키지 않아
 * 필터 결과가 항상 0건이었다. 출고 전 준비 단계를 실제로 운영하게 되면 되살린다.
 */
export const RENTAL_ITEM_STATUSES = [
  'AVAILABLE',
  'RESERVED',
  'ALTERATION',
  'CHECKED_OUT',
  'RETURNED_HOLD',
  'UNAVAILABLE',
  'RETIRED',
];

/** 신규 배정 가능 실물 상태 (통합설계서 11.5 — 기간 미중복이면 예약 중 실물도 다른 기간에 배정 가능) */
export const ASSIGNABLE_ITEM_STATUSES = ['AVAILABLE', 'RESERVED'];

/** 배정 상태 (실물 상태와 같은 이유로 PREPARING 제거) */
export const RENTAL_ALLOCATION_STATUSES = ['RESERVED', 'CHECKED_OUT', 'RETURNED', 'CANCELLED'];

/** 기간 잠금·실물 점유가 살아 있는 배정 상태 (출고 전·중) */
export const ACTIVE_ALLOCATION_STATUSES = ['RESERVED', 'CHECKED_OUT'];

/** 반납 처리 시 실물이 가질 수 있는 다음 상태 (RENT-004) */
export const RETURN_NEXT_ITEM_STATUSES = ['RETURNED_HOLD', 'ALTERATION', 'UNAVAILABLE', 'AVAILABLE'];

/**
 * 색 계열 — 반납 후 정비(세탁) 소요일을 가르는 축.
 * LIGHT = 화이트·베이지 계열(오염이 보여 세탁 확인 필요), DARK = 그 외.
 */
export const RENTAL_COLOR_TONES = ['LIGHT', 'DARK'];

/** 정비 기준은 항상 한 행이다 — 이 id로만 읽고 쓴다 (마이그레이션이 심는 값과 같아야 한다). */
export const RENTAL_RETURN_POLICY_ID = '00000000-0000-4000-8000-00000000c1ea';

/** 정책 행이 아직 없을 때 쓰는 기본값 (현업 확정 2026-08-01: 밝은색 2일, 블랙 타입 1일) */
export const DEFAULT_RETURN_POLICY = {
  lightCleaningDays: 2,
  darkCleaningDays: 1,
  autoRelease: true,
} as const;

/**
 * 배정 비고 종류.
 * CONTACT는 발송 결과를 봉합할 때만 생기고 사람이 직접 고를 수 없다 —
 * 실제로 나가지 않은 연락이 횟수에 잡히면 "몇 번 연락했나"를 못 믿게 된다.
 */
export const ALLOCATION_NOTE_KINDS = ['CONTACT', 'REPLY', 'CHANGE', 'MEMO'];
export const MANUAL_NOTE_KINDS = ['REPLY', 'CHANGE', 'MEMO'];

/**
 * 렌탈 고객 연락 문구. 픽업·반납, 안내·독촉으로 가르지 않고 하나만 둔다 —
 * 담당자가 발송 확인창에서 그 자리에서 고쳐 보낸다 (현업 확정 2026-08-03).
 */
export const RENTAL_NOTICE_TEMPLATE_CODE = 'RENTAL_NOTICE';

/** 배정 이벤트 타입 (데이터모델설계서 11.4) */
export const ALLOCATION_EVENT_TYPES = {
  ASSIGNED: 'ASSIGNED',
  ITEM_CHANGED: 'ITEM_CHANGED',
  PICKED_UP: 'PICKED_UP',
  RETURNED: 'RETURNED',
  CANCELLED: 'CANCELLED',
} as const;

/*
  날짜 헬퍼는 common/date.ts가 단일 출처다 (2026-08-05). 기존 소비처의 import 경로를
  지키기 위해 재노출한다. 이 이동으로 todayDateOnly의 '오늘' 기준이 UTC 달력에서
  로컬(매장) 달력으로 바뀌었다 — KST 자정~오전 9시에 하루 어긋나던 것이 맞는 값이 된다.
*/
export {
  DATE_ONLY_REGEX,
  addDaysToDateOnly,
  parseDateOnly,
  toDateOnlyString,
  todayDateOnly,
} from '../../common/date';

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
