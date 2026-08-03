import { request, type ListResult } from './client';
// 코드 집합·표시명 모두 중앙(api/code-labels) 공유 객체를 쓴다 — 원본은 서버 기준정보 상수다.
import {
  COMPONENT_TYPE_CODES,
  COMPONENT_TYPE_LABELS,
  REPAIR_TYPE_CODES,
  REPAIR_TYPE_LABELS_MAP,
} from './code-labels';

/**
 * 수선 도메인 API (화면·API 정의서 §13.7, 통합설계서 §12.1)
 * 코드값·응답 형태는 백엔드(`repairs.service.ts`)가 기준이다.
 */

/**
 * 수선 유형 코드 집합 — `GET /code-labels`(repair-type)로 하이드레이션되는 공유 배열.
 * 렌탈 수선은 여기서 다루지 않는다(렌탈 진행의 수선요청·입고·출고 단계에서 관리).
 */
export const REPAIR_TYPES = REPAIR_TYPE_CODES;

export const REPAIR_TYPE_LABELS = REPAIR_TYPE_LABELS_MAP;

/**
 * 수선 대상 품목 코드 집합 — `GET /code-labels`(component-type)로 하이드레이션되는 공유 배열.
 * 계약에 등록된 주문 품목을 찾아 연결하지 않고 이 목록(상의·하의·베스트·셔츠·구두)에서 고른다.
 */
export const REPAIR_TARGET_PRODUCTS = COMPONENT_TYPE_CODES;

/** 수선 진행 상태 — 접수→수선 요청→수선 입고→고객 연락→출고 완료 (CANCELLED는 과거 데이터 표시용) */
export type RepairStatus =
  | 'RECEIVED'
  | 'REQUESTED'
  | 'RETURNED_TO_SHOP'
  | 'CUSTOMER_NOTIFIED'
  | 'RELEASED'
  | 'CANCELLED';

/**
 * 진행 단계 순서. 상태는 "그 단계를 끝낸 시점"을 뜻한다 — 접수 등록이 곧 접수 완료다.
 * 고객 연락을 빼면 모두 품목 진행에서 계산되는 값이다(백엔드 rollupStatus).
 */
export const REPAIR_STATUS_FLOW: RepairStatus[] = [
  'RECEIVED',
  'REQUESTED',
  'RETURNED_TO_SHOP',
  'CUSTOMER_NOTIFIED',
  'RELEASED',
];

/** 벌 하나의 진행 — 대기 → 입고 완료 → 출고 완료 */
export type RepairUnitStatus = 'PENDING' | 'RETURNED' | 'RELEASED';

export const REPAIR_UNIT_STATUS_LABELS: Record<RepairUnitStatus, string> = {
  PENDING: '대기',
  RETURNED: '입고 완료',
  RELEASED: '출고 완료',
};

export interface StatusMeta {
  label: string;
  color: string;
}

export const REPAIR_STATUS_META: Record<string, StatusMeta> = {
  RECEIVED: { label: '접수', color: 'default' },
  REQUESTED: { label: '수선 요청', color: 'cyan' },
  RETURNED_TO_SHOP: { label: '수선 입고', color: 'gold' },
  CUSTOMER_NOTIFIED: { label: '고객 연락', color: 'purple' },
  RELEASED: { label: '출고 완료', color: 'green' },
  CANCELLED: { label: '취소', color: 'red' },
};

/** 미등록 코드가 와도 화면이 죽지 않도록 코드 그대로 표시한다. */
export function repairStatusMeta(status: string): StatusMeta {
  return REPAIR_STATUS_META[status] ?? { label: status, color: 'default' };
}

export function repairTypeLabel(type: string): string {
  return REPAIR_TYPE_LABELS[type] ?? type;
}

/** 다음 정방향 상태. 흐름 밖 코드(CANCELLED 등)면 없음. */
export function nextRepairStatus(status: string): RepairStatus | undefined {
  const idx = REPAIR_STATUS_FLOW.indexOf(status as RepairStatus);
  return idx >= 0 ? REPAIR_STATUS_FLOW[idx + 1] : undefined;
}

