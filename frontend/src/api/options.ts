import { request } from './client';
import { toDateTime } from './transform';

/**
 * 옵션 선택 도메인 API (화면·API 정의서 §13.4, OPT-001~003)
 * 응답 형태는 백엔드(`option-sessions.service.ts`)가 기준이다.
 * 백엔드는 Prisma raw row를 그대로 내보내므로 여기서 화면용 뷰로 변환한다.
 */

/** 옵션 진행 상태 (core-data contractItems.status와 동일) */
export type OptionStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'REVIEW' | 'CONFIRMED';
export type ProductCategory = 'SUIT' | 'SHIRT' | 'SHOES';

/**
 * 맞춤 옵션 부위(구성품) 그룹 (설계서 04 §2.3 / 백엔드 option-component-groups.ts와 동일).
 * 품목 대분류 → 부위 그룹 목록. 맞춤 세션의 부위별 원단·컬러·패턴 입력과
 * 옵션세트 단계의 componentGroup 축을 공유한다.
 */
export const OPTION_COMPONENT_GROUPS: Record<ProductCategory, string[]> = {
  SUIT: ['JACKET', 'TROUSERS', 'VEST'],
  SHIRT: ['SHIRT'],
  SHOES: ['SHOES'],
};

/** 부위 그룹 코드 → 한글 라벨 (백엔드 COMPONENT_GROUP_LABELS와 동일) */
export const COMPONENT_GROUP_LABELS: Record<string, string> = {
  JACKET: '상의(자켓)',
  TROUSERS: '하의(바지)',
  VEST: '베스트',
  SHIRT: '셔츠',
  SHOES: '구두',
};

/** 카테고리의 부위 그룹 목록 (미지정 카테고리는 빈 배열) */
export function componentGroupsFor(
  category: ProductCategory | string | null | undefined,
): string[] {
  return category ? (OPTION_COMPONENT_GROUPS[category as ProductCategory] ?? []) : [];
}

/** 부위 그룹 코드의 표시 라벨(미등록 코드는 코드 그대로) */
export function componentGroupLabel(group: string): string {
  return COMPONENT_GROUP_LABELS[group] ?? group;
}

/**
 * 부위(구성품 그룹)별 원단·컬러·패턴·비고 (설계서 04 §2).
 * 세션 detail/review 응답의 `components[]` 각 원소. 저장값이 없으면 각 필드 null.
 */
export interface OptionComponentAttr {
  componentGroup: string;
  fabricName: string | null;
  colorName: string | null;
  patternName: string | null;
  notes: string | null;
}

/** 부위별 원단·컬러·패턴·비고 입력 (start body / component-attrs upsert 공용) */
export interface ComponentAttrInput {
  fabricName?: string;
  colorName?: string;
  patternName?: string;
  notes?: string;
}

/**
 * 목록의 부위(구성품 그룹) 슬롯 — 부위별 원단·컬러·패턴 + 그 부위 단계의 진행 수.
 * 스타일 컨설팅 목록이 품목 1행이 아니라 부위 1행으로 펼치기 위한 축이다.
 */
export interface OptionProgressComponent extends OptionComponentAttr {
  totalStages: number;
  completedStages: number;
  /**
   * 이 부위가 계약 품목에서 빠졌는가 — 베스트만 해당 ([베스트 제외] 체크 상태).
   * 제외해도 행은 남는다: 체크를 다시 풀 자리가 있어야 하기 때문이다 (현업 확정 2026-08-01).
   */
  excluded?: boolean;
}

/** OPT-001 목록 행 — 백엔드 progress()가 이미 평면 형태로 내려준다. */
export interface OptionProgressItem {
  contractItemId: string;
  displayName: string;
  productCategory: ProductCategory;
  contractId: string;
  contractNo: string;
  /** 계약 구분 이름 (계약 목록의 같은 열). 계약에 구분이 없으면 null */
  contractTypeName: string | null;
  customerName: string;
  /** 고객 전화번호 (목록에서 고객 식별용) */
  customerPhone: string;
  /** 완료 예정일(납기) ISO. 없으면 null */
  completionDueDate: string | null;
  fabric: string | null;
  status: OptionStatus;
  /** 계약 상태 — 작성중(DRAFT)이 아니면 컨설팅은 보기 전용 (현업 확정 2026-07-31) */
  contractStatus: string;
  /** 계약일 ISO. 계약완료 전에는 null → 목록은 작성일(contractCreatedAt)로 대신 건다. */
  contractedAt: string | null;
  /** 계약서 작성일 ISO */
  contractCreatedAt: string;
  /** 제작 진행 중(제작요청 이후) 품목 — 계약이 작성중이어도 컨설팅 잠금 */
  inProduction: boolean;
  completedStages: number;
  totalStages: number;
  sessionId: string | null;
  /** 부위 슬롯 (설계서 04 §2.3). 카테고리 상수 기반이라 세션 이전에도 항상 내려온다. */
  components: OptionProgressComponent[];
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
    afterTotalAmount: number;
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
  /** 이 단계가 속한 부위(JACKET/TROUSERS/VEST…). 부위별 옵션 팝업이 이 값으로 단계를 거른다. */
  componentGroup: string | null;
}

