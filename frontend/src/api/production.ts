import { api, request, type ListResult } from './client';
import { labelOf } from '../shared/status-meta';
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

/** 품목·구성품 상태 표시명/색상 (품목 집계 상태 포함) */
export const PRODUCTION_STATUS_META: Record<string, { label: string; color: string }> = {
  RESERVED: { label: '예약', color: 'cyan' },
  CREATED: { label: '생성', color: 'default' },
  OPTION_PENDING: { label: '옵션 대기', color: 'default' },
  MEASUREMENT_PENDING: { label: '채촌 대기', color: 'default' },
  READY_TO_ORDER: { label: '발주 가능', color: 'cyan' },
  PRODUCTION_REQUESTED: { label: '제작 요청', color: 'blue' },
  PRODUCTION_IN_PROGRESS: { label: '제작 중', color: 'geekblue' },
  BASTING_RECEIVED: { label: '가봉 입고', color: 'purple' },
  FITTING_COMPLETED: { label: '가봉 완료', color: 'purple' },
  PRODUCTION_COMPLETED: { label: '제작 완료', color: 'volcano' },
  PARTIALLY_RECEIVED: { label: '부분 입고', color: 'orange' },
  RECEIVED: { label: '전체 입고', color: 'gold' },
  PARTIALLY_RELEASED: { label: '부분 출고', color: 'lime' },
  RELEASED: { label: '전체 출고', color: 'green' },
  COMPLETED: { label: '완료', color: 'green' },
  CANCELLED: { label: '취소', color: 'red' },
};

export const COMPONENT_TYPE_LABELS: Record<string, string> = {
  JACKET: '상의(자켓)',
  TROUSERS: '하의(팬츠)',
  VEST: '베스트',
  SHIRT: '셔츠',
  SHOES: '구두',
};

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
    contract: { customer: { id: string; name: string; phone: string } };
  };
  components: ProductionComponentApiRow[];
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

/** 화면용 제작 품목 행 — 중첩 관계를 평면화한다. */
export interface ProductionItem {
  orderItemId: string;
  displayName: string;
  productCategory: string;
  orderId: string;
  orderNo: string;
  transactionType: string;
  customerId: string;
  customerName: string;
  /** 백엔드 order_items.status */
  itemStatus: string;
  /** YYYY-MM-DD */
  completionDueDate?: string;
  components: ProductionComponent[];
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
    customerId: row.order.contract.customer.id,
    customerName: row.order.contract.customer.name,
    itemStatus: row.status,
    completionDueDate: toDateOnly(row.order.completionDueDate),
    components: (row.components ?? []).map(toProductionComponent),
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

/** 구성품 상태 변경·입출고 응답 (이벤트 + 갱신된 구성품 + 품목 집계 상태) */
export interface ComponentChangeResult {
  event: ProductionEvent;
  component: ProductionComponentApiRow;
  orderItemStatus: string;
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

/** PROD-001 목록 — GET /production/items (페이지 응답 `{ data, page }`) */
export function fetchProductionItems(): Promise<ProductionItem[]> {
  return request<ListResult<ProductionItemApiRow>>({
    url: '/production/items',
    params: { size: 100 },
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
