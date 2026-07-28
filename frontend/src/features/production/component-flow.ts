/**
 * 구성품 제작 흐름의 화면 표현 — "지금 무엇을 하면 되는가"와 "어디까지 왔는가"를 만든다.
 *
 * 상태 전이 규칙 자체는 `api/production.ts`(백엔드 production-status.ts와 짝)에 있고,
 * 여기서는 그 규칙을 화면 어휘로 옮기기만 한다. 전이 규칙을 여기서 다시 정의하지 않는다.
 */
import {
  COMPONENT_STATUS_RANK,
  PRODUCTION_STATUS_META,
  backwardTransitions,
  forwardTransitions,
  type ComponentStatus,
} from '../../api/production';
import { metaOf } from '../../shared/status-meta';

/** 스텝퍼에 찍히는 단계 하나 */
export interface ComponentStep {
  status: string;
  /** 표에 들어가야 하므로 2글자로 줄인 이름 */
  short: string;
  /** 툴팁에 쓰는 온전한 이름 */
  full: string;
  /** 해당 품목에만 생기는 단계 — 건너뛴 것인지 기록만으로는 알 수 없다 */
  optional?: boolean;
}

const CUSTOM_STEPS: ComponentStep[] = [
  { status: 'CREATED', short: '생성', full: '생성' },
  { status: 'PRODUCTION_REQUESTED', short: '요청', full: '제작 요청' },
  { status: 'PRODUCTION_IN_PROGRESS', short: '제작', full: '제작 중' },
  { status: 'BASTING_RECEIVED', short: '가봉', full: '가봉 입고 (해당 품목만)', optional: true },
  { status: 'PRODUCTION_COMPLETED', short: '완료', full: '제작 완료' },
  { status: 'RECEIVED', short: '입고', full: '입고' },
  { status: 'RELEASED', short: '출고', full: '고객 출고' },
];

/** 렌탈 구성품은 제작 없이 예약 → 입고 → 출고로 끝난다 (COMPONENT_FORWARD_TRANSITIONS.RESERVED와 짝) */
const RENTAL_STEPS: ComponentStep[] = [
  { status: 'RESERVED', short: '예약', full: '렌탈 예약' },
  { status: 'RECEIVED', short: '입고', full: '입고' },
  { status: 'RELEASED', short: '출고', full: '고객 출고' },
];

/**
 * 그 구성품이 밟는 단계 목록.
 * 렌탈 판정은 거래유형으로 한다 — 예약 구성품도 입고되고 나면 상태값만으로는 맞춤과 구분되지 않는다.
 */
export function stepsFor(transactionType: string): ComponentStep[] {
  return transactionType === 'RENTAL' ? RENTAL_STEPS : CUSTOM_STEPS;
}

/** 한 번 눌러 처리하는 진행 액션 */
export interface ComponentAction {
  toStatus: ComponentStatus;
  /** 버튼·메뉴에 쓰는 동사형 이름 */
  label: string;
  /** 일자를 함께 남겨야 하는 액션 — 전용 입출고 API로 보낸다 */
  mode?: 'receive' | 'release';
}

/** 상태 이름이 아니라 "할 일" 이름으로 부른다 — 담당자는 상태를 고르는 게 아니라 작업을 끝낸다. */
const ACTION_LABELS: Record<string, string> = {
  PRODUCTION_REQUESTED: '제작요청',
  PRODUCTION_IN_PROGRESS: '제작시작',
  BASTING_RECEIVED: '가봉입고',
  PRODUCTION_COMPLETED: '제작완료',
  RECEIVED: '입고',
  RELEASED: '출고',
};

function actionLabel(to: string): string {
  return ACTION_LABELS[to] ?? to;
}

function toAction(to: ComponentStatus): ComponentAction {
  return {
    toStatus: to,
    label: actionLabel(to),
    mode: to === 'RECEIVED' ? 'receive' : to === 'RELEASED' ? 'release' : undefined,
  };
}

