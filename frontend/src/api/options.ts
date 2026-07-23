import { request } from './client';
import { toDateTime } from './transform';

/**
 * 옵션 선택 도메인 API (화면·API 정의서 §13.4, OPT-001~003)
 * 응답 형태는 백엔드(`option-sessions.service.ts`)가 기준이다.
 * 백엔드는 Prisma raw row를 그대로 내보내므로 여기서 화면용 뷰로 변환한다.
 */

/** 옵션 진행 상태 (core-data orderItems.status와 동일) */
export type OptionStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'REVIEW' | 'CONFIRMED';
export type ProductCategory = 'SUIT' | 'SHIRT' | 'SHOES';

/** OPT-001 목록 행 — 백엔드 progress()가 이미 평면 형태로 내려준다. */
export interface OptionProgressItem {
  orderItemId: string;
  displayName: string;
  productCategory: ProductCategory;
  contractId: string;
  contractNo: string;
  orderNo: string;
  customerName: string;
  /** 고객 전화번호 (목록에서 고객 식별용) */
  customerPhone: string;
  /** 완성 예정일(납기) ISO. 없으면 null */
  completionDueDate: string | null;
  fabric: string | null;
  status: OptionStatus;
  completedStages: number;
  totalStages: number;
  sessionId: string | null;
}

export interface OptionChoiceView {
  choiceId: string;
  /** 백엔드 choiceCode (A/B/C). 미등록 코드가 와도 그대로 노출한다. */
  code: string;
  name: string;
  /** 이 선택지를 고를 때 계약금액에 더해지는 추가금액(원). 없으면 0. */
  extraPrice: number;
  /** 선택지 이미지 경로(/files/:id). 미등록이면 null → 화면은 색상 블록으로 폴백. */
  imageUrl: string | null;
}

/**
 * 옵션 추가금액과 계약금액 차액.
 * 계약 버전은 올리지 않고 현재 버전 금액을 제자리 수정한다(백엔드 applySurcharge).
 */
export interface OptionSurcharge {
  sessionId: string;
  displayName: string;
  status: OptionSessionStatus;
  /** 이 품목 옵션의 추가금액 합계 */
  total: number;
  /** 그중 계약금액에 이미 반영한 금액 */
  applied: number;
  /** 아직 반영하지 않은 차액 */
  pending: number;
  appliedAt: string | null;
  /** 확정 세션이고 차액이 남아 있을 때만 반영할 수 있다 */
  appliable: boolean;
  contract: {
    contractId: string;
    contractNo: string;
    versionNo: number;
    totalAmount: number;
    depositAmount: number;
    balanceAmount: number;
    afterTotalAmount: number;
    afterBalanceAmount: number;
  } | null;
}

export interface OptionStageView {
  stageId: string;
  /** 백엔드 sequenceNo */
  order: number;
  /** 백엔드 stageName */
  name: string;
  required: boolean;
  choices: OptionChoiceView[];
  selectedChoiceId: string | null;
}

/** 세션 상태 — 백엔드는 NOT_STARTED도 내려준다. */
export type OptionSessionStatus = OptionStatus;

/** OPT-002 선택 세션 상세 (화면용) */
export interface OptionSessionDetail {
  sessionId: string;
  orderItemId: string;
  /** 백엔드 orderItemName */
  displayName: string;
  productCategory: ProductCategory;
  /** 백엔드 optionSetVersion.versionNo */
  optionSetVersionNo: number;
  selectionVersionNo: number;
  /** 백엔드 fabricName */
  fabric: string | null;
  status: OptionSessionStatus;
  currentStageId: string | null;
  /** 중단 지점 (currentSession 응답에만 포함) */
  resumeStageId: string | null;
  lastSavedAt?: string;
  totalStages: number;
  completedStages: number;
  /** 백엔드 미제공 — 선택이 저장된 마지막 단계 순번을 stages에서 파생한다. */
  lastStageOrder: number;
  version: number;
  stages: OptionStageView[];
}

// --- 백엔드 원본 행 ---------------------------------------------------------

interface OptionChoiceApiRow {
  id: string;
  choiceCode: string;
  choiceName: string;
  factoryLabel: string | null;
  extraPrice?: number | null;
  imageFileId: string | null;
  active: boolean;
}

interface OptionStageApiRow {
  stageId: string;
  stageCode: string;
  stageName: string;
  sequenceNo: number;
  required: boolean;
  choices: OptionChoiceApiRow[];
  selectedChoiceId: string | null;
}

