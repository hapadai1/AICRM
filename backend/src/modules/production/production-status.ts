import { BusinessException } from '../../common/business.exception';

/**
 * 제작·입출고 상태 흐름 (데이터모델설계서 §13.4).
 * 배열 순서가 정상 진행 순서이며, 역행은 변경 사유(reason)를 요구한다.
 */
export const ITEM_STATUS_FLOW = [
  'CREATED',
  'OPTION_PENDING',
  'MEASUREMENT_PENDING',
  'READY_TO_ORDER',
  'PRODUCTION_REQUESTED',
  'PRODUCTION_IN_PROGRESS',
  'BASTING_RECEIVED',
  'FITTING_COMPLETED',
  'PRODUCTION_COMPLETED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'PARTIALLY_RELEASED',
  'RELEASED',
] as const;

export const COMPONENT_STATUS_FLOW = [
  'CREATED',
  'PRODUCTION_REQUESTED',
  'PRODUCTION_IN_PROGRESS',
  'BASTING_RECEIVED',
  'PRODUCTION_COMPLETED',
  'RECEIVED',
  'RELEASED',
] as const;

/** 구성품 상태에서만 계산되는 품목 집계 상태 — 직접 이벤트로 설정할 수 없다. */
export const AGGREGATE_ONLY_STATUSES = ['PARTIALLY_RECEIVED', 'PARTIALLY_RELEASED'];

export const CANCELLED = 'CANCELLED';

/**
 * 상태 전이를 검증한다 (§10.5, §13.4).
 * - 순방향 이동 허용(중간 단계 건너뛰기 허용 — 가봉 없는 품목 등)
 * - 역행은 reason 필수 (데이터모델 §10.3 "상태 역행은 권한과 변경 사유를 요구한다")
 * - CANCELLED는 어느 상태에서든 진입 가능, CANCELLED에서의 재전이는 불가
 * - 동일 상태 재설정 불가
 */
export function validateTransition(
  flow: readonly string[],
  current: string,
  next: string,
  reason: string | undefined,
  unit: string,
): { backward: boolean } {
  if (current === CANCELLED)
    throw new BusinessException(
      'INVALID_STATUS_TRANSITION',
      `취소된 ${unit}의 상태는 변경할 수 없습니다.`,
      undefined,
      { current, next },
    );
  if (next === CANCELLED) return { backward: false };
  if (!flow.includes(next))
    throw new BusinessException('VALIDATION_ERROR', `허용되지 않은 상태 코드입니다: ${next}`, [
      { field: 'newStatus', reason: 'UNKNOWN_STATUS' },
    ]);
  if (next === current)
    throw new BusinessException(
      'INVALID_STATUS_TRANSITION',
      `이미 ${next} 상태입니다.`,
      undefined,
      { current, next },
    );

  const currentIdx = flow.indexOf(current);
  const nextIdx = flow.indexOf(next);
  const backward = currentIdx >= 0 && nextIdx < currentIdx;
  if (backward && !reason?.trim())
    throw new BusinessException('VALIDATION_ERROR', '상태 역행에는 변경 사유가 필요합니다.', [
      { field: 'reason', reason: 'REQUIRED_ON_BACKWARD' },
    ]);
  return { backward };
}

/**
 * 구성품 상태에서 품목 집계 상태를 계산한다 (통합설계서 §10.6).
 * - 전체 출고 → RELEASED, 일부 출고 → PARTIALLY_RELEASED
 * - 전체 입고 → RECEIVED, 일부 입고 → PARTIALLY_RECEIVED
 * - 입출고 진행 전이면 null (품목 상태 유지)
 * 취소·비활성 구성품은 집계에서 제외한다.
 */
export function computeAggregateStatus(components: { status: string; active: boolean }[]): string | null {
  const targets = components.filter((c) => c.active && c.status !== CANCELLED);
  if (targets.length === 0) return null;

  const released = targets.filter((c) => c.status === 'RELEASED').length;
  const received = targets.filter((c) => c.status === 'RECEIVED' || c.status === 'RELEASED').length;

  if (released === targets.length) return 'RELEASED';
  if (released > 0) return 'PARTIALLY_RELEASED';
  if (received === targets.length) return 'RECEIVED';
  if (received > 0) return 'PARTIALLY_RECEIVED';
  return null;
}