/** 이전 단계 상태(한 단계 되돌리기). 첫 단계(접수)·흐름 밖 코드면 없음. */
export function prevRepairStatus(status: string): RepairStatus | undefined {
  const idx = REPAIR_STATUS_FLOW.indexOf(status as RepairStatus);
  return idx > 0 ? REPAIR_STATUS_FLOW[idx - 1] : undefined;
}

/** 백엔드 원본 행 (REPAIR_SUMMARY_SELECT) */
interface RepairApiRow {
  id: string;
  repairType: string;
  requestDate: string;
  dueDate?: string | null;
  status: string;
  description: string;
  notes?: string | null;
  items?: RepairItemApiRow[];
  receiptMethod?: string | null;
  releaseMethod?: string | null;
  pickupAddress?: string | null;
  deliveryAddress?: string | null;
  createdAt: string;
  updatedAt: string;
  customer: { id: string; name: string; phone: string };
  order?: { id: string; orderNo: string } | null;
  orderItem?: { id: string; displayName: string; productCategory: string } | null;
  component?: { id: string; componentType: string; sequenceNo: number } | null;
  statusEvents?: RepairEventApiRow[];
}

interface RepairItemApiRow {
  id: string;
  targetProduct: string;
  quantity: number;
  sequenceNo: number;
  requestedAt?: string | null;
  units?: { id: string; unitNo: number; status: string }[];
}

interface RepairEventApiRow {
  id: string;
  repairRequestItemId?: string | null;
  repairRequestItemUnitId?: string | null;
  previousStatus?: string | null;
  newStatus: string;
  eventDate: string;
  notes?: string | null;
  createdAt: string;
  actor?: { id: string; displayName: string } | null;
}

/**
 * 수선 대상 한 줄 — 품목(component-type 코드)과 개수.
 * 수선요청은 이 줄 단위로 한 번(상의 2벌은 같이 나간다), 입고·출고는 아래 벌 단위다.
 */
export interface RepairItem {
  id: string;
  targetProduct: string;
  quantity: number;
  /** 수선요청을 끝낸 날짜. 없으면 아직 요청 전 */
  requestedAt?: string;
  units: RepairUnit[];
}

/** 입고·출고를 세는 최소 단위(벌) */
export interface RepairUnit {
  id: string;
  unitNo: number;
  status: RepairUnitStatus;
}

export interface RepairEvent {
  id: string;
  /** 줄 단위 이벤트(수선요청)면 그 줄 id */
  itemId?: string;
  /** 벌 단위 이벤트(입고·출고)면 그 벌 id */
  unitId?: string;
  previousStatus?: string;
  newStatus: string;
  eventDate: string;
  notes?: string;
  actorName: string;
}

/** 건 전체 진척 — 표 아래 "입고 1/3 · 출고 0/3" 표기용 */
export interface RepairProgress {
  requestedLines: number;
  totalLines: number;
  returned: number;
  released: number;
  totalUnits: number;
}

export function repairProgress(items: RepairItem[]): RepairProgress {
  const units = items.flatMap((item) => item.units);
  return {
    requestedLines: items.filter((item) => item.requestedAt).length,
    totalLines: items.length,
    // 출고된 벌도 입고를 지나왔다 — 입고 수는 누적으로 센다.
    returned: units.filter((unit) => unit.status !== 'PENDING').length,
    released: units.filter((unit) => unit.status === 'RELEASED').length,
    totalUnits: units.length,
  };
}

/** 접수·출고 방식 (개발설계서 05 G-07) — 택배는 운영하지 않는다 */
export const REPAIR_RECEIPT_METHODS = ['VISIT', 'PICKUP'] as const;
export const REPAIR_RELEASE_METHODS = ['VISIT', 'DELIVERY'] as const;
export type RepairReceiptMethod = (typeof REPAIR_RECEIPT_METHODS)[number];
export type RepairReleaseMethod = (typeof REPAIR_RELEASE_METHODS)[number];

export const REPAIR_METHOD_LABELS: Record<string, string> = {
  VISIT: '고객 방문',
  PICKUP: '방문 수거',
  DELIVERY: '방문 배송',
};