interface OptionSessionApiRow {
  sessionId: string;
  orderItemId: string;
  orderItemName: string;
  productCategory: ProductCategory;
  optionSetVersion: { id: string; versionNo: number; status: string };
  selectionVersionNo: number;
  status: OptionSessionStatus;
  currentStageId: string | null;
  fabricName: string | null;
  startedAt: string | null;
  lastSavedAt: string | null;
  reviewedAt: string | null;
  confirmedAt: string | null;
  isCurrent: boolean;
  version: number;
  totalStages: number;
  completedStages: number;
  stages: OptionStageApiRow[];
  /** currentSession 응답에만 있다. */
  resumeStageId?: string | null;
}

function toStage(row: OptionStageApiRow): OptionStageView {
  return {
    stageId: row.stageId,
    order: row.sequenceNo,
    name: row.stageName,
    required: row.required,
    choices: row.choices.map((c) => ({
      choiceId: c.id,
      code: c.choiceCode,
      name: c.choiceName,
      extraPrice: Number(c.extraPrice ?? 0),
      imageUrl: c.imageFileId ? `/files/${c.imageFileId}` : null,
    })),
    selectedChoiceId: row.selectedChoiceId ?? null,
  };
}

function toOptionSession(row: OptionSessionApiRow): OptionSessionDetail {
  const stages = row.stages.map(toStage);
  // 백엔드에 lastStageOrder가 없어 선택값이 있는 마지막 단계 순번으로 대체한다.
  const lastSelected = stages.filter((s) => s.selectedChoiceId);
  return {
    sessionId: row.sessionId,
    orderItemId: row.orderItemId,
    displayName: row.orderItemName,
    productCategory: row.productCategory,
    optionSetVersionNo: row.optionSetVersion?.versionNo ?? 0,
    selectionVersionNo: row.selectionVersionNo,
    fabric: row.fabricName ?? null,
    status: row.status,
    currentStageId: row.currentStageId ?? null,
    resumeStageId: row.resumeStageId ?? null,
    lastSavedAt: toDateTime(row.lastSavedAt),
    totalStages: row.totalStages,
    completedStages: row.completedStages,
    lastStageOrder: lastSelected.length > 0 ? lastSelected[lastSelected.length - 1].order : 0,
    version: row.version,
    stages,
  };
}

/** §14.2 단계 임시저장 응답 */
export interface OptionStageSaveResult {
  sessionId: string;
  status: OptionSessionStatus;
  savedStageId: string;
  savedChoiceId: string;
  nextStageId: string | null;
  completedStages: number;
  totalStages: number;
  version: number;
}

export interface OptionReviewStage {
  stageId: string;
  order: number;
  name: string;
  required: boolean;
  choiceId: string | null;
  choiceName: string | null;
  /** 선택 시점 스냅샷 기준 추가금액(원) */
  extraPrice: number;
  /** 선택지 이미지 경로(/files/:id). 미등록이면 null → 화면은 색상 블록으로 폴백. */
  imageUrl: string | null;
}

/** OPT-003 확인서 (화면용) */
export interface OptionReviewData {
  sessionId: string;
  orderItemId: string;
  fabric: string | null;
  status: OptionSessionStatus;
  totalStages: number;
  completedStages: number;
  /** 백엔드 missingStages 배열 길이에서 파생 */
  missingCount: number;
  version: number;
  stages: OptionReviewStage[];
  surcharge: OptionSurcharge;
}

interface OptionReviewApiRow {
  sessionId: string;
  orderItemId: string;
  status: OptionSessionStatus;
  fabricName: string | null;
  totalStages: number;
  completedStages: number;
  missingStages: { stageId: string; stageName: string; required: boolean }[];
  stages: {
    stageId: string;
    stageCode: string;
    stageName: string;
    sequenceNo: number;
    required: boolean;
    selected: {
      choiceId: string;
      choiceCode: string;
      choiceName: string;
      extraPrice?: number | null;
      imageFileId?: string | null;
    } | null;
  }[];
  surcharge: OptionSurcharge;
  version: number;
}

function toOptionReview(row: OptionReviewApiRow): OptionReviewData {
  return {
    sessionId: row.sessionId,
    orderItemId: row.orderItemId,
    fabric: row.fabricName ?? null,
    status: row.status,
    totalStages: row.totalStages,
    completedStages: row.completedStages,
    missingCount: (row.missingStages ?? []).length,
    version: row.version,
    stages: (row.stages ?? []).map((s) => ({
      stageId: s.stageId,
      order: s.sequenceNo,
      name: s.stageName,
      required: s.required,
      choiceId: s.selected?.choiceId ?? null,
      choiceName: s.selected?.choiceName ?? null,
      extraPrice: Number(s.selected?.extraPrice ?? 0),
      imageUrl: s.selected?.imageFileId ? `/files/${s.selected.imageFileId}` : null,
    })),
    surcharge: row.surcharge,
  };
}

