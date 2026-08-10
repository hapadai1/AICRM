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
 * - CANCELLED 직접 진입 불가 — 주문 취소는 계약 취소를 통해서만 (현업 확정 2026-07-31).
 *   품목 정리가 필요하면 [되돌리기]로 생성 상태까지 되돌린 뒤 계약 수정으로 처리한다.
 * - CANCELLED에서의 재전이는 불가, 동일 상태 재설정 불가
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
  if (next === CANCELLED)
    throw new BusinessException(
      'INVALID_STATUS_TRANSITION',
      `${unit} 취소는 지원하지 않습니다. 주문 취소는 계약 취소로만 처리됩니다.`,
      undefined,
      { current, next },
    );
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
 * 아직 발주하지 않은 품목인가 (현업 확정 2026-08-05).
 *
 * "제작이 시작됐는가"를 가르는 **단일 기준**이다. 전에는 곳곳에서 `status !== 'CREATED'`로
 * 판정했는데, 계약완료가 준비 상태(옵션대기·채촌대기·발주가능)를 자동으로 올리기 시작하면서
 * 준비 중인 품목까지 "제작 중"으로 읽혔다 — 계약을 [수정하기]로 되돌려도 컨설팅·베스트·채촌이
 * 영영 잠기는 버그였다. 공장이 일을 시작하는 시점은 발주(PRODUCTION_REQUESTED)다.
 */
export function isBeforeProductionRequest(status: string): boolean {
  const frozenFrom = ITEM_STATUS_FLOW.indexOf('PRODUCTION_REQUESTED');
  const current = ITEM_STATUS_FLOW.indexOf(status as (typeof ITEM_STATUS_FLOW)[number]);
  // 흐름 밖 상태(취소·집계 전용)는 되돌릴 자리가 아니다.
  if (current < 0) return false;
  return current < frozenFrom;
}

/** 그 품목들 중 하나라도 발주가 나갔는가 — 취소 품목은 세지 않는다. */
export function anyInProduction(orderItems: { status: string }[]): boolean {
  return orderItems.some((o) => o.status !== CANCELLED && !isBeforeProductionRequest(o.status));
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