/** 화면용 수선 행 — 날짜·대상 라벨을 정규화한 형태 (비용 필드는 v2 D6으로 제거) */
export interface Repair {
  id: string;
  repairType: string;
  status: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  /** 대상 품목·개수 (접수 입력 순서) */
  items: RepairItem[];
  /** 대상 표시 문자열 (품목 개수 / 구방식 연결 품목·구성품 / 없으면 '-') */
  targetLabel: string;
  orderNo?: string;
  requestDate: string;
  dueDate?: string;
  description: string;
  notes?: string;
  receiptMethod?: RepairReceiptMethod;
  releaseMethod?: RepairReleaseMethod;
  pickupAddress?: string;
  deliveryAddress?: string;
  events: RepairEvent[];
}

/** `YYYY-MM-DD` 로 자른다. 백엔드 @db.Date는 UTC 자정 ISO 문자열로 온다. */
function toDateOnly(value?: string | null): string | undefined {
  return value ? value.slice(0, 10) : undefined;
}

/** 대상 품목 한 줄의 표시명: `상의 2` */
export function repairItemLabel(item: { targetProduct: string; quantity: number }): string {
  return `${COMPONENT_TYPE_LABELS[item.targetProduct] ?? item.targetProduct} ${item.quantity}`;
}

function targetLabelOf(row: RepairApiRow): string {
  if (row.items?.length) return row.items.map(repairItemLabel).join(' · ');
  // 아래는 계약 품목을 연결하던 시절 접수된 건의 표시 — 신규 접수는 items만 쓴다.
  if (row.component) {
    const type = COMPONENT_TYPE_LABELS[row.component.componentType] ?? row.component.componentType;
    const item = row.orderItem ? `${row.orderItem.displayName} · ` : '';
    return `${item}${type} #${row.component.sequenceNo}`;
  }
  if (row.orderItem) return row.orderItem.displayName;
  return '-';
}

function toRepair(row: RepairApiRow): Repair {
  return {
    id: row.id,
    repairType: row.repairType,
    status: row.status,
    customerId: row.customer.id,
    customerName: row.customer.name,
    customerPhone: row.customer.phone,
    items: (row.items ?? []).map((i) => ({
      id: i.id,
      targetProduct: i.targetProduct,
      quantity: i.quantity,
      requestedAt: toDateOnly(i.requestedAt),
      units: (i.units ?? []).map((u) => ({
        id: u.id,
        unitNo: u.unitNo,
        status: u.status as RepairUnitStatus,
      })),
    })),
    targetLabel: targetLabelOf(row),
    orderNo: row.order?.orderNo,
    requestDate: toDateOnly(row.requestDate) ?? '',
    dueDate: toDateOnly(row.dueDate),
    description: row.description,
    notes: row.notes ?? undefined,
    receiptMethod: (row.receiptMethod as RepairReceiptMethod) ?? undefined,
    releaseMethod: (row.releaseMethod as RepairReleaseMethod) ?? undefined,
    pickupAddress: row.pickupAddress ?? undefined,
    deliveryAddress: row.deliveryAddress ?? undefined,
    events: (row.statusEvents ?? []).map((e) => ({
      id: e.id,
      itemId: e.repairRequestItemId ?? undefined,
      unitId: e.repairRequestItemUnitId ?? undefined,
      previousStatus: e.previousStatus ?? undefined,
      newStatus: e.newStatus,
      eventDate: toDateOnly(e.eventDate) ?? '',
      notes: e.notes ?? undefined,
      actorName: e.actor?.displayName ?? '-',
    })),
  };
}

export interface RepairListParams {
  status?: string;
  customerId?: string;
  /** 출고완료(RELEASED) 건 제외 — 상태를 지정하지 않았을 때만 적용된다 */
  excludeReleased?: boolean;
  page?: number;
  size?: number;
}

/** REPAIR-001 목록 — GET /repairs */
export function fetchRepairs(params: RepairListParams): Promise<ListResult<Repair>> {
  return request<ListResult<RepairApiRow>>({
    url: '/repairs',
    params: {
      status: params.status || undefined,
      customerId: params.customerId || undefined,
      excludeReleased: params.excludeReleased ? true : undefined,
      page: params.page ?? 1,
      size: params.size ?? 30,
    },
  }).then((res) => ({ ...res, data: res.data.map(toRepair) }));
}

