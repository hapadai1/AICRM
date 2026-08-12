import { api, downloadFile, request, type ListResult } from './client';
import { labelOf } from '../shared/status-meta';
// 구성품 표시명은 중앙(api/code-labels) 공유 맵을 재노출한다(관리자 편집 전 화면 반영).
import { COMPONENT_TYPE_LABELS } from './code-labels';
import { ITEM_STATUS_RANK } from './status-catalog';
import { toDateOnly, toDateTime } from './transform';

/**
 * 제작·입출고·가봉 도메인 API (화면·API 정의서 §13.5, PROD-001 / FIT-001)
 * 응답 형태는 백엔드(`production.service.ts`)가 기준이다.
 * 백엔드는 Prisma raw row를 그대로 내보내므로 여기서 화면용 뷰로 변환한다.
 */

/**
 * 제작·입출고 상태 코드 (02_데이터모델설계서 §13.4).
 * RESERVED는 렌탈 배정 구성품의 초기 상태로 제작 흐름(COMPONENT_STATUS_FLOW) 밖에 있다.
 */
export type ComponentStatus =
  | 'RESERVED'
  | 'CREATED'
  | 'PRODUCTION_REQUESTED'
  | 'PRODUCTION_IN_PROGRESS'
  | 'BASTING_RECEIVED'
  | 'PRODUCTION_COMPLETED'
  | 'RECEIVED'
  | 'RELEASED'
  | 'CANCELLED';

/** 구성품 상태 진행 순서 (역행 판정 기준). 흐름 밖 상태는 순번을 갖지 않는다. */
export const COMPONENT_STATUS_RANK: Record<string, number> = {
  CREATED: 0,
  PRODUCTION_REQUESTED: 1,
  PRODUCTION_IN_PROGRESS: 2,
  BASTING_RECEIVED: 3,
  PRODUCTION_COMPLETED: 4,
  RECEIVED: 5,
  RELEASED: 6,
};

/** 역행 후보에서 제외하는 상태 (취소·렌탈 예약은 되돌릴 대상이 아니다) */
const NON_FLOW_STATUSES: string[] = ['CANCELLED', 'RESERVED'];

/** 정방향 허용 전이 — 이 목록에 없는 하위 상태 이동은 역행(사유 필수) */
export const COMPONENT_FORWARD_TRANSITIONS: Record<string, ComponentStatus[]> = {
  // 렌탈 예약 구성품은 제작 없이 입고/출고로 진행한다.
  RESERVED: ['RECEIVED', 'RELEASED'],
  CREATED: ['PRODUCTION_REQUESTED'],
  PRODUCTION_REQUESTED: ['PRODUCTION_IN_PROGRESS'],
  PRODUCTION_IN_PROGRESS: ['BASTING_RECEIVED', 'PRODUCTION_COMPLETED'],
  BASTING_RECEIVED: ['PRODUCTION_IN_PROGRESS', 'PRODUCTION_COMPLETED'],
  PRODUCTION_COMPLETED: ['RECEIVED'],
  RECEIVED: ['RELEASED'],
  RELEASED: [],
  CANCELLED: [],
};

/** 미등록 코드가 와도 죽지 않도록 항상 이 함수로 조회한다. */
export function forwardTransitions(from: string): ComponentStatus[] {
  return COMPONENT_FORWARD_TRANSITIONS[from] ?? [];
}

/** 역행 후보: 현재보다 낮은 순번이면서 정방향 목록에 없는 상태 */
export function backwardTransitions(from: string): ComponentStatus[] {
  const rank = COMPONENT_STATUS_RANK[from];
  if (rank === undefined) return [];
  const forward = forwardTransitions(from);
  return (Object.keys(COMPONENT_STATUS_RANK) as ComponentStatus[]).filter(
    (s) =>
      s !== from &&
      !NON_FLOW_STATUSES.includes(s) &&
      COMPONENT_STATUS_RANK[s] < rank &&
      !forward.includes(s),
  );
}

export function isBackwardTransition(from: string, to: string): boolean {
  const fromRank = COMPONENT_STATUS_RANK[from];
  const toRank = COMPONENT_STATUS_RANK[to];
  if (fromRank === undefined || toRank === undefined) return false;
  return !forwardTransitions(from).includes(to as ComponentStatus) && toRank < fromRank;
}

