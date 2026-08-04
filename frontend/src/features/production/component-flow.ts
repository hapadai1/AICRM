/**
 * 제작 흐름의 화면 표현 — "지금 무엇을 하면 되는가"와 "어디까지 왔는가"를 만든다.
 *
 * 화면은 단계(stage)를 세로로 세우고 단계마다 그 단계의 버튼만 낸다(수선 상태 관리와 같은 방식).
 * 그래서 이 파일이 만드는 것은 상태 코드가 아니라 **단계**다 — 상태 전이 규칙 자체는
 * `api/production.ts`(백엔드 production-status.ts와 짝)에 있고 여기서 다시 정의하지 않는다.
 *
 * 단계는 구성품 상태 하나(COMPONENT)에 대응하는 것이 기본이지만, 품목 단위로만 뜻이 있는
 * 두 단계(준비·작업지시서)가 앞에 붙는다. 옵션·채촌이 안 끝나 작업지시서가 잠긴 것인지
 * 아직 출력을 안 한 것인지는 상태 코드가 아니라 이 두 단계로만 읽힌다.
 */
import {
  COMPONENT_STATUS_RANK,
  PRODUCTION_STATUS_META,
  forwardTransitions,
  type ComponentStatus,
  type ProductionComponent,
  type ProductionItem,
} from '../../api/production';
import { metaOf } from '../../shared/status-meta';
import { WORK_ORDER_STATUS_META } from '../workorders/wo-meta';

/** 단계의 성격 — 품목 단위 두 단계(PREP·WORK_ORDER)는 구성품 표를 갖지 않는다. */
export type StageKind = 'PREP' | 'WORK_ORDER' | 'COMPONENT';

export interface ProductionStage {
  key: string;
  /** 단계 줄에 쓰는 이름 */
  label: string;
  kind: StageKind;
  /** COMPONENT 단계에서 그 단계를 끝낸 구성품 상태 */
  status?: ComponentStatus;
  /** 버튼에 쓰는 동사형 이름 — 담당자는 상태를 고르는 게 아니라 작업을 끝낸다 */
  action?: string;
  /** 일자를 함께 남겨야 하는 단계 — 전용 입출고 API로 보낸다 */
  mode?: 'receive' | 'release';
  /** 해당 품목에만 생기는 단계 — 지나갔더라도 기록이 없으면 건너뛴 것이다 */
  optional?: boolean;
}

const CUSTOM_STAGES: ProductionStage[] = [
  { key: 'PREP', label: '준비', kind: 'PREP' },
  { key: 'WORK_ORDER', label: '작업지시서', kind: 'WORK_ORDER' },
  {
    key: 'PRODUCTION_REQUESTED',
    label: '제작요청',
    kind: 'COMPONENT',
    status: 'PRODUCTION_REQUESTED',
    action: '제작요청',
  },
  {
    key: 'PRODUCTION_IN_PROGRESS',
    label: '제작중',
    kind: 'COMPONENT',
    status: 'PRODUCTION_IN_PROGRESS',
    action: '제작시작',
  },
  {
    key: 'BASTING_RECEIVED',
    label: '가봉',
    kind: 'COMPONENT',
    status: 'BASTING_RECEIVED',
    action: '가봉입고',
    optional: true,
  },
  {
    key: 'PRODUCTION_COMPLETED',
    label: '제작완료',
    kind: 'COMPONENT',
    status: 'PRODUCTION_COMPLETED',
    action: '제작완료',
  },
  { key: 'RECEIVED', label: '입고', kind: 'COMPONENT', status: 'RECEIVED', action: '입고', mode: 'receive' },
  { key: 'RELEASED', label: '출고', kind: 'COMPONENT', status: 'RELEASED', action: '출고', mode: 'release' },
];