/** 수선 상세 — GET /repairs/{id} (상태 이력 포함) */
export function fetchRepair(id: string): Promise<Repair> {
  return request<RepairApiRow>({ url: `/repairs/${id}` }).then(toRepair);
}

export interface CreateRepairInput {
  customerId: string;
  receiptMethod?: RepairReceiptMethod;
  releaseMethod?: RepairReleaseMethod;
  pickupAddress?: string;
  deliveryAddress?: string;
  /** 코드 집합은 서버 기준정보(repair-type)가 정한다 */
  repairType: string;
  requestDate: string;
  dueDate?: string;
  description: string;
  notes?: string;
  /** 대상 품목·개수. 유형과 무관하게 1줄 이상 필수 */
  items?: { targetProduct: string; quantity: number }[];
}

/** 수선 접수 — POST /repairs */
export function createRepair(body: CreateRepairInput): Promise<Repair> {
  return request<RepairApiRow>({ url: '/repairs', method: 'POST', data: body }).then(toRepair);
}

/**
 * 상태 변경 응답에 실려 오는 고객 연락 제안 (개발설계서 05 G-06).
 * 연락 대상 상태(접수·수선 완료)이고 규칙이 켜져 있을 때만 채워진다.
 */
export interface RepairNotificationSuggestion {
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

export interface RepairStatusEventResult extends RepairEventApiRow {
  suggestedNotification: RepairNotificationSuggestion | null;
}

/**
 * 건 단위 상태 변경 — POST /repairs/{id}/status-events.
 * 이제 고객 연락(과 되돌리기)만 이 경로를 쓴다. 나머지 단계는 품목 진행에서 계산된다.
 */
export function postRepairStatusEvent(
  repairId: string,
  body: { newStatus: RepairStatus; eventDate?: string; notes?: string },
): Promise<RepairStatusEventResult> {
  return request({ url: `/repairs/${repairId}/status-events`, method: 'POST', data: body });
}

/** 품목 진행 입력 — 날짜를 안 주면 서버가 오늘로 찍는다 */
export interface RepairProgressInput {
  eventDate?: string;
  notes?: string;
}

/** 수선요청 완료 (줄 단위) — POST /repairs/{id}/items/{itemId}/request */
export function requestRepairItem(
  repairId: string,
  itemId: string,
  body: RepairProgressInput = {},
): Promise<Repair> {
  return request<RepairApiRow>({
    url: `/repairs/${repairId}/items/${itemId}/request`,
    method: 'POST',
    data: body,
  }).then(toRepair);
}

/** 수선요청 되돌리기 — DELETE /repairs/{id}/items/{itemId}/request */
export function revertRepairItemRequest(repairId: string, itemId: string): Promise<Repair> {
  return request<RepairApiRow>({
    url: `/repairs/${repairId}/items/${itemId}/request`,
    method: 'DELETE',
  }).then(toRepair);
}

/** 벌 하나 입고·출고 — POST /repairs/{id}/units/{unitId}/return|release */
export function advanceRepairUnit(
  repairId: string,
  unitId: string,
  toStatus: Exclude<RepairUnitStatus, 'PENDING'>,
  body: RepairProgressInput = {},
): Promise<Repair> {
  return request<RepairApiRow>({
    url: `/repairs/${repairId}/units/${unitId}/${toStatus === 'RETURNED' ? 'return' : 'release'}`,
    method: 'POST',
    data: body,
  }).then(toRepair);
}

/** 벌 진행 한 칸 되돌리기 — DELETE /repairs/{id}/units/{unitId}/status */
export function revertRepairUnit(repairId: string, unitId: string): Promise<Repair> {
  return request<RepairApiRow>({
    url: `/repairs/${repairId}/units/${unitId}/status`,
    method: 'DELETE',
  }).then(toRepair);
}

export { COMPONENT_TYPE_LABELS as REPAIR_COMPONENT_TYPE_LABELS };