/**
 * 품목 상태의 흐름 순위·표시명은 중앙 사전(api/status-catalog)이 정본이다 (2026-08-05).
 * 여기서는 기존 소비처의 import 경로를 지키기 위해 재노출만 한다.
 */
export { ITEM_STATUS_RANK, ORDER_ITEM_STATUS_META as PRODUCTION_STATUS_META } from './status-catalog';

/**
 * [제작요청 완료]를 누를 수 있는가 (설계서 11 §9 — 작업지시서 출력과 커플링하지 않는 독립 버튼).
 * 백엔드 `validateTransition`이 허용하는 범위(제작요청보다 앞선 상태, 취소 아님)와 같게 둔다.
 * 중간 단계 건너뛰기는 허용되므로 "발주 가능"까지 와야만 눌리는 식으로 좁히지 않는다.
 */
export function canRequestProduction(itemStatus: string): boolean {
  const rank = ITEM_STATUS_RANK[itemStatus];
  return rank !== undefined && rank < ITEM_STATUS_RANK.PRODUCTION_REQUESTED;
}

export { COMPONENT_TYPE_LABELS };

// --- 백엔드 원본 행 ---------------------------------------------------------

/** COMPONENT_SELECT */
interface ProductionComponentApiRow {
  id: string;
  componentType: string;
  sequenceNo: number;
  status: string;
  expectedInboundDate: string | null;
  actualInboundAt: string | null;
  actualOutboundAt: string | null;
  notes: string | null;
  active: boolean;
}

/** listProductionItems select (order_items 원본 행) */
interface ProductionItemApiRow {
  id: string;
  displayName: string;
  productCategory: string;
  sequenceNo: number;
  status: string;
  createdAt: string;
  order: {
    id: string;
    orderNo: string;
    transactionType: string;
    completionDueDate: string | null;
    contractId: string;
    contract: {
      contractNo: string;
      contractType: { name: string } | null;
      customer: { id: string; name: string; phone: string };
    };
  };
  components: ProductionComponentApiRow[];
  workOrder: {
    workOrderId: string | null;
    status: string;
    docStatus: string;
    workOrderFileKey: string | null;
    currentFileName: string | null;
    uploadedFileName: string | null;
    lastIssuedAt: string | null;
    canIssue: boolean;
    optionConfirmedAt: string | null;
    measurementLinkedAt: string | null;
  };
}

/** 화면용 구성품 행 — 날짜를 표시 형식으로 정규화한다. */
export interface ProductionComponent {
  id: string;
  componentType: string;
  sequenceNo: number;
  status: string;
  /** YYYY-MM-DD */
  expectedInboundDate?: string;
  /** YYYY-MM-DD HH:mm */
  actualInboundAt?: string;
  /** YYYY-MM-DD HH:mm */
  actualOutboundAt?: string;
  notes?: string;
  active: boolean;
}

/** 작업지시서 뷰 (제작 품목 행에 얹혀 오는 출력 게이트 상태) */
export interface ProductionWorkOrderView {
  workOrderId?: string;
  /** WAITING | UNORDERED | CURRENT */
  status: string;
  /** 작성중 | 완료 — 발주가 완료로 만든다 (2026-08-05) */
  docStatus: string;
  /** 파일이 있으면 작업지시서 id — 없으면 아직 뽑지 않았다 */
  workOrderFileKey?: string;
  /** 최신 파일명 (수기 최종본이 있으면 그 이름) */
  currentFileName?: string;
  /** 수기 최종본 파일명 — 있으면 다운로드가 이 파일을 준다 (2026-08-05) */
  uploadedFileName?: string;
  /** YYYY-MM-DD HH:mm */
  lastIssuedAt?: string;
  /** 출력 가능 여부 (준비 미완이면 false) */
  canIssue: boolean;
  /** 옵션 확정 시각 (YYYY-MM-DD HH:mm) — 준비 단계가 이 값을 그대로 보여준다 */
  optionConfirmedAt?: string;
  /** 채촌 연결 시각 (YYYY-MM-DD HH:mm) */
  measurementLinkedAt?: string;
}

