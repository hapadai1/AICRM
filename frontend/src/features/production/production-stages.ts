/**
 * 제작 관리 화면의 단계 정의 — **진행(journey) 단계를 그대로 쓴다** (2026-08-04 현업 확정).
 *
 * 제작 발주·가봉 입고·가봉 피팅·완성복 입고/출고, 렌탈 수선 요청·입고·출고·반납은
 * 이미 진행 단계 마스터(journey_stages)에 코드까지 정의돼 있고, 품목 단위 게이팅과
 * 고객 연락 문구도 그 위에 붙어 있다. 제작 화면이 쓸 단계를 새로 만들면 같은 뜻의 상태가
 * 두 벌이 되므로, 여기서는 **어느 진행 단계를 어떤 이름·버튼으로 보여줄지**만 정한다.
 *
 * 진행 단계가 "무엇을 끝냈는가"의 기록이고, 제작 도메인(구성품 상태·입출고 일자)은
 * 그 결과로 함께 남는 실물 기록이다. 담당자는 품목 버튼 하나만 누르고, 화면이 둘 다 처리한다.
 */

import { ITEM_STATUS_RANK } from '../../api/production';

/** 품목 버튼을 누를 때 제작 도메인에 함께 반영할 것 */
export type StageEffect =
  /** 품목 상태 → 제작 요청 */
  | 'ITEM_REQUEST'
  /** 품목 상태 → 가봉 완료(완성복 제작 요청) */
  | 'ITEM_FITTING'
  /** 구성품 → 가봉 입고 */
  | 'COMPONENT_BASTING'
  /** 구성품 → 입고 (일자를 받는다) */
  | 'COMPONENT_RECEIVE'
  /** 구성품 → 출고 (일자를 받는다) */
  | 'COMPONENT_RELEASE';

/** 단계에 얹는 제작 고유 버튼 묶음 */
export type StageExtras =
  /** 작업지시서 출력·보기·Excel */
  | 'WORK_ORDER'
  /** 가봉 기록(수정지시서 다운로드·첨부 업로드 포함) */
  | 'FITTING';

export interface ProductionStage {
  /** journey_stages.code */
  code: string;
  /**
   * 이 단계를 이미 지나간 것으로 보는 품목 상태.
   * 진행의 완료 기록과 제작 상태는 다른 기록이라, 단계만 건너뛴 채 실물이 앞서 간 품목이 있다.
   * 그런 품목에 완료 버튼을 계속 내면 이미 제작에 들어간 옷을 또 발주하라는 말로 읽힌다
   * (2026-08-04 현업 지적) — 상태가 이 값에 닿았으면 완료로 표시한다.
   */
  reachedAt?: string;
  /** 화면에 쓰는 이름 (마스터 이름이 길면 여기서 줄여 부른다) */
  label: string;
  /** 품목 행의 완료 버튼 이름. 없으면 완료 버튼을 내지 않는다 */
  action?: string;
  effect?: StageEffect;
  extras?: StageExtras;
}

/**
 * 준비(계약·스타일 컨설팅·채촌) 자리에 서 있는 진행 단계.
 * 준비는 맞춤·렌탈이 똑같이 밟으므로 화면에서는 흐름 밖 카드 하나로 세우고(ProductionPrepCard),
 * 흐름 카드는 트랙마다 갈리는 단계만 그린다(2026-08-04 현업 확정).
 * 진행 단계 자체는 그대로 남아 있어, 첫 단계를 처리할 때 이 단계의 품목 완료도 함께 찍는다.
 */
export const PREP_STAGE_CODE = 'STYLE_CONSULTING';

/** 맞춤 제작 (왼쪽) */
const CUSTOM_STAGES: ProductionStage[] = [
  {
    code: 'ORDER_REQUESTED',
    label: '제작 발주',
    action: '발주',
    effect: 'ITEM_REQUEST',
    extras: 'WORK_ORDER',
    reachedAt: 'PRODUCTION_REQUESTED',
  },
  {
    code: 'BASTING_RECEIVED',
    label: '가봉 입고',
    action: '입고',
    effect: 'COMPONENT_BASTING',
    reachedAt: 'BASTING_RECEIVED',
  },
  {
    code: 'FITTING_DONE',
    label: '가봉 피팅',
    action: '완성복발주',
    effect: 'ITEM_FITTING',
    extras: 'FITTING',
    reachedAt: 'FITTING_COMPLETED',
  },
  {
    code: 'PRODUCT_RECEIVED',
    label: '완성복 입고',
    action: '입고',
    effect: 'COMPONENT_RECEIVE',
    reachedAt: 'RECEIVED',
  },
  {
    code: 'RELEASED',
    label: '완성복 출고',
    action: '출고',
    effect: 'COMPONENT_RELEASE',
    reachedAt: 'RELEASED',
  },
];

