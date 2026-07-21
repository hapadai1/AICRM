import { request, type ListResult } from './client';

/**
 * 수선 도메인 API (화면·API 정의서 §13.7, 통합설계서 §12.1)
 * 코드값·응답 형태는 백엔드(`repairs.service.ts`)가 기준이다.
 */

/** 수선 유형 — 백엔드 REPAIR_TYPES */
export type RepairType = 'CUSTOM_DURING' | 'AFTER_SALE' | 'RENTAL_PRE' | 'RENTAL_POST' | 'GENERAL';

export const REPAIR_TYPES: RepairType[] = [
  'CUSTOM_DURING',
  'AFTER_SALE',
  'RENTAL_PRE',
  'RENTAL_POST',
  'GENERAL',
];

export const REPAIR_TYPE_LABELS: Record<RepairType, string> = {
  CUSTOM_DURING: '제작 중 수선',
  AFTER_SALE: '사후 수선',
  RENTAL_PRE: '렌탈 출고 전',
  RENTAL_POST: '렌탈 반납 후',
  GENERAL: '일반 수선',
};

/** 유형별 연결 대상 (백엔드 resolveLinks 규칙) */
export function repairLinkKind(type: RepairType): 'CUSTOM' | 'RENTAL' | 'NONE' {
  if (type === 'CUSTOM_DURING' || type === 'AFTER_SALE') return 'CUSTOM';
  if (type === 'RENTAL_PRE' || type === 'RENTAL_POST') return 'RENTAL';
  return 'NONE';
}

/** 수선 진행 상태 — 접수→수선 요청→수선 중→수선 입고→고객 연락→출고 완료 (+취소) */
export type RepairStatus =
  | 'RECEIVED'
  | 'REQUESTED'
  | 'IN_PROGRESS'
  | 'RETURNED_TO_SHOP'
  | 'CUSTOMER_NOTIFIED'
  | 'RELEASED'
  | 'CANCELLED';

/** 정방향 전이 순서. 백엔드는 "바로 다음 단계" 또는 CANCELLED만 허용한다. */
export const REPAIR_STATUS_FLOW: RepairStatus[] = [
  'RECEIVED',
  'REQUESTED',
  'IN_PROGRESS',
  'RETURNED_TO_SHOP',
  'CUSTOMER_NOTIFIED',
  'RELEASED',
];

export interface StatusMeta {
  label: string;
  color: string;
}

export const REPAIR_STATUS_META: Record<string, StatusMeta> = {
  RECEIVED: { label: '접수', color: 'default' },
  REQUESTED: { label: '수선 요청', color: 'cyan' },
  IN_PROGRESS: { label: '수선 중', color: 'blue' },
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
  return REPAIR_TYPE_LABELS[type as RepairType] ?? type;
}

/** 다음 정방향 상태. 흐름 밖 코드(CANCELLED 등)면 없음. */
export function nextRepairStatus(status: string): RepairStatus | undefined {
  const idx = REPAIR_STATUS_FLOW.indexOf(status as RepairStatus);
  return idx >= 0 ? REPAIR_STATUS_FLOW[idx + 1] : undefined;
}

/** 백엔드 원본 행 (REPAIR_SUMMARY_SELECT) */
interface RepairApiRow {
  id: string;
  repairType: string;
  requestDate: string;
  dueDate?: string | null;
  status: string;
  description: string;
  cost?: string | number | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
  customer: { id: string; name: string; phone: string };
  order?: { id: string; orderNo: string } | null;
  orderItem?: { id: string; displayName: string; productCategory: string } | null;
  component?: { id: string; componentType: string; sequenceNo: number } | null;
  rentalInventoryItem?: { id: string; managementCode: string } | null;
  statusEvents?: RepairEventApiRow[];
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

export interface RepairEvent {
  id: string;
  previousStatus?: string;
  newStatus: string;
  eventDate: string;
  notes?: string;
  actorName: string;
}

/** 화면용 수선 행 — 날짜·금액·대상 라벨을 정규화한 형태 */
export interface Repair {
  id: string;
  repairType: string;
  status: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  /** 연결 대상 표시 문자열 (품목·구성품·렌탈 실물 / 없으면 '-') */
  targetLabel: string;
  orderNo?: string;
  requestDate: string;
  dueDate?: string;
  description: string;
  cost?: number;
  notes?: string;
  events: RepairEvent[];
}

const COMPONENT_TYPE_LABELS: Record<string, string> = {
  JACKET: '자켓',
  TROUSERS: '바지',
  VEST: '베스트',
  SHIRT: '셔츠',
  SHOES: '구두',
};

/** `YYYY-MM-DD` 로 자른다. 백엔드 @db.Date는 UTC 자정 ISO 문자열로 온다. */
function toDateOnly(value?: string | null): string | undefined {
  return value ? value.slice(0, 10) : undefined;
}

function toNumber(value?: string | number | null): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isNaN(n) ? undefined : n;
}

function targetLabelOf(row: RepairApiRow): string {
  if (row.component) {
    const type = COMPONENT_TYPE_LABELS[row.component.componentType] ?? row.component.componentType;
    const item = row.orderItem ? `${row.orderItem.displayName} · ` : '';
    return `${item}${type} #${row.component.sequenceNo}`;
  }
  if (row.orderItem) return row.orderItem.displayName;
  if (row.rentalInventoryItem) return row.rentalInventoryItem.managementCode;
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
    targetLabel: targetLabelOf(row),
    orderNo: row.order?.orderNo,
    requestDate: toDateOnly(row.requestDate) ?? '',
    dueDate: toDateOnly(row.dueDate),
    description: row.description,
    cost: toNumber(row.cost),
    notes: row.notes ?? undefined,
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
  repairType: RepairType;
  requestDate: string;
  dueDate?: string;
  description: string;
  cost?: number;
  notes?: string;
  orderItemId?: string;
  componentId?: string;
  rentalInventoryItemId?: string;
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

/** 접수 모달 연결 대상 후보 — GET /repairs/link-targets?customerId= (연동정합화 계약 §8) */
export interface RepairLinkTargets {
  orderItems: {
    id: string;
    displayName: string;
    productCategory: string;
    sequenceNo: number;
    status: string;
    orderId: string;
    orderNo: string;
    components: { id: string; componentType: string; sequenceNo: number; status: string }[];
  }[];
  rentalItems: {
    id: string;
    managementCode: string;
    componentType: string;
    design: string;
    color: string;
    size: string;
    status: string;
  }[];
}

export function fetchRepairLinkTargets(customerId: string): Promise<RepairLinkTargets> {
  return request<RepairLinkTargets>({ url: '/repairs/link-targets', params: { customerId } });
}

export { COMPONENT_TYPE_LABELS as REPAIR_COMPONENT_TYPE_LABELS };