/** 화면용 제작 품목 행 — 중첩 관계를 평면화한다. */
export interface ProductionItem {
  orderItemId: string;
  displayName: string;
  productCategory: string;
  orderId: string;
  orderNo: string;
  transactionType: string;
  contractId: string;
  contractNo: string;
  /** 계약 구분 이름 (계약 목록의 같은 열). 계약에 구분이 없으면 null */
  contractTypeName: string | null;
  customerId: string;
  customerName: string;
  customerPhone: string;
  /** 백엔드 order_items.status */
  itemStatus: string;
  /** YYYY-MM-DD */
  completionDueDate?: string;
  components: ProductionComponent[];
  /** 작업지시서 출력 게이트 상태 (통합: 제작 관리 코크핏에서 한 행에 표시) */
  workOrder: ProductionWorkOrderView;
}

function toProductionComponent(row: ProductionComponentApiRow): ProductionComponent {
  return {
    id: row.id,
    componentType: row.componentType,
    sequenceNo: row.sequenceNo,
    status: row.status,
    expectedInboundDate: toDateOnly(row.expectedInboundDate),
    actualInboundAt: toDateTime(row.actualInboundAt),
    actualOutboundAt: toDateTime(row.actualOutboundAt),
    notes: row.notes ?? undefined,
    active: row.active,
  };
}

function toProductionItem(row: ProductionItemApiRow): ProductionItem {
  return {
    orderItemId: row.id,
    displayName: row.displayName,
    productCategory: row.productCategory,
    orderId: row.order.id,
    orderNo: row.order.orderNo,
    transactionType: row.order.transactionType,
    contractId: row.order.contractId,
    contractNo: row.order.contract.contractNo,
    contractTypeName: row.order.contract.contractType?.name ?? null,
    customerId: row.order.contract.customer.id,
    customerName: row.order.contract.customer.name,
    customerPhone: row.order.contract.customer.phone,
    itemStatus: row.status,
    completionDueDate: toDateOnly(row.order.completionDueDate),
    components: (row.components ?? []).map(toProductionComponent),
    workOrder: {
      workOrderId: row.workOrder.workOrderId ?? undefined,
      status: row.workOrder.status,
      docStatus: row.workOrder.docStatus,
      workOrderFileKey: row.workOrder.workOrderFileKey ?? undefined,
      currentFileName: row.workOrder.currentFileName ?? undefined,
      uploadedFileName: row.workOrder.uploadedFileName ?? undefined,
      lastIssuedAt: toDateTime(row.workOrder.lastIssuedAt),
      canIssue: row.workOrder.canIssue,
      optionConfirmedAt: toDateTime(row.workOrder.optionConfirmedAt),
      measurementLinkedAt: toDateTime(row.workOrder.measurementLinkedAt),
    },
  };
}

/** 제작 이벤트 (EVENT_SELECT) */
export interface ProductionEvent {
  id: string;
  orderItemId: string;
  componentId: string | null;
  eventType: string;
  previousStatus: string | null;
  newStatus: string;
  eventDate: string;
  notes: string | null;
  createdAt: string;
  actor: { id: string; displayName: string } | null;
}

/**
 * 제작 이력 한 줄 — 단계 줄에 붙일 날짜·담당자만 남긴 화면용 뷰.
 * 품목 단위 이벤트(제작요청 완료 등)는 componentId가 비어 있다.
 */
export interface ProductionHistoryEvent {
  id: string;
  orderItemId: string;
  componentId: string | null;
  newStatus: string;
  /** YYYY-MM-DD */
  eventDate: string;
  actorName: string;
  notes?: string;
}

/**
 * 주문 단위 제작 이력 — GET /orders/{id}/production-history (§13.5).
 * 백엔드가 시간 오름차순으로 내려주므로 순서를 그대로 쓴다(뒤로 갈수록 최신).
 */
export function fetchOrderProductionHistory(orderId: string): Promise<ProductionHistoryEvent[]> {
  return request<{ events: ProductionEvent[] }>({
    url: `/orders/${orderId}/production-history`,
  }).then((res) =>
    (res.events ?? []).map((e) => ({
      id: e.id,
      orderItemId: e.orderItemId,
      componentId: e.componentId,
      newStatus: e.newStatus,
      eventDate: toDateOnly(e.eventDate) ?? '',
      actorName: e.actor?.displayName ?? '시스템',
      notes: e.notes ?? undefined,
    })),
  );
}