/** 세션 상태 — 백엔드는 NOT_STARTED도 내려준다. */
export type OptionSessionStatus = OptionStatus;

/** OPT-002 선택 세션 상세 (화면용) */
export interface OptionSessionDetail {
  sessionId: string;
  contractItemId: string;
  /** 백엔드 contractItemName */
  displayName: string;
  productCategory: ProductCategory;
  /** 백엔드 optionSetVersion.versionNo */
  optionSetVersionNo: number;
  selectionVersionNo: number;
  /** 백엔드 fabricName */
  fabric: string | null;
  status: OptionSessionStatus;
  /** 계약 상태 — 작성중(DRAFT)이 아니면 편집·옵션 변경 버튼을 숨긴다 */
  contractStatus: string | null;
  /** 제작 진행 중 품목 — 계약이 작성중이어도 편집 잠금 */
  inProduction: boolean;
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
  /** 부위별 원단·컬러·패턴·비고 (설계서 04 §2). 카테고리별 부위 슬롯이 백엔드에서 내려온다. */
  components: OptionComponentAttr[];
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
  componentGroup?: string | null;
}

interface OptionSessionApiRow {
  sessionId: string;
  contractItemId: string;
  contractItemName: string;
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
  contractStatus?: string | null;
  inProduction?: boolean;
  totalStages: number;
  completedStages: number;
  stages: OptionStageApiRow[];
  /** 부위별 원단·컬러·패턴·비고 (설계서 04 §2). 백엔드 buildComponents() 결과. */
  components?: OptionComponentAttr[];
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
    componentGroup: row.componentGroup ?? null,
  };
}

function toOptionSession(row: OptionSessionApiRow): OptionSessionDetail {
  const stages = row.stages.map(toStage);
  // 백엔드에 lastStageOrder가 없어 선택값이 있는 마지막 단계 순번으로 대체한다.
  const lastSelected = stages.filter((s) => s.selectedChoiceId);
  return {
    sessionId: row.sessionId,
    contractItemId: row.contractItemId,
    displayName: row.contractItemName,
    productCategory: row.productCategory,
    optionSetVersionNo: row.optionSetVersion?.versionNo ?? 0,
    selectionVersionNo: row.selectionVersionNo,
    fabric: row.fabricName ?? null,
    status: row.status,
    contractStatus: row.contractStatus ?? null,
    inProduction: row.inProduction ?? false,
    currentStageId: row.currentStageId ?? null,
    resumeStageId: row.resumeStageId ?? null,
    lastSavedAt: toDateTime(row.lastSavedAt),
    totalStages: row.totalStages,
    completedStages: row.completedStages,
    lastStageOrder: lastSelected.length > 0 ? lastSelected[lastSelected.length - 1].order : 0,
    version: row.version,
    stages,
    components: row.components ?? [],
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
  contractItemId: string;
  fabric: string | null;
  status: OptionSessionStatus;
  /** 계약 상태 — 작성중(DRAFT)이 아니면 확정·변경·금액반영 버튼을 숨긴다 */
  contractStatus: string | null;
  /** 제작 진행 중 품목 — 계약이 작성중이어도 편집 잠금 */
  inProduction: boolean;
  totalStages: number;
  completedStages: number;
  /**
   * 미선택 **필수** 단계 수.
   * 확정은 필수/선택 구분 없이 모든 단계를 골라야 하므로(백엔드 confirm도 동일),
   * 확정 가능 여부는 missingCount + missingOptionalCount로 판단한다.
   */
  missingCount: number;
  /** 미선택 선택(비필수) 단계 수 */
  missingOptionalCount: number;
  version: number;
  stages: OptionReviewStage[];
  /** 부위별 원단·컬러·패턴·비고 (설계서 04 §2). 확인서에 부위 선택·입력 출력용. */
  components: OptionComponentAttr[];
  surcharge: OptionSurcharge;
  /**
   * 이 벌에서 베스트를 뺐는가 — 확정 팝업의 "계약서 변경내용"에 알린다.
   * 베스트 금액은 자동 차감하지 않는다(값이 그때그때 달라 계약서에서 수기 조정).
   */
  vestExcluded: boolean;
  /** 품목 표시명 (정장 #2) — 확정 팝업에서 어느 벌인지 가리킨다 */
  displayName: string;
}

interface OptionReviewApiRow {
  sessionId: string;
  contractItemId: string;
  displayName?: string | null;
  vestExcluded?: boolean;
  status: OptionSessionStatus;
  contractStatus?: string | null;
  inProduction?: boolean;
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
  components?: OptionComponentAttr[];
  surcharge: OptionSurcharge;
  version: number;
}

function toOptionReview(row: OptionReviewApiRow): OptionReviewData {
  const missing = row.missingStages ?? [];
  return {
    sessionId: row.sessionId,
    contractItemId: row.contractItemId,
    displayName: row.displayName ?? '',
    vestExcluded: row.vestExcluded ?? false,
    fabric: row.fabricName ?? null,
    status: row.status,
    contractStatus: row.contractStatus ?? null,
    inProduction: row.inProduction ?? false,
    totalStages: row.totalStages,
    completedStages: row.completedStages,
    missingCount: missing.filter((m) => m.required).length,
    missingOptionalCount: missing.filter((m) => !m.required).length,
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
    components: row.components ?? [],
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
    url: '/contract-items/option-progress',
    params: contractId ? { contractId } : undefined,
  });
}

