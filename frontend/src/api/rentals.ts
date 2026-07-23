import { request, type ListResult } from './client';
import { COMPONENT_TYPE_LABELS } from './code-labels';

/**
 * 렌탈 실물 품목 구분 (연동정합화 계약 §5 — 백엔드 RENTAL_COMPONENT_TYPES와 동일).
 * 주문 구성품 componentType과 같은 코드 체계를 쓴다.
 */
export type RentalComponentType = 'JACKET' | 'TROUSERS' | 'VEST' | 'SHIRT' | 'SHOES';

// 구성품 표시명은 중앙(api/code-labels) 공유 맵을 재노출한다(관리자 편집 전 화면 반영).
export const RENTAL_COMPONENT_TYPE_LABELS = COMPONENT_TYPE_LABELS as Record<RentalComponentType, string>;

/** 관리코드 접두어 (자동 생성·표시용) */
export const RENTAL_CODE_PREFIX: Record<RentalComponentType, string> = {
  JACKET: 'JKT',
  TROUSERS: 'PNT',
  VEST: 'VST',
  SHIRT: 'SHT',
  SHOES: 'SHO',
};

/** 렌탈 실물 상태 (02_데이터모델설계서 §13.3) */
export type RentalItemStatus =
  | 'AVAILABLE'
  | 'RESERVED'
  | 'PREPARING'
  | 'ALTERATION'
  | 'CHECKED_OUT'
  | 'RETURNED_HOLD'
  | 'UNAVAILABLE'
  | 'RETIRED';

export const RENTAL_ITEM_STATUS_META: Record<RentalItemStatus, { label: string; color: string }> = {
  AVAILABLE: { label: '대여 가능', color: 'green' },
  RESERVED: { label: '예약됨', color: 'blue' },
  PREPARING: { label: '준비 중', color: 'cyan' },
  ALTERATION: { label: '수선 중', color: 'purple' },
  CHECKED_OUT: { label: '대여 중', color: 'geekblue' },
  RETURNED_HOLD: { label: '반납 대기', color: 'orange' },
  UNAVAILABLE: { label: '사용 불가', color: 'red' },
  RETIRED: { label: '사용 종료', color: 'default' },
};

/** 렌탈 배정 상태 (02_데이터모델설계서 §13.3) */
export type AllocationStatus = 'RESERVED' | 'PREPARING' | 'CHECKED_OUT' | 'RETURNED' | 'CANCELLED';

export const ALLOCATION_STATUS_META: Record<AllocationStatus, { label: string; color: string }> = {
  RESERVED: { label: '예약', color: 'blue' },
  PREPARING: { label: '준비 중', color: 'cyan' },
  CHECKED_OUT: { label: '출고', color: 'geekblue' },
  RETURNED: { label: '반납', color: 'green' },
  CANCELLED: { label: '취소', color: 'default' },
};

/** 반납 처리 시 선택 가능한 다음 실물 상태 (백엔드 RETURN_NEXT_ITEM_STATUSES) */
export const RETURN_NEXT_STATUSES: RentalItemStatus[] = [
  'RETURNED_HOLD',
  'ALTERATION',
  'UNAVAILABLE',
  'AVAILABLE',
];

export interface RentalAllocationSummary {
  id: string;
  customerName: string;
  orderNo: string;
  pickupDate: string;
  returnDueDate: string;
  status: AllocationStatus;
}

/** 렌탈 실물 뷰 (응답 필드: managementCode / componentType / notes — 계약 §5) */
export interface RentalItem {
  id: string;
  managementCode: string;
  componentType: RentalComponentType;
  design: string;
  color: string;
  size: string;
  status: RentalItemStatus;
  availableFrom?: string;
  notes?: string;
  version: number;
  currentAllocation?: RentalAllocationSummary;
}

export interface RentalItemEvent {
  id: string;
  at: string;
  type: 'STATUS' | 'RENTAL' | 'ID_CHANGE' | 'REPAIR' | 'REGISTER';
  label: string;
  detail?: string;
  reason?: string;
  by: string;
}

