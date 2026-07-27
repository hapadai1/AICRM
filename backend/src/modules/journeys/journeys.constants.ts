/**
 * 고객 진행 단계 상수 (개발설계서 05 G-11).
 * DB enum 대신 varchar + 상수 배열로 관리한다 (구현표준 1.2).
 *
 * 단계 코드 자체는 journey_stages 테이블(시드)에 있고 관리자가 이름·연락 템플릿을
 * 조정할 수 있다. 여기에는 코드가 아닌 "축"만 정의한다.
 */

/**
 * 진행 트랙.
 * - CUSTOM/RENTAL: 상담 usageType(BUSINESS_CUSTOM/WEDDING_RENTAL)과 1:1 대응, 계약에서 시작
 * - REPAIR: 수선 접수 등록 시 시작(상담 매핑 없음) — v2 PDF 2페이지 수선 트랙 (설계서 02 §2.2)
 */
export const TRACK_TYPES = ['CUSTOM', 'RENTAL', 'REPAIR'] as const;
export type TrackType = (typeof TRACK_TYPES)[number];

/** 상담 용도 → 진행 트랙 매핑 (REPAIR는 상담이 아니라 수선 접수에서 시작하므로 제외) */
export const USAGE_TYPE_TO_TRACK: Record<string, TrackType> = {
  BUSINESS_CUSTOM: 'CUSTOM',
  WEDDING_RENTAL: 'RENTAL',
};

/** 품목별 완료의 대상 종류 (다형 참조, 설계서 02 §3.3) */
export const COMPLETION_TARGET_TYPES = ['ORDER_ITEM', 'REPAIR_ITEM'] as const;
export type CompletionTargetType = (typeof COMPLETION_TARGET_TYPES)[number];

/**
 * 단계 완료 방식 (설계서 02 §4).
 * - AUTO:  자동완료(수동 버튼 없음) — 도메인 이벤트 훅으로 전진
 * - GATED: 대상 품목 전수완료 후 [전체 완료] 활성
 */
export const STAGE_COMPLETION_MODES = ['AUTO', 'GATED'] as const;
export type StageCompletionMode = (typeof STAGE_COMPLETION_MODES)[number];

/** 게이팅 대상 품목 범위 */
export const STAGE_TARGET_SCOPES = ['ORDER_ITEMS', 'REPAIR_ITEMS', 'NONE'] as const;
export type StageTargetScope = (typeof STAGE_TARGET_SCOPES)[number];

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

/**
 * 상담 예약(CONSULT_RESERVED) 자동종료 지연평가 임계 일수 (설계서 02 §9.2·§10.3).
 * 스케줄러 없이 get()/list() 응답에 expired 힌트만 얹는다(실제 status 변경 없음, 화면 표기용).
 */
export const CONSULT_RESERVED_EXPIRE_DAYS = 14;