function rankOf(status: string): number | undefined {
  return COMPONENT_STATUS_RANK[status];
}

/**
 * 행에 버튼으로 낼 "다음 단계" — 지금보다 앞으로 가는 정방향 전이만.
 * 첫 번째가 통상 경로이고, 뒤따르는 것은 건너뛰기 경로다(가봉 없는 품목의 제작완료 등).
 * 순번이 없는 상태(RESERVED)는 정방향 목록을 그대로 쓴다.
 */
export function nextActions(from: string): ComponentAction[] {
  const rank = rankOf(from);
  return forwardTransitions(from)
    .filter((s) => rank === undefined || (rankOf(s) ?? -1) > rank)
    .sort((a, b) => (rankOf(a) ?? 0) - (rankOf(b) ?? 0))
    .map(toAction);
}

/** ⋯ 메뉴로 밀어 둘 예외 경로 — 중간 단계 건너뛰기, 재작업 복귀, 역행 */
export interface ComponentExceptionAction extends ComponentAction {
  /** 역행이면 사유를 받아야 한다 (백엔드 validateTransition이 요구) */
  backward: boolean;
  group: '건너뛰기' | '되돌리기';
}

/**
 * 중간 단계를 건너뛰고 앞으로 보내는 경로.
 * 사입 구성품(셔츠·구두 등)은 제작 단계를 밟지 않고 바로 입고되므로 이 경로가 실제로 쓰인다 —
 * 백엔드도 정방향 건너뛰기와 `receiveComponent`(취소·입고완료 외 모든 상태에서 입고)를 허용한다.
 *
 * 출고는 뺀다. `releaseComponent`가 입고 상태만 받으므로, 상태 이벤트로 건너뛰면
 * 상태만 바뀌고 출고 일자가 남지 않는다.
 */
function skipActions(from: string): ComponentExceptionAction[] {
  const rank = rankOf(from);
  // 순번 밖 상태(RESERVED)는 정방향 목록이 이미 전 경로를 담고 있어 건너뛸 것이 없다.
  if (rank === undefined) return [];
  const offered = new Set(nextActions(from).map((a) => a.toStatus));
  return (Object.keys(COMPONENT_STATUS_RANK) as ComponentStatus[])
    .filter(
      (s) => (rankOf(s) ?? -1) > rank && !offered.has(s) && s !== 'RELEASED' && ACTION_LABELS[s],
    )
    .sort((a, b) => (rankOf(a) ?? 0) - (rankOf(b) ?? 0))
    .map((s) => ({
      ...toAction(s),
      backward: false,
      group: '건너뛰기' as const,
      label: `건너뛰고 ${actionLabel(s)}`,
    }));
}

export function exceptionActions(from: string): ComponentExceptionAction[] {
  const ahead = new Set(nextActions(from).map((a) => a.toStatus));
  // 정방향 목록에 있으나 앞으로 가지 않는 전이 = 재작업 복귀 (가봉 입고 → 제작 중). 사유는 필요 없다.
  const rework = forwardTransitions(from)
    .filter((s) => !ahead.has(s))
    .map((s) => ({ ...toAction(s), backward: false }));
  const backward = backwardTransitions(from).map((s) => ({ ...toAction(s), backward: true }));
  const undo: ComponentExceptionAction[] = [...rework, ...backward].map((a) => ({
    ...a,
    // 되돌리기는 일자를 남기는 액션이 아니다 — 전용 입출고 API가 아니라 상태 이벤트로 보낸다.
    mode: undefined,
    group: '되돌리기' as const,
    // 되돌리기는 할 일이 아니라 상태 되감기다 — 동사형 대신 상태 이름으로 부른다.
    // "상태로"를 붙여 받침 유무에 따른 조사 갈림(으로/로)을 피한다.
    label: `${metaOf(PRODUCTION_STATUS_META, a.toStatus).label} 상태로 되돌리기`,
  }));
  return [...skipActions(from), ...undo];
}