/** 이력 색인 키 — 품목/구성품 어느 쪽 이벤트든 그 주체 id와 상태로 찾는다. */
export function historyKey(ownerId: string, status: string): string {
  return `${ownerId}:${status}`;
}

/**
 * `주체 → 상태 → 마지막 이벤트` 색인.
 * 이벤트가 시간순으로 오므로 그냥 덮어쓰면 최신이 남는다 — 되돌렸다 다시 진행해도
 * 그 단계의 최신 날짜·담당자가 보인다(수선 목록의 lastEvent와 같은 규칙).
 *
 * 한 이벤트를 두 키로 넣는다: 구성품 키(그 구성품 칸)와 품목 키(단계 줄 요약).
 * 품목 키에는 구성품 이벤트도 섞여 들어가므로 "그 품목에서 이 단계가 마지막으로 일어난 때"가 된다.
 */
export function indexHistory(events: ProductionHistoryEvent[]): Map<string, ProductionHistoryEvent> {
  const map = new Map<string, ProductionHistoryEvent>();
  for (const e of events) {
    if (e.componentId) map.set(historyKey(e.componentId, e.newStatus), e);
    map.set(historyKey(e.orderItemId, e.newStatus), e);
  }
  return map;
}

/** 백엔드 고객 연락 제안 (NotificationSuggestionService.build 결과) */
export interface ProductionNotificationSuggestion {
  templateId: string;
  templateCode: string;
  templateName: string;
  channel: string;
  recipientPhone: string;
  customerId: string;
  orderId: string | null;
  variables: Record<string, string>;
  renderedBody: string;
  triggerKey: string;
}

/** 구성품 상태 변경·입출고 응답 (이벤트 + 갱신된 구성품 + 품목 집계 상태) */
export interface ComponentChangeResult {
  event: ProductionEvent;
  component: ProductionComponentApiRow;
  orderItemStatus: string;
  /**
   * 하위호환용 필드 — 설계서 v2 02 §8(D7 일원화) 이후 백엔드가 **항상 null**을 내려준다.
   * 완성복 입고 고객 연락은 진행(journey) PRODUCT_RECEIVED 단계에서만 제안한다(이중 노출 방지).
   */
  suggestedNotification?: ProductionNotificationSuggestion | null;
}

/** 가봉 보정 항목 */
/**
 * 가봉 표준 확인 항목 (개발설계서 05 G-04).
 * 설계 PDF 1페이지 "실루엣·균형·여유분·길이 확인" 대응.
 */
export const FITTING_AREA_CODES = ['SILHOUETTE', 'BALANCE', 'EASE', 'LENGTH', 'ETC'] as const;
export type FittingAreaCode = (typeof FITTING_AREA_CODES)[number];

export const FITTING_AREA_LABELS: Record<FittingAreaCode, string> = {
  SILHOUETTE: '실루엣',
  BALANCE: '균형',
  EASE: '여유분',
  LENGTH: '길이',
  ETC: '기타',
};

/** 커버리지 판정 대상 (기타 제외) */
export const FITTING_STANDARD_AREAS: FittingAreaCode[] = [
  'SILHOUETTE',
  'BALANCE',
  'EASE',
  'LENGTH',
];

export function fittingAreaLabel(code: string): string {
  return FITTING_AREA_LABELS[code as FittingAreaCode] ?? code;
}

export interface FittingAdjustment {
  id: string;
  componentId: string | null;
  /** 구성품 표시명 (없으면 '전체') */
  componentLabel: string;
  areaCode: string;
  area: string;
  instruction: string;
}

/** 화면용 가봉 기록 */
export interface FittingRecord {
  id: string;
  orderItemId: string;
  appointmentId: string | null;
  /** YYYY-MM-DD */
  fittingDate: string;
  notes?: string;
  /** YYYY-MM-DD */
  nextAppointmentDate?: string;
  createdAt: string;
  adjustments: FittingAdjustment[];
  /** 4대 표준 항목 기재 여부 — 미기재는 막지 않고 화면에서 경고만 한다 */
  coverage: Record<string, boolean>;
}