/** 배정 뷰: allocation + 실물 managementCode + 고객/주문 (계약 §5) */
export interface RentalAllocation {
  id: string;
  inventoryItemId: string;
  managementCode: string;
  componentId?: string;
  componentType?: RentalComponentType;
  componentLabel: string;
  orderId: string;
  orderNo: string;
  customerId?: string;
  customerName: string;
  pickupDate: string;
  returnDueDate: string;
  availabilityEndDate: string;
  status: AllocationStatus;
  checkoutDate?: string;
  returnDate?: string;
  /** 기준일 대비 픽업/반납 지연 여부 (목록 뷰) */
  overdue?: boolean;
  version: number;
}

export interface RentalItemDetail {
  item: RentalItem;
  allocations: RentalAllocation[];
  events: RentalItemEvent[];
}

/** RENT-003 배정 대상 렌탈 주문 구성품 + 현재 배정 (GET /rental-orders/components 뷰) */
export interface RentalOrderComponent {
  componentId: string;
  componentType: RentalComponentType;
  sequenceNo?: number;
  status: string;
  orderItemId: string;
  displayName: string;
  productCategory?: string;
  orderId: string;
  orderNo: string;
  customerId?: string;
  customerName: string;
  currentAllocation: {
    id: string;
    status: AllocationStatus;
    pickupDate: string;
    returnDueDate: string;
    availabilityEndDate: string;
    inventoryItemId: string;
    managementCode: string;
    version: number;
  } | null;
}

export interface RentalItemFilters {
  componentType?: RentalComponentType;
  design?: string;
  color?: string;
  /** SKU 사이즈 필터 — 쿼리 파라미터 skuSize (page size와 충돌 회피) */
  skuSize?: string;
  status?: RentalItemStatus;
  /** 해당 일자에 대여 가능 예정인 실물만 */
  availableOn?: string;
  page?: number;
  size_?: number;
}

/** 백엔드 원본 행(중첩 rentalSku/allocations/rowVersion)을 화면 뷰(RentalItem)로 평면화한다. */
interface RawRentalItem {
  id: string;
  managementCode: string;
  status: RentalItemStatus;
  availableFrom?: string | null;
  notes?: string | null;
  rowVersion?: number;
  version?: number;
  componentType?: RentalComponentType;
  design?: string;
  color?: string;
  size?: string;
  rentalSku?: { componentType: RentalComponentType; design: string; color: string; size: string };
  currentAllocation?: RentalAllocationSummary | null;
  allocations?: Array<{
    id: string;
    status: AllocationStatus;
    pickupDate: string;
    returnDueDate: string;
    orderItemComponent?: {
      orderItem?: {
        displayName?: string;
        order?: { orderNo?: string; contract?: { customer?: { id?: string; name?: string } } };
      };
    };
  }>;
}

const dateOnly = (v?: string | null): string | undefined => (v ? String(v).slice(0, 10) : undefined);

export function toRentalItem(raw: RawRentalItem): RentalItem {
  const sku = raw.rentalSku;
  const active = raw.allocations?.find((a) => ['RESERVED', 'PREPARING', 'CHECKED_OUT'].includes(a.status));
  const currentAllocation =
    raw.currentAllocation ??
    (active
      ? {
          id: active.id,
          status: active.status,
          customerName: active.orderItemComponent?.orderItem?.order?.contract?.customer?.name ?? '-',
          orderNo: active.orderItemComponent?.orderItem?.order?.orderNo ?? '-',
          pickupDate: dateOnly(active.pickupDate) ?? '',
          returnDueDate: dateOnly(active.returnDueDate) ?? '',
        }
      : undefined);
  return {
    id: raw.id,
    managementCode: raw.managementCode,
    componentType: raw.componentType ?? sku?.componentType ?? 'JACKET',
    design: raw.design ?? sku?.design ?? '-',
    color: raw.color ?? sku?.color ?? '-',
    size: raw.size ?? sku?.size ?? '-',
    status: raw.status,
    availableFrom: dateOnly(raw.availableFrom),
    notes: raw.notes ?? undefined,
    version: raw.version ?? raw.rowVersion ?? 0,
    currentAllocation: currentAllocation ?? undefined,
  };
}