/**
 * 계약 품목의 현재 옵션 세션 조회 (ORD-001 §6.4).
 * 백엔드는 `{ session: {...} }` 또는 `{ session: null }`을 반환한다 — 세션이 없어도 200이다.
 */
export function fetchOptionSessionByItem(contractItemId: string): Promise<OptionSessionDetail | null> {
  return request<{ session: OptionSessionApiRow | null }>({
    url: `/contract-items/${contractItemId}/option-session`,
  }).then((res) => (res.session ? toOptionSession(res.session) : null));
}

/** start body의 부위별 입력 항목 (componentGroup 지정) */
export interface StartComponentAttrInput extends ComponentAttrInput {
  componentGroup: string;
}

/**
 * 옵션 선택 세션 시작 (§13.4) — 응답은 세션 상세(평면).
 * componentAttrs를 함께 보내면 부위별 원단·컬러·패턴을 시작 시점에 upsert한다(설계서 04 §2.4).
 */
export function startOptionSession(
  contractItemId: string,
  fabric?: string,
  componentAttrs?: StartComponentAttrInput[],
): Promise<OptionSessionDetail> {
  return request<OptionSessionApiRow>({
    url: `/contract-items/${contractItemId}/option-sessions`,
    method: 'POST',
    data: { fabric, componentAttrs },
  }).then(toOptionSession);
}

/** PUT /option-sessions/:id/component-attrs/:group 응답 */
export interface SaveComponentAttrResult {
  sessionId: string;
  componentGroup: string;
  component: OptionComponentAttr | null;
  version: number;
}

/**
 * 부위(구성품 그룹)별 원단·컬러·패턴·비고 upsert (설계서 04 §2.4, 낙관적 잠금).
 * 확정(CONFIRMED) 세션은 백엔드가 거부한다. 저장 시 세션 rowVersion이 증가한다.
 */
export function saveOptionComponentAttr(
  sessionId: string,
  group: string,
  body: ComponentAttrInput & { version: number },
): Promise<SaveComponentAttrResult> {
  return request<SaveComponentAttrResult>({
    url: `/option-sessions/${sessionId}/component-attrs/${group}`,
    method: 'PUT',
    data: body,
  });
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
  targetContractItemId: string,
): Promise<OptionSessionDetail> {
  return request<OptionSessionApiRow>({
    url: `/option-sessions/${sessionId}/copy`,
    method: 'POST',
    data: { targetContractItemId },
  }).then(toOptionSession);
}

// ---------------------------------------------------------------------------
// 옵션세트 관리(ADMIN-002) — 부위 그룹(componentGroup) 세분 (설계서 04 §3)
//
// api/admin.ts 의 옵션세트 함수는 componentGroup 축이 없어, 부위별 세분이 필요한
// 관리자 화면(정장 세트)은 아래 함수로 버전 상세 조회·단계 저장을 대신한다.
// (버전 목록·새 버전·활성화는 api/admin.ts 를 그대로 재사용한다.)
// ---------------------------------------------------------------------------

const OPTION_SET_STATUS = ['DRAFT', 'ACTIVE', 'RETIRED'] as const;
export type AdminOptionSetStatus = (typeof OPTION_SET_STATUS)[number];