interface FittingApiRow {
  id: string;
  orderItemId: string;
  appointmentId: string | null;
  fittingDate: string;
  notes: string | null;
  nextAppointmentDate: string | null;
  createdAt: string;
  adjustments: {
    id: string;
    componentId: string | null;
    areaCode: string;
    area: string;
    instruction: string;
    component: { id: string; componentType: string } | null;
  }[];
  coverage?: Record<string, boolean>;
}

function toFitting(row: FittingApiRow): FittingRecord {
  return {
    id: row.id,
    orderItemId: row.orderItemId,
    appointmentId: row.appointmentId ?? null,
    fittingDate: toDateOnly(row.fittingDate) ?? '',
    notes: row.notes ?? undefined,
    nextAppointmentDate: toDateOnly(row.nextAppointmentDate),
    createdAt: row.createdAt,
    adjustments: (row.adjustments ?? []).map((a) => ({
      id: a.id,
      componentId: a.componentId ?? null,
      componentLabel: a.component
        ? labelOf(COMPONENT_TYPE_LABELS, a.component.componentType)
        : '전체',
      areaCode: a.areaCode,
      area: a.area,
      instruction: a.instruction,
    })),
    coverage: row.coverage ?? {},
  };
}

/**
 * PROD-001 목록 — GET /production/items (페이지 응답 `{ data, page }`). contractId 지정 시 해당 계약 품목만.
 * includePrep: 준비 중(발주 이전) 품목까지 포함 — 계약 상세 화면이 진행 단계 대상과 짝을 맞추기 위함.
 */
export function fetchProductionItems(
  contractId?: string,
  opts?: { includePrep?: boolean },
): Promise<ProductionItem[]> {
  return request<ListResult<ProductionItemApiRow>>({
    url: '/production/items',
    params: {
      size: 100,
      ...(contractId ? { contractId } : {}),
      ...(opts?.includePrep ? { includePrep: true } : {}),
    },
  }).then((res) => res.data.map(toProductionItem));
}

/** 구성품 상태 변경 — POST /components/{id}/status-events (§13.5) */
export function postComponentStatusEvent(
  componentId: string,
  body: { toStatus: ComponentStatus; reason?: string; eventDate?: string },
): Promise<ComponentChangeResult> {
  return request<ComponentChangeResult>({
    url: `/components/${componentId}/status-events`,
    method: 'POST',
    // 백엔드 DTO 필드는 newStatus 다 (CreateProductionEventDto)
    data: { newStatus: body.toStatus, reason: body.reason, eventDate: body.eventDate },
  });
}

/** 구성품 입고 — POST /components/{id}/receive (§13.5) */
export function receiveComponent(
  componentId: string,
  body: { receivedDate: string; notes?: string },
): Promise<ComponentChangeResult> {
  return request<ComponentChangeResult>({
    url: `/components/${componentId}/receive`,
    method: 'POST',
    // 백엔드 DTO 필드는 receivedAt 이다 (ReceiveComponentDto)
    data: { receivedAt: body.receivedDate, notes: body.notes },
  });
}

/**
 * 단계 처리 취소 — POST /order-items/{id}/undo-stage.
 * 잘못 누른 것을 없던 일로 되돌린다(그 단계가 찍은 상태·일자만 지운다).
 */
export function undoStage(
  orderItemId: string,
  body: { effect: string; componentId?: string },
): Promise<{ id: string; status: string }> {
  return request<{ id: string; status: string }>({
    url: `/order-items/${orderItemId}/undo-stage`,
    method: 'POST',
    data: body,
  });
}

/** 구성품 출고 — POST /components/{id}/release (§13.5) */
export function releaseComponent(
  componentId: string,
  body: { releasedDate: string; notes?: string },
): Promise<ComponentChangeResult> {
  return request<ComponentChangeResult>({
    url: `/components/${componentId}/release`,
    method: 'POST',
    // 백엔드 DTO 필드는 releasedAt 이다 (ReleaseComponentDto)
    data: { releasedAt: body.releasedDate, notes: body.notes },
  });
}