/**
 * 렌탈 (오른쪽) — 맞춤과 별개로 돈다.
 * 렌탈 옷은 우리 재고를 고객 몸에 맞춰 고쳐 내주므로, 제작이 아니라 수선 요청·입고를 거친다.
 */
const RENTAL_STAGES: ProductionStage[] = [
  {
    code: 'RENTAL_REPAIR_REQUESTED',
    label: '렌탈 수선 요청',
    action: '수선요청',
    reachedAt: 'PRODUCTION_REQUESTED',
  },
  {
    code: 'RENTAL_REPAIR_RECEIVED',
    label: '렌탈 수선 입고',
    action: '입고',
    effect: 'COMPONENT_RECEIVE',
    reachedAt: 'RECEIVED',
  },
  {
    code: 'RENTAL_REPAIR_CHECKED_OUT',
    label: '렌탈 출고',
    action: '출고',
    effect: 'COMPONENT_RELEASE',
    reachedAt: 'RELEASED',
  },
  // 반납은 실물 상태로 남지 않는다(출고가 마지막 품목 상태다) — 진행 기록으로만 판정한다.
  { code: 'RENTAL_RETURNED', label: '렌탈 반납', action: '반납' },
];

export function stagesForTrack(trackType: string): ProductionStage[] {
  return trackType === 'RENTAL' ? RENTAL_STAGES : CUSTOM_STAGES;
}

/** 목록의 '맞춤/렌탈 상태' — 트랙별 현재 단계(둘 다 진행 중이면 나눠 보여 준다). 없으면 null */
export interface ContractProductionStages {
  custom: string | null;
  rental: string | null;
}

/** 단계 판정에 쓰는 최소 품목 형태 — 품목 상태 + 구성품(가봉 입고 등은 구성품 상태에만 남는다). */
interface StageItemInput {
  itemStatus: string;
  components?: { active: boolean; status: string; actualInboundAt?: string; actualOutboundAt?: string }[];
}

/** 구성품 하나가 이 단계(입출고·가봉 입고)를 지났는가 — 흐름 카드(StageProgress)의 판정과 같은 규칙. */
function componentPassed(
  effect: StageEffect,
  c: { status: string; actualInboundAt?: string; actualOutboundAt?: string },
): boolean {
  if (effect === 'COMPONENT_RECEIVE')
    return !!c.actualInboundAt || c.status === 'RECEIVED' || c.status === 'RELEASED';
  if (effect === 'COMPONENT_RELEASE') return !!c.actualOutboundAt || c.status === 'RELEASED';
  if (effect === 'COMPONENT_BASTING')
    return ['BASTING_RECEIVED', 'PRODUCTION_COMPLETED', 'RECEIVED', 'RELEASED'].includes(c.status);
  return false;
}

/**
 * 그 품목이 이 단계를 끝냈는가 — 흐름 카드와 같은 사실을 보도록 품목 상태 + 구성품 상태로 판정한다.
 *  - 가봉 입고·완성복 입고/출고(렌탈 수선 입고/출고)는 **구성품 상태에만** 남고 품목 상태로 올라오지
 *    않는다(집계는 입고/출고만 품목에 반영) → 구성품으로 본다.
 *  - 발주·가봉 피팅·렌탈 수선 요청은 품목 상태(reachedAt)로 본다.
 *  - 렌탈 반납은 품목 COMPLETED(백엔드 방안 A)로 본다.
 */
function itemStageDone(stage: ProductionStage, item: StageItemInput): boolean {
  if (item.itemStatus === 'COMPLETED') return true; // 최종 종결(렌탈 반납 완료 포함)
  const effect = stage.effect;
  if (effect && effect.startsWith('COMPONENT')) {
    const comps = (item.components ?? []).filter((c) => c.active && c.status !== 'CANCELLED');
    // 구성품이 등록돼 있으면 그 실물 기록으로, 없으면 품목 상태(reachedAt)로 판정한다.
    if (comps.length > 0) return comps.every((c) => componentPassed(effect, c));
  }
  return stageReached(stage, item.itemStatus);
}

