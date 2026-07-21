/**
 * 고객 진행 단계 상수 (개발설계서 05 G-11).
 * DB enum 대신 varchar + 상수 배열로 관리한다 (구현표준 1.2).
 *
 * 단계 코드 자체는 journey_stages 테이블(시드)에 있고 관리자가 이름·연락 템플릿을
 * 조정할 수 있다. 여기에는 코드가 아닌 "축"만 정의한다.
 */

/** 진행 트랙 — 상담 usageType(BUSINESS_CUSTOM/WEDDING_RENTAL)과 1:1 대응 */
export const TRACK_TYPES = ['CUSTOM', 'RENTAL'] as const;
export type TrackType = (typeof TRACK_TYPES)[number];

/** 상담 용도 → 진행 트랙 매핑 */
export const USAGE_TYPE_TO_TRACK: Record<string, TrackType> = {
  BUSINESS_CUSTOM: 'CUSTOM',
  WEDDING_RENTAL: 'RENTAL',
};

export const JOURNEY_STATUSES = ['ACTIVE', 'COMPLETED', 'CANCELLED'] as const;

/**
 * 단계 변경 시점의 고객 연락 처리 결과.
 * - NONE:     연락 대상 단계가 아니거나 아직 처리하지 않음
 * - SENT:     발송 완료
 * - DEFERRED: "나중에" — 대시보드 연락 대기 목록에 남는다
 * - SKIPPED:  "안 보냄" — 의도적으로 생략
 */
export const NOTIFICATION_OUTCOMES = ['NONE', 'SENT', 'DEFERRED', 'SKIPPED'] as const;

/** 진행 현황 보드에서 "정체"로 강조할 기본 일수 (설계서 05 §9-2) */
export const DEFAULT_STALLED_DAYS = 7;