/** 렌탈 구성품은 제작 없이 예약 → 입고 → 출고로 끝난다 (COMPONENT_FORWARD_TRANSITIONS.RESERVED와 짝) */
const RENTAL_STAGES: ProductionStage[] = [
  { key: 'RESERVED', label: '예약', kind: 'COMPONENT', status: 'RESERVED' },
  { key: 'RECEIVED', label: '입고', kind: 'COMPONENT', status: 'RECEIVED', action: '입고', mode: 'receive' },
  { key: 'RELEASED', label: '출고', kind: 'COMPONENT', status: 'RELEASED', action: '출고', mode: 'release' },
];

/**
 * 그 품목이 밟는 단계 목록.
 * 렌탈 판정은 거래유형으로 한다 — 예약 구성품도 입고되고 나면 상태값만으로는 맞춤과 구분되지 않는다.
 */
export function stagesFor(transactionType: string): ProductionStage[] {
  return transactionType === 'RENTAL' ? RENTAL_STAGES : CUSTOM_STAGES;
}

/** 진행 집계 대상 구성품 — 비활성·취소는 "아직 안 한 일"로 세지 않는다. */
export function activeComponents(item: ProductionItem): ProductionComponent[] {
  return item.components.filter((c) => c.active && c.status !== 'CANCELLED');
}

/**
 * 그 구성품이 이 단계를 지나왔는가.
 * 순번 비교라 건너뛴 단계도 지나온 것으로 본다 — 실제로 밟았는지는 이벤트 기록이 가른다
 * (기록이 없으면 화면에서 '건너뜀'으로 적는다).
 */
export function hasPassed(status: string, stage: ProductionStage): boolean {
  if (!stage.status) return false;
  // 예약은 배정에서 이미 만들어진 상태다 — 담당자가 할 일이 아니라 출발점이다.
  if (stage.status === 'RESERVED') return true;
  const rank = COMPONENT_STATUS_RANK[status];
  const target = COMPONENT_STATUS_RANK[stage.status];
  // 흐름 밖 상태(RESERVED)는 아직 제작 단계를 하나도 지나지 않았다.
  if (rank === undefined || target === undefined) return false;
  return rank >= target;
}

/**
 * 통상 경로에서 바로 다음에 오는 상태.
 * 뒷 단계 버튼도 누를 수 있게 두므로(사입 구성품은 제작 단계를 건너뛰고 바로 입고된다),
 * 어느 것이 통상 경로인지는 이 값으로만 강조한다 — 다 강조하면 아무것도 안 읽힌다.
 */
export function immediateNextStatus(status: string): ComponentStatus | undefined {
  const rank = COMPONENT_STATUS_RANK[status];
  return forwardTransitions(status)
    .filter((s) => rank === undefined || (COMPONENT_STATUS_RANK[s] ?? -1) > rank)
    .sort((a, b) => (COMPONENT_STATUS_RANK[a] ?? 0) - (COMPONENT_STATUS_RANK[b] ?? 0))[0];
}

export interface StageSummary {
  text: string;
  done: boolean;
}

/**
 * 단계 전체 상태 — 그 단계가 끝났는지 한 줄로 알려 준다.
 * 구성품이 늘면 표를 훑어야 "다 됐나?"를 알 수 있어서 단계마다 결론을 먼저 적는다(수선과 같은 규칙).
 */
export function stageSummary(item: ProductionItem, stage: ProductionStage): StageSummary {
  if (stage.kind === 'PREP') {
    // 옵션 확정·채촌 완료 여부는 작업지시서 출력 게이트가 그대로 말해 준다.
    const ready = item.workOrder.canIssue;
    return {
      text: ready
        ? '옵션 확정 · 채촌 완료'
        : `${metaOf(PRODUCTION_STATUS_META, item.itemStatus).label} — 옵션·채촌 준비 중`,
      done: ready,
    };
  }
  if (stage.kind === 'WORK_ORDER') {
    const wo = item.workOrder;
    const version = wo.currentVersionNo ? ` V${wo.currentVersionNo}` : '';
    return {
      text: `${metaOf(WORK_ORDER_STATUS_META, wo.status).label}${version}`,
      done: wo.status === 'CURRENT',
    };
  }
  const targets = activeComponents(item);
  // 구성품이 없으면 단계마다 '구성품 없음'이 여덟 번 반복된다 — 요약은 비우고
  // 화면이 첫 구성품 단계에서 한 번만 알린다.
  if (targets.length === 0) return { text: '', done: false };
  const name = stage.action ?? stage.label;
  const passed = targets.filter((c) => hasPassed(c.status, stage)).length;
  if (passed === targets.length) return { text: `전체 ${name} 완료`, done: true };
  return { text: `${passed}/${targets.length} ${name}`, done: false };
}