/** 품목 제작 상태 이벤트(제작 요청 등) — POST /order-items/{id}/production-events (§13.5) */
export function postItemProductionEvent(
  orderItemId: string,
  body: { toStatus: string; reason?: string },
): Promise<ProductionEvent> {
  return request<ProductionEvent>({
    url: `/order-items/${orderItemId}/production-events`,
    method: 'POST',
    // 백엔드 DTO 필드는 newStatus 다 (CreateProductionEventDto)
    data: { newStatus: body.toStatus, reason: body.reason },
  });
}

/** 가봉 이력 — GET /order-items/{id}/fittings (§13.5) */
export function fetchFittings(orderItemId: string): Promise<FittingRecord[]> {
  return request<FittingApiRow[]>({ url: `/order-items/${orderItemId}/fittings` }).then((rows) =>
    rows.map(toFitting),
  );
}

/** 가봉 기록 저장 — POST /order-items/{id}/fittings (§13.5) */
export interface CreateFittingInput {
  fittingDate: string;
  /** 보정 지시 — 구성품별로 부위·지시를 남긴다 */
  adjustments: { componentId?: string; areaCode?: FittingAreaCode; area: string; instruction: string }[];
  notes?: string;
  /** 다음 방문(가봉) 예정일 */
  nextAppointmentDate?: string;
}

export function createFitting(
  orderItemId: string,
  body: CreateFittingInput,
): Promise<FittingRecord> {
  return request<FittingApiRow>({
    url: `/order-items/${orderItemId}/fittings`,
    method: 'POST',
    data: {
      fittingDate: body.fittingDate,
      adjustments: body.adjustments,
      ...(body.notes ? { notes: body.notes } : {}),
      ...(body.nextAppointmentDate ? { nextAppointmentDate: body.nextAppointmentDate } : {}),
    },
  }).then(toFitting);
}

/**
 * 가봉 수정지시서 Excel 다운로드 (개발설계서 05 G-04).
 * 공장 전달은 이메일 수동 발송이므로 파일만 받아 첨부한다.
 */
export async function downloadFittingSheet(fittingId: string): Promise<void> {
  const res = await api.get(`/fittings/${fittingId}/sheet`, { responseType: 'blob' });
  const disposition = String(res.headers['content-disposition'] ?? '');
  const match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
  const fileName = match ? decodeURIComponent(match[1]) : `fitting-${fittingId}.xlsx`;

  const url = URL.createObjectURL(res.data as Blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// 가봉 첨부 파일 (설계서 v2 06 §5.4) — 공장에 보낸 가봉 작업지시서 보관. EntityFile 재사용.
// ---------------------------------------------------------------------------

/** 가봉 세션 첨부 (백엔드 listFittingFiles 응답) */
export interface FittingFile {
  /** File id — 다운로드·삭제 키 */
  id: string;
  /** EntityFile id (링크 자체의 id) */
  entityFileId: string;
  purpose: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  /** `/api/v1/files/:id` — 인증 헤더가 필요해 blob으로 받아야 한다 */
  downloadUrl: string;
  createdAt: string;
}

/** 첨부 목록 — GET /fittings/{id}/files */
export function fetchFittingFiles(fittingId: string): Promise<FittingFile[]> {
  return request<FittingFile[]>({ url: `/fittings/${fittingId}/files` }).then((r) => r ?? []);
}

/** 첨부 업로드 — POST /fittings/{id}/files (multipart, 필드명 `file`) */
export function uploadFittingFile(fittingId: string, file: File): Promise<FittingFile> {
  const form = new FormData();
  form.append('file', file);
  return request<FittingFile>({
    url: `/fittings/${fittingId}/files`,
    method: 'POST',
    data: form,
  });
}

/** 첨부 제거 — DELETE /fittings/{id}/files/{fileId} (경로 파라미터는 File id) */
export function deleteFittingFile(
  fittingId: string,
  fileId: string,
): Promise<{ id: string; deleted: boolean }> {
  return request<{ id: string; deleted: boolean }>({
    url: `/fittings/${fittingId}/files/${fileId}`,
    method: 'DELETE',
  });
}

/** 첨부 내려받기 — 인증 헤더가 필요하므로 blob 다운로드를 쓴다. */
export function downloadFittingFile(file: FittingFile): Promise<void> {
  return downloadFile(`/files/${file.id}`, file.originalName);
}