/** RENT-001 실물 목록 — GET /rental-inventory (§13.6, 계약 §5) */
export function fetchRentalItems(filters: RentalItemFilters): Promise<ListResult<RentalItem>> {
  const params: Record<string, string | number> = {};
  if (filters.componentType) params.componentType = filters.componentType;
  if (filters.design) params.design = filters.design;
  if (filters.color) params.color = filters.color;
  if (filters.skuSize) params.skuSize = filters.skuSize;
  if (filters.status) params.status = filters.status;
  if (filters.availableOn) params.availableOn = filters.availableOn;
  params.page = filters.page ?? 1;
  params.size = filters.size_ ?? 30;
  return request<ListResult<RawRentalItem>>({ url: '/rental-inventory', params }).then((r) => ({
    ...r,
    data: r.data.map(toRentalItem),
  }));
}

/**
 * 실물 등록 — POST /rental-inventory (계약 §5: managementCode 필수).
 * quantity가 2 이상이면 `${managementCode}-001` 형식 연번으로 일괄 생성된다.
 */
export function createRentalItem(body: {
  managementCode: string;
  componentType: RentalComponentType;
  design: string;
  color: string;
  size: string;
  quantity?: number;
  notes?: string;
}): Promise<RentalItem[]> {
  return request<RentalItem[]>({ url: '/rental-inventory', method: 'POST', data: body });
}

export interface RentalImportRow {
  managementCode?: string;
  componentType: RentalComponentType;
  design: string;
  color: string;
  size: string;
  quantity?: number;
  notes?: string;
}

export interface RentalImportResult {
  created?: RentalItem[];
  /** dryRun 시 생성 예정 관리코드 목록 */
  preview?: string[];
  errors?: { row: number; managementCode: string | null; errors: string[] }[];
}

/** 일괄 등록 — POST /rental-inventory/import { dryRun?, items } (계약 §5) */
export function importRentalItems(body: {
  dryRun?: boolean;
  items: RentalImportRow[];
}): Promise<RentalImportResult> {
  return request<RentalImportResult>({ url: '/rental-inventory/import', method: 'POST', data: body });
}

/** RENT-002 실물 상세 — GET /rental-inventory/{id} (§13.6). 백엔드 중첩 응답을 화면 뷰로 변환한다. */
export function fetchRentalItemDetail(id: string): Promise<RentalItemDetail> {
  interface RawDetail extends RawRentalItem {
    allocations?: NonNullable<RawRentalItem['allocations']>;
    statusEvents?: Array<{
      id: string;
      previousStatus?: string | null;
      newStatus: string;
      availableFrom?: string | null;
      reason?: string | null;
      occurredAt: string;
      actor?: { displayName?: string } | null;
    }>;
  }
  return request<RawDetail>({ url: `/rental-inventory/${id}` }).then((raw) => ({
    item: toRentalItem(raw),
    allocations: (raw.allocations ?? []).map((a) => ({
      id: a.id,
      inventoryItemId: raw.id,
      managementCode: raw.managementCode,
      componentLabel: a.orderItemComponent?.orderItem?.displayName ?? '-',
      orderId: '',
      orderNo: a.orderItemComponent?.orderItem?.order?.orderNo ?? '-',
      customerId: a.orderItemComponent?.orderItem?.order?.contract?.customer?.id,
      customerName: a.orderItemComponent?.orderItem?.order?.contract?.customer?.name ?? '-',
      pickupDate: dateOnly(a.pickupDate) ?? '',
      returnDueDate: dateOnly(a.returnDueDate) ?? '',
      availabilityEndDate: dateOnly((a as { availabilityEndDate?: string }).availabilityEndDate) ?? '',
      status: a.status,
      version: 0,
    })),
    events: (raw.statusEvents ?? []).map((e) => ({
      id: e.id,
      at: e.occurredAt,
      type: 'STATUS' as const,
      label: `${e.previousStatus ?? '-'} → ${e.newStatus}`,
      detail: e.availableFrom ? `대여 가능 예정일 ${dateOnly(e.availableFrom)}` : undefined,
      reason: e.reason ?? undefined,
      by: e.actor?.displayName ?? '-',
    })),
  }));
}

/** 실물 속성 수정 — PATCH /rental-inventory/{id} (계약 §5: notes) */
export function patchRentalItem(
  id: string,
  body: { design?: string; color?: string; size?: string; notes?: string; version: number },
): Promise<RentalItem> {
  return request<RentalItem>({ url: `/rental-inventory/${id}`, method: 'PATCH', data: body });
}

