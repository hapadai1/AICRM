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

/**
 * 대상 품목이 필수인 코드. 필수 규칙(백엔드 assertTargetProduct)이 이 코드들에 묶여 있어
 * 코드 집합과 달리 정적으로 둔다 — 새 코드는 선택 입력으로 취급된다.
 */
const CUSTOM_TYPES = ['CUSTOM_DURING', 'AFTER_SALE'];

/** 대상 품목 필수 여부 (백엔드 assertItems 규칙) */
export function isTargetProductRequired(type: string): boolean {
  return CUSTOM_TYPES.includes(type);
}

/** 수선 진행 상태 — 접수→수선 요청→수선 입고→고객 연락→출고 완료 (CANCELLED는 과거 데이터 표시용) */
export type RepairStatus =
  | 'RECEIVED'
  | 'REQUESTED'
  | 'RETURNED_TO_SHOP'
  | 'CUSTOMER_NOTIFIED'
  | 'RELEASED'
  | 'CANCELLED';

/**
 * 진행 단계 순서. 백엔드는 "바로 다음 단계"(진행) 또는 "바로 이전 단계"(되돌리기)만 허용한다.
 * 상태는 "그 단계를 끝낸 시점"을 뜻한다 — 접수 등록이 곧 접수 완료다.
 */
export const REPAIR_STATUS_FLOW: RepairStatus[] = [
  'RECEIVED',
  'REQUESTED',
  'RETURNED_TO_SHOP',
  'CUSTOMER_NOTIFIED',
  'RELEASED',
];

/**
 * 업무 버튼 — 각 버튼은 "그 단계를 끝냈다"를 기록한다(수선 화면 하단 업무 처리).
 * 접수는 등록으로 이미 끝났으므로 버튼이 없다.
 */
export const REPAIR_WORK_ACTIONS: { status: RepairStatus; label: string }[] = [
  { status: 'REQUESTED', label: '수선요청 완료' },
  { status: 'RETURNED_TO_SHOP', label: '입고 완료' },
  { status: 'CUSTOMER_NOTIFIED', label: '고객 연락' },
  { status: 'RELEASED', label: '출고 완료' },
];

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
}

interface RepairEventApiRow {
  id: string;
  previousStatus?: string | null;
  newStatus: string;
  eventDate: string;
  notes?: string | null;
  createdAt: string;
  actor?: { id: string; displayName: string } | null;
}

/** 수선 대상 한 줄 — 품목(component-type 코드)과 개수 */
export interface RepairItem {
  targetProduct: string;
  quantity: number;
}

export interface RepairEvent {
  id: string;
  previousStatus?: string;
  newStatus: string;
  eventDate: string;
  notes?: string;
  actorName: string;
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
  /** 대상 표시 문자열 (품목 ×개수 / 구방식 연결 품목·구성품 / 없으면 '-') */
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

/** 대상 품목 한 줄의 표시명: `상의 ×2` */
export function repairItemLabel(item: RepairItem): string {
  return `${COMPONENT_TYPE_LABELS[item.targetProduct] ?? item.targetProduct} ×${item.quantity}`;
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
      targetProduct: i.targetProduct,
      quantity: i.quantity,
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
  /** 대상 품목·개수. 맞춤 수선은 1줄 이상 필수 */
  items?: RepairItem[];
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

/** 수선 상태 변경 — POST /repairs/{id}/status-events */
export function postRepairStatusEvent(
  repairId: string,
  body: { newStatus: RepairStatus; eventDate?: string; notes?: string },
): Promise<RepairStatusEventResult> {
  return request({ url: `/repairs/${repairId}/status-events`, method: 'POST', data: body });
}

export { COMPONENT_TYPE_LABELS as REPAIR_COMPONENT_TYPE_LABELS };