/**
 * 한 트랙의 현재 단계 — 상세 흐름 카드와 같은 규칙(전 품목이 끝낸 단계만 완료로 센다).
 * 한 품목이라도 안 끝낸 첫 단계가 그 트랙의 현재 상태다. 취소는 제외, 전 단계를 끝냈으면 '완료'.
 */
function trackStage(items: StageItemInput[], track: 'CUSTOM' | 'RENTAL'): string | null {
  const live = items.filter((i) => i.itemStatus !== 'CANCELLED');
  if (live.length === 0) return null;
  const stages = stagesForTrack(track);
  for (const s of stages) {
    if (!live.every((it) => itemStageDone(s, it))) return s.label;
  }
  return '완료';
}

/** 계약의 맞춤·렌탈 상태를 트랙별로 유도한다. 그 트랙 품목이 없으면 해당 값은 null. */
export function contractProductionStages(
  items: (StageItemInput & { transactionType: string })[],
): ContractProductionStages {
  return {
    custom: trackStage(items.filter((i) => i.transactionType !== 'RENTAL'), 'CUSTOM'),
    rental: trackStage(items.filter((i) => i.transactionType === 'RENTAL'), 'RENTAL'),
  };
}

/** 트랙별 진행률(%) — 그 트랙 품목이 없으면 null */
export interface ContractTrackProgress {
  custom: number | null;
  rental: number | null;
}

/**
 * 한 트랙의 진행률 — 상세 흐름 카드와 같은 규칙(전 품목이 끝낸 단계 수 / 전체 단계 수).
 * 품목 상태 평균이 아니라 단계 기준이라, 렌탈은 반납(마지막 단계)까지 끝나야 100%가 된다.
 */
function trackProgress(items: StageItemInput[], track: 'CUSTOM' | 'RENTAL'): number | null {
  const live = items.filter((i) => i.itemStatus !== 'CANCELLED');
  if (live.length === 0) return null;
  const stages = stagesForTrack(track);
  let done = 0;
  for (const s of stages) {
    if (live.every((it) => itemStageDone(s, it))) done += 1;
  }
  return Math.round((done / stages.length) * 100);
}

/** 계약의 맞춤·렌탈 진행률을 트랙별로 유도한다. 그 트랙 품목이 없으면 해당 값은 null. */
export function contractTrackProgress(
  items: (StageItemInput & { transactionType: string })[],
): ContractTrackProgress {
  return {
    custom: trackProgress(items.filter((i) => i.transactionType !== 'RENTAL'), 'CUSTOM'),
    rental: trackProgress(items.filter((i) => i.transactionType === 'RENTAL'), 'RENTAL'),
  };
}

/**
 * 그 품목이 제작 상태로 이미 이 단계를 지나갔는가.
 * 진행에 완료 기록이 없어도(단계를 건너뛰고 실물만 앞서 간 경우) 완료로 본다.
 */
export function stageReached(stage: ProductionStage, itemStatus?: string): boolean {
  if (!stage.reachedAt || !itemStatus) return false;
  const at = ITEM_STATUS_RANK[itemStatus];
  const need = ITEM_STATUS_RANK[stage.reachedAt];
  return at !== undefined && need !== undefined && at >= need;
}

/** 일자를 받아야 하는 단계 — 입고·출고는 언제 들어오고 나갔는지가 기록의 전부다. */
export function needsDate(stage: ProductionStage): boolean {
  return stage.effect === 'COMPONENT_RECEIVE' || stage.effect === 'COMPONENT_RELEASE';
}

/**
 * 그 품목의 준비가 끝났는가 — 준비는 사람이 누르는 것이 아니라 이 조건으로 판정한다.
 * 맞춤은 옵션 확정 + 채촌 연결(작업지시서 출력 게이트와 같은 조건),
 * 렌탈은 기성복을 골라 내주는 것이라 채촌을 요구하지 않는다.
 */
export function prepDone(
  workOrder: { optionConfirmedAt?: string; measurementLinkedAt?: string },
  trackType: string,
): boolean {
  if (!workOrder.optionConfirmedAt) return false;
  return trackType === 'RENTAL' ? true : !!workOrder.measurementLinkedAt;
}