/** 실물 상태 수동 변경 — POST /rental-inventory/{id}/status-events (계약 §5: newStatus) */
export function postRentalItemStatusEvent(
  id: string,
  body: { newStatus: RentalItemStatus; availableFrom?: string; reason?: string; version: number },
): Promise<RentalItem> {
  return request<RentalItem>({ url: `/rental-inventory/${id}/status-events`, method: 'POST', data: body });
}

/** 사용 중지 — POST /rental-inventory/{id}/retire (§13.6) */
export function retireRentalItem(id: string, body: { reason?: string }): Promise<RentalItem> {
  return request<RentalItem>({ url: `/rental-inventory/${id}/retire`, method: 'POST', data: body });
}

/** 기간 가용 조회 — GET /rental-inventory/availability (§13.6, §14.6 — size 파라미터 사용) */
/** 가용 실물 조회 — 백엔드는 componentType을 필수로 요구한다(rentals.dto.ts). */
export function fetchAvailability(params: {
  componentType: RentalComponentType;
  design?: string;
  color?: string;
  size?: string;
  pickupDate: string;
  availabilityEndDate: string;
}): Promise<RentalItem[]> {
  const q: Record<string, string> = {
    pickupDate: params.pickupDate,
    availabilityEndDate: params.availabilityEndDate,
  };
  if (params.componentType) q.componentType = params.componentType;
  if (params.design) q.design = params.design;
  if (params.color) q.color = params.color;
  if (params.size) q.size = params.size;
  return request<RawRentalItem[]>({ url: '/rental-inventory/availability', params: q }).then((rows) =>
    rows.map(toRentalItem),
  );
}

/** 실물 ID 배정 — POST /rental-orders/{id}/allocations (itemCode 대체 허용 — 계약 §5) */
export function allocateRentalItem(
  orderId: string,
  body: {
    componentId?: string;
    inventoryItemId?: string;
    itemCode?: string;
    pickupDate: string;
    returnDueDate: string;
    availabilityEndDate: string;
  },
): Promise<RentalAllocation> {
  return request<RentalAllocation>({ url: `/rental-orders/${orderId}/allocations`, method: 'POST', data: body });
}

/** 배정 ID 변경 — POST /rental-allocations/{id}/change-item (§13.6, §14.7) */
export function changeAllocationItem(
  allocationId: string,
  body: { newInventoryItemId: string; reason: string; version: number },
): Promise<RentalAllocation> {
  return request<RentalAllocation>({
    url: `/rental-allocations/${allocationId}/change-item`,
    method: 'POST',
    data: body,
  });
}

/** 렌탈 출고 — POST /rental-allocations/{id}/checkout (confirmedItemCode 그대로 전송 — 계약 §5) */
export function checkoutAllocation(
  allocationId: string,
  body: { confirmedItemCode: string; checkoutDate: string; version: number },
): Promise<RentalAllocation> {
  return request<RentalAllocation>({
    url: `/rental-allocations/${allocationId}/checkout`,
    method: 'POST',
    data: body,
  });
}

/** 렌탈 반납 — POST /rental-allocations/{id}/return (계약 §5: returnDate) */
export function returnAllocation(
  allocationId: string,
  body: { returnDate: string; availableFrom: string; nextStatus: RentalItemStatus; version: number },
): Promise<RentalAllocation> {
  return request<RentalAllocation>({
    url: `/rental-allocations/${allocationId}/return`,
    method: 'POST',
    data: body,
  });
}

/**
 * RENT-004 출고·반납 대상 목록 — GET /rental-allocations?view=pickup|return&date=&q= (계약 §5)
 * q(주문번호·고객명·실물코드)를 넘기면 pickup 뷰의 날짜 제한이 풀려 미래 픽업 예약도 함께 조회된다.
 */
export function fetchAllocations(
  view: 'pickup' | 'return',
  opts?: { date?: string; q?: string },
): Promise<RentalAllocation[]> {
  const params: Record<string, string> = { view };
  if (opts?.date) params.date = opts.date;
  if (opts?.q?.trim()) params.q = opts.q.trim();
  return request<RentalAllocation[]>({ url: '/rental-allocations', params });
}

/** RENT-003 배정 대상 렌탈 구성품 목록 — GET /rental-orders/components?orderId? (계약 §5) */
export function fetchRentalComponentTargets(orderId?: string): Promise<RentalOrderComponent[]> {
  return request<RentalOrderComponent[]>({
    url: '/rental-orders/components',
    params: orderId ? { orderId } : undefined,
  });
}