export interface AdminOptionChoice {
  id: string;
  /** 선택지 코드(A/B/C…) */
  slot: string;
  name: string;
  factoryName?: string;
  /** 이 선택지를 고를 때 계약금액에 더해지는 추가금액(원) */
  extraPrice: number;
  imageFileId?: string;
  imageUrl: string | null;
}

export interface AdminOptionStage {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  required: boolean;
  /** 부위 그룹(JACKET/TROUSERS/VEST). 셔츠·구두 등 단일 부위는 null. */
  componentGroup: string | null;
  choices: AdminOptionChoice[];
}

export interface AdminOptionSetVersionDetail {
  id: string;
  optionSetId: string;
  versionNo: number;
  status: AdminOptionSetStatus;
  stages: AdminOptionStage[];
}

export interface AdminOptionStageInput {
  id?: string;
  code?: string;
  name: string;
  sortOrder: number;
  required: boolean;
  componentGroup?: string | null;
  choices: {
    slot: string;
    name: string;
    factoryName?: string;
    extraPrice?: number;
    imageFileId?: string;
  }[];
}

interface AdminOptionChoiceApiRow {
  id: string;
  choiceCode: string;
  choiceName: string;
  factoryLabel?: string | null;
  extraPrice?: number | null;
  imageFileId?: string | null;
  active: boolean;
}

interface AdminOptionStageApiRow {
  id: string;
  stageCode: string;
  stageName: string;
  sequenceNo: number;
  required: boolean;
  componentGroup?: string | null;
  active: boolean;
  choices: AdminOptionChoiceApiRow[];
}

interface AdminOptionSetVersionApiRow {
  id: string;
  optionSetId: string;
  versionNo: number;
  status: AdminOptionSetStatus;
  stages?: AdminOptionStageApiRow[];
}

function toAdminVersionDetail(v: AdminOptionSetVersionApiRow): AdminOptionSetVersionDetail {
  return {
    id: v.id,
    optionSetId: v.optionSetId,
    versionNo: v.versionNo,
    status: v.status,
    stages: (v.stages ?? []).map((s) => ({
      id: s.id,
      code: s.stageCode,
      name: s.stageName,
      sortOrder: s.sequenceNo,
      required: s.required,
      componentGroup: s.componentGroup ?? null,
      choices: s.choices.map((c) => ({
        id: c.id,
        slot: c.choiceCode,
        name: c.choiceName,
        factoryName: c.factoryLabel ?? undefined,
        extraPrice: Number(c.extraPrice ?? 0),
        imageFileId: c.imageFileId ?? undefined,
        imageUrl: c.imageFileId ? `/files/${c.imageFileId}` : null,
      })),
    })),
  };
}

/** 신규 단계의 stageCode를 단계명(ASCII)에서 생성 (기존 단계는 서버 코드 유지). api/admin.ts와 동일 규칙. */
function adminStageCodes(stages: AdminOptionStageInput[]): string[] {
  const used = new Set(stages.map((s) => s.code).filter((c): c is string => !!c));
  return stages.map((s, index) => {
    if (s.code) return s.code;
    const ascii = s.name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const base = (ascii || `STAGE_${index + 1}`).slice(0, 36);
    let code = base;
    let suffix = 2;
    while (used.has(code)) {
      code = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(code);
    return code;
  });
}

/** 옵션세트 버전 상세 (부위 그룹 포함) 조회 — 관리자 화면 편집용 */
export async function fetchAdminOptionSetVersion(
  versionId: string,
): Promise<AdminOptionSetVersionDetail> {
  return toAdminVersionDetail(
    await request<AdminOptionSetVersionApiRow>({ url: `/option-set-versions/${versionId}` }),
  );
}

/** 옵션세트 단계 저장 (부위 그룹 포함, DRAFT만) — saveStages 입력에 componentGroup 전달 */
export async function saveAdminOptionStages(
  versionId: string,
  stages: AdminOptionStageInput[],
): Promise<AdminOptionSetVersionDetail> {
  const codes = adminStageCodes(stages);
  return toAdminVersionDetail(
    await request<AdminOptionSetVersionApiRow>({
      url: `/option-set-versions/${versionId}/stages`,
      method: 'PUT',
      data: {
        stages: stages.map((s, i) => ({
          stageCode: codes[i],
          stageName: s.name,
          sequenceNo: s.sortOrder,
          required: s.required,
          componentGroup: s.componentGroup ?? null,
          choices: s.choices.map((c) => ({
            choiceCode: c.slot,
            choiceName: c.name,
            factoryLabel: c.factoryName,
            extraPrice: c.extraPrice ?? 0,
            imageFileId: c.imageFileId,
          })),
        })),
      },
    }),
  );
}