/**
 * 지금 서 있는 단계 = 아직 끝나지 않은 첫 단계.
 * 전부 끝났으면 단계 수를 돌려준다(스텝퍼에서 전 단계가 완료로 찍힌다).
 */
export function currentStageIndex(item: ProductionItem, stages: ProductionStage[]): number {
  const at = stages.findIndex((stage) => !stageSummary(item, stage).done);
  return at === -1 ? stages.length : at;
}

/**
 * 끝낸 단계 수 — 진행률은 이걸로 센다.
 * "서 있는 단계"로 세면 앞 단계 하나가 되밀렸을 때(작업지시서 재출력 필요) 뒤에서 끝낸 일이
 * 통째로 진행률에서 빠진다.
 */
export function completedStageCount(item: ProductionItem, stages: ProductionStage[]): number {
  return stages.filter((stage) => stageSummary(item, stage).done).length;
}

/**
 * 그 단계에 아직 손댈 구성품이 있는가 — 없으면 구성품 표를 접고 단계 줄 요약만 남긴다.
 * 끝난 단계까지 표를 깔면 여덟 단계가 전부 표를 달고 화면이 몇 배로 길어지는데,
 * 정작 거기 적힌 건 이미 지나온 일이다. 되돌리기는 그 단계에 서 있을 때만 되므로
 * 서 있는 구성품이 있으면 표를 남긴다.
 */
export function stageHasWork(item: ProductionItem, stage: ProductionStage): boolean {
  if (stage.kind !== 'COMPONENT') return true;
  // 예약은 배정에서 정해져 오는 출발점이라 여기서 할 일도, 되돌릴 일도 없다.
  if (stage.status === 'RESERVED') return false;
  return activeComponents(item).some(
    (c) => !hasPassed(c.status, stage) || c.status === stage.status,
  );
}

/** 되돌릴 곳 — 되돌리기는 할 일이 아니라 상태 되감기라 상태 이름으로 부른다. */
export interface RevertTarget {
  status: ComponentStatus;
  label: string;
}

/**
 * 한 칸 되돌릴 곳. 앞 단계 중 **실제로 기록이 있는** 가장 가까운 단계로 보낸다 —
 * 가봉 없이 제작완료로 온 구성품을 가봉으로 되돌리면 있지도 않은 단계로 보내는 셈이다.
 * 기록이 하나도 없으면 맞춤은 생성으로 돌아가고, 렌탈은 예약(제작 흐름 밖)이라 되돌리지 않는다.
 */
export function revertTargetOf(
  stages: ProductionStage[],
  stageIndex: number,
  hasEvent: (status: string) => boolean,
  transactionType: string,
): RevertTarget | null {
  for (let i = stageIndex - 1; i >= 0; i -= 1) {
    const stage = stages[i];
    if (stage.kind !== 'COMPONENT' || !stage.status) continue;
    // 예약은 백엔드 제작 흐름(COMPONENT_STATUS_FLOW) 밖이라 상태 이벤트로 되돌릴 수 없다.
    if (stage.status === 'RESERVED') return null;
    if (hasEvent(stage.status)) {
      return { status: stage.status, label: metaOf(PRODUCTION_STATUS_META, stage.status).label };
    }
  }
  if (transactionType === 'RENTAL') return null;
  return { status: 'CREATED', label: metaOf(PRODUCTION_STATUS_META, 'CREATED').label };
}