/** §14.3 최종 확정 응답 */
export interface OptionConfirmResult {
  sessionId: string;
  status: 'CONFIRMED';
  confirmedAt: string;
  optionSummary: { stageName: string; choiceName: string }[];
  surcharge: OptionSurcharge;
  version: number;
}

/** OPT-001 품목별 옵션 진행 목록. contractId 지정 시 해당 계약 품목만 조회. */
export function fetchOptionProgress(contractId?: string): Promise<OptionProgressItem[]> {
  return request<OptionProgressItem[]>({
    url: '/order-items/option-progress',
    params: contractId ? { contractId } : undefined,
  });
}

/**
 * 주문 품목의 현재 옵션 세션 조회 (ORD-001 §6.4).
 * 백엔드는 `{ session: {...} }` 또는 `{ session: null }`을 반환한다 — 세션이 없어도 200이다.
 */
export function fetchOptionSessionByItem(orderItemId: string): Promise<OptionSessionDetail | null> {
  return request<{ session: OptionSessionApiRow | null }>({
    url: `/order-items/${orderItemId}/option-session`,
  }).then((res) => (res.session ? toOptionSession(res.session) : null));
}

/** 옵션 선택 세션 시작 (§13.4) — 응답은 세션 상세(평면) */
export function startOptionSession(
  orderItemId: string,
  fabric?: string,
): Promise<OptionSessionDetail> {
  return request<OptionSessionApiRow>({
    url: `/order-items/${orderItemId}/option-sessions`,
    method: 'POST',
    data: { fabric },
  }).then(toOptionSession);
}

/** 옵션 세션 조회 */
export function fetchOptionSession(sessionId: string): Promise<OptionSessionDetail> {
  return request<OptionSessionApiRow>({ url: `/option-sessions/${sessionId}` }).then(
    toOptionSession,
  );
}

/** 단계 임시저장 (§14.2) */
export function saveOptionStage(
  sessionId: string,
  stageId: string,
  body: { choiceId: string; currentStageOrder: number; version: number },
): Promise<OptionStageSaveResult> {
  return request<OptionStageSaveResult>({
    url: `/option-sessions/${sessionId}/stages/${stageId}`,
    method: 'PUT',
    data: body,
  });
}

/** 중단 저장 후 목록 복귀 — 백엔드는 재개 지점을 stageId로 저장한다 */
export function pauseOptionSession(
  sessionId: string,
  currentStageId: string,
): Promise<{ sessionId: string; status: OptionSessionStatus; version: number }> {
  return request({
    url: `/option-sessions/${sessionId}/pause`,
    method: 'POST',
    data: { currentStageId },
  });
}

/** OPT-003 확인서 데이터 */
export function fetchOptionReview(sessionId: string): Promise<OptionReviewData> {
  return request<OptionReviewApiRow>({ url: `/option-sessions/${sessionId}/review` }).then(
    toOptionReview,
  );
}

/** 옵션 최종 확정 (§14.3) */
export function confirmOptionSession(
  sessionId: string,
  version: number,
): Promise<OptionConfirmResult> {
  return request<OptionConfirmResult>({
    url: `/option-sessions/${sessionId}/confirm`,
    method: 'POST',
    data: { version },
  });
}

/** 옵션 추가금액과 계약금액 차액 조회 */
export function fetchOptionSurcharge(sessionId: string): Promise<OptionSurcharge> {
  return request<OptionSurcharge>({ url: `/option-sessions/${sessionId}/surcharge` });
}

/**
 * 미반영 차액을 계약 현재 버전 금액에 반영한다.
 * 변경계약(새 버전)을 만들지 않고 금액만 고치며, 감사로그가 남는다.
 */
export function applyOptionSurcharge(sessionId: string): Promise<OptionSurcharge> {
  return request<OptionSurcharge>({
    url: `/option-sessions/${sessionId}/surcharge/apply`,
    method: 'POST',
  });
}

/** 동일 옵션 적용 (같은 대분류 품목으로 선택값 복사) — 응답은 새 세션 상세 */
export function copyOptionSession(
  sessionId: string,
  targetOrderItemId: string,
): Promise<OptionSessionDetail> {
  return request<OptionSessionApiRow>({
    url: `/option-sessions/${sessionId}/copy`,
    method: 'POST',
    data: { targetOrderItemId },
  }).then(toOptionSession);
}
