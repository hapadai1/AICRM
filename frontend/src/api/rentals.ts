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

/**
 * 렌탈 실물 상태 (02_데이터모델설계서 §13.3).
 * PREPARING(준비 중)은 제거했다 — 전이시키는 흐름이 없어 필터가 항상 0건이었다.
 */
export type RentalItemStatus =
  | 'AVAILABLE'
  | 'RESERVED'
  | 'ALTERATION'
  | 'CHECKED_OUT'
  | 'RETURNED_HOLD'
  | 'UNAVAILABLE'
  | 'RETIRED';

export const RENTAL_ITEM_STATUS_META: Record<RentalItemStatus, { label: string; color: string }> = {
  AVAILABLE: { label: '대여 가능', color: 'green' },
  RESERVED: { label: '예약됨', color: 'blue' },
  ALTERATION: { label: '수선 중', color: 'purple' },
  CHECKED_OUT: { label: '대여 중', color: 'geekblue' },
  RETURNED_HOLD: { label: '반납 대기', color: 'orange' },
  UNAVAILABLE: { label: '사용 불가', color: 'red' },
  RETIRED: { label: '폐기', color: 'default' },
};

/** 미등록 상태 코드가 와도 화면이 죽지 않도록 코드 그대로 표시한다. */
export function rentalItemStatusLabel(status: string): string {
  return RENTAL_ITEM_STATUS_META[status as RentalItemStatus]?.label ?? status;
}

/** 렌탈 배정 상태 (02_데이터모델설계서 §13.3) */
export type AllocationStatus = 'RESERVED' | 'CHECKED_OUT' | 'RETURNED' | 'CANCELLED';

export const ALLOCATION_STATUS_META: Record<AllocationStatus, { label: string; color: string }> = {
  RESERVED: { label: '예약', color: 'blue' },
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
  color: string;
  size: string;
  status: RentalItemStatus;
  availableFrom?: string;
  notes?: string;
  version: number;
  currentAllocation?: RentalAllocationSummary;
}

/** 실물 이력 = 상태 이벤트(백엔드 `statusEvents`). 대여·수선 이력은 배정/수선 도메인에서 본다. */
export interface RentalItemEvent {
  id: string;
  at: string;
  label: string;
  /** 전이 후 상태 코드 — 라벨 문자열을 파싱하지 않고 특정 이벤트를 집어내려고 남긴다. */
  newStatus: string;
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
  componentSequenceNo?: number;
  /** 실물 속성 — 출고 시 옷을 집어 오려면 컬러·사이즈가 함께 보여야 한다 */
  color?: string;
  size?: string;
  /** 주문 품목명 (예: 렌탈 정장 #1). 백엔드 뷰의 displayName */
  displayName?: string;
  orderId: string;
  orderNo: string;
  customerId?: string;
  customerName: string;
  customerPhone?: string;
  pickupDate: string;
  returnDueDate: string;
  availabilityEndDate: string;
  status: AllocationStatus;
  /** 실제 출고·반납 일시 (예정일과 별개) */
  actualPickupAt?: string | null;
  actualReturnAt?: string | null;
  checkoutDate?: string;
  returnDate?: string;
  /** 기준일 대비 픽업/반납 지연 여부 (목록 뷰) */
  overdue?: boolean;
  /**
   * 반납 뷰 전용 — 이 색의 정비(세탁) 소요일과 기준일에 반납했을 때의 대여 가능 예정일.
   * 화면이 날짜를 직접 계산하지 않는다. 기준은 관리자 화면(렌탈 정비 기준)에서 바꾼다.
   */
  cleaningDays?: number;
  suggestedAvailableFrom?: string;
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
  /** true면 폐기만, 기본은 폐기를 뺀 살아 있는 재고만 */
  retired?: boolean;
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
  color?: string;
  size?: string;
  rentalSku?: { componentType: RentalComponentType; color: string; size: string };
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
  const active = raw.allocations?.find((a) => ['RESERVED', 'CHECKED_OUT'].includes(a.status));
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
    color: raw.color ?? sku?.color ?? '-',
    size: raw.size ?? sku?.size ?? '-',
    status: raw.status,
    availableFrom: dateOnly(raw.availableFrom),
    notes: raw.notes ?? undefined,
    version: raw.version ?? raw.rowVersion ?? 0,
    currentAllocation: currentAllocation ?? undefined,
  };
}

/** 품목 대분류별 재고 건수 (재고 화면 상단 버튼) */
export interface RentalInventorySummary {
  total: number;
  byComponentType: Record<RentalComponentType, number>;
}

/**
 * 품목별 건수 — GET /rental-inventory/summary.
 * 품목을 뺀 나머지 검색 조건은 그대로 반영해, 버튼을 누르면 몇 건이 나올지 미리 보여 준다.
 */
export function fetchRentalInventorySummary(
  filters: Omit<RentalItemFilters, 'componentType' | 'page' | 'size_'>,
): Promise<RentalInventorySummary> {
  const params: Record<string, string> = {};
  if (filters.color) params.color = filters.color;
  if (filters.skuSize) params.skuSize = filters.skuSize;
  if (filters.status) params.status = filters.status;
  if (filters.retired) params.retired = 'true';
  if (filters.availableOn) params.availableOn = filters.availableOn;
  return request<RentalInventorySummary>({ url: '/rental-inventory/summary', params });
}

/**
 * SKU(품목·컬러·사이즈) 한 줄의 수량. total = available + reserved + checkedOut + hold.
 * 재고 화면은 개체가 아니라 이 수량을 다룬다 (현업 확정 2026-07-31).
 */
export interface RentalSkuSummaryRow {
  componentType: RentalComponentType;
  color: string;
  size: string;
  /** 폐기·비활성을 뺀 보유 수 */
  total: number;
  /** 오늘 바로 빌려줄 수 있는 수 */
  available: number;
  reserved: number;
  checkedOut: number;
  /** 세탁·수선 등으로 오늘 못 쓰는 수 */
  hold: number;
  /** 대기 수량의 내역 — 비고 칸이 이걸 줄줄이 쓴다. 이른 예정일부터, 기한 미정은 맨 뒤. */
  holds?: RentalSkuHold[];
}

/**
 * 대기 한 묶음 — "왜 못 쓰는지 · 언제 풀리는지 · 몇 벌".
 * 날짜의 뜻은 상태마다 다르다: 반납 대기(세탁 정비)는 그날 자동으로 대여 가능이 되지만,
 * 수선·사용 불가는 담당자가 [사용 재개]로 풀어야 하는 예정일일 뿐이다.
 */
export interface RentalSkuHold {
  status: RentalItemStatus;
  availableFrom: string | null;
  count: number;
}

/** SKU별 수량 집계 — GET /rental-inventory/sku-summary */
export function fetchRentalSkuSummary(
  filters: Pick<RentalItemFilters, 'componentType' | 'color' | 'skuSize'>,
): Promise<RentalSkuSummaryRow[]> {
  const params: Record<string, string> = {};
  if (filters.componentType) params.componentType = filters.componentType;
  if (filters.color) params.color = filters.color;
  if (filters.skuSize) params.skuSize = filters.skuSize;
  return request<RentalSkuSummaryRow[]>({ url: '/rental-inventory/sku-summary', params });
}

/**
 * SKU 단위 수량 폐기 — POST /rental-inventory/retire-quantity.
 * 어느 개체를 뺄지는 서버가 고른다(예약·출고 중인 실물은 제외).
 */
export function retireRentalQuantity(body: {
  componentType: RentalComponentType;
  color: string;
  size: string;
  quantity: number;
  reason: string;
}): Promise<{ retired: number }> {
  return request({ url: '/rental-inventory/retire-quantity', method: 'POST', data: body });
}

/** SKU 단위 수량 상태 변경 (임시 사용불가 ↔ 대여 가능) — POST /rental-inventory/status-quantity */
export function changeRentalStatusQuantity(body: {
  componentType: RentalComponentType;
  color: string;
  size: string;
  quantity: number;
  newStatus: RentalItemStatus;
  reason: string;
}): Promise<{ changed: number }> {
  return request({ url: '/rental-inventory/status-quantity', method: 'POST', data: body });
}

/** RENT-001 실물 목록 — GET /rental-inventory (§13.6, 계약 §5) */
export function fetchRentalItems(filters: RentalItemFilters): Promise<ListResult<RentalItem>> {
  const params: Record<string, string | number> = {};
  if (filters.componentType) params.componentType = filters.componentType;
  if (filters.color) params.color = filters.color;
  if (filters.skuSize) params.skuSize = filters.skuSize;
  if (filters.status) params.status = filters.status;
  if (filters.retired) params.retired = 'true';
  if (filters.availableOn) params.availableOn = filters.availableOn;
  params.page = filters.page ?? 1;
  params.size = filters.size_ ?? 30;
  return request<ListResult<RawRentalItem>>({ url: '/rental-inventory', params }).then((r) => ({
    ...r,
    data: r.data.map(toRentalItem),
  }));
}

/**
 * 실물 등록 — POST /rental-inventory.
 * managementCode를 생략하면 서버가 `구분-컬러-사이즈-연번`으로 채번한다.
 * 넘기는 경우 quantity가 2 이상이면 `${managementCode}-001` 형식 연번으로 일괄 생성된다.
 */
export function createRentalItem(body: {
  managementCode?: string;
  componentType: RentalComponentType;
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
      displayName: a.orderItemComponent?.orderItem?.displayName ?? '-',
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
      label: `${e.previousStatus ? rentalItemStatusLabel(e.previousStatus) : '-'} → ${rentalItemStatusLabel(e.newStatus)}`,
      newStatus: e.newStatus,
      detail: e.availableFrom ? `대여 가능 예정일 ${dateOnly(e.availableFrom)}` : undefined,
      reason: e.reason ?? undefined,
      by: e.actor?.displayName ?? '-',
    })),
  }));
}

/** 실물 속성 수정 — PATCH /rental-inventory/{id} (계약 §5: notes) */
export function patchRentalItem(
  id: string,
  body: { color?: string; size?: string; notes?: string; version: number },
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

/** 폐기 처리 — POST /rental-inventory/{id}/retire (§13.6). 사유는 필수(백엔드 RetireInventoryDto). */
export function retireRentalItem(id: string, body: { reason: string }): Promise<RentalItem> {
  return request<RentalItem>({ url: `/rental-inventory/${id}/retire`, method: 'POST', data: body });
}

/** 기간 가용 조회 — GET /rental-inventory/availability (§13.6, §14.6 — size 파라미터 사용) */
/** 가용 실물 조회 — 백엔드는 componentType을 필수로 요구한다(rentals.dto.ts). */
export function fetchAvailability(params: {
  componentType: RentalComponentType;
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
  if (params.color) q.color = params.color;
  if (params.size) q.size = params.size;
  return request<RawRentalItem[]>({ url: '/rental-inventory/availability', params: q }).then((rows) =>
    rows.map(toRentalItem),
  );
}

/**
 * 렌탈 배정 — POST /rental-orders/{id}/allocations.
 * 대상 실물은 inventoryItemId · itemCode · color+size 중 하나로 지정한다.
 * color+size만 주면 서버가 그 기간에 비어 있는 실물 하나를 고른다 (현업 확정 2026-07-31).
 */
export function allocateRentalItem(
  orderId: string,
  body: {
    componentId?: string;
    inventoryItemId?: string;
    itemCode?: string;
    /** 개체 대신 넘기는 SKU 조건 — 구분은 구성품에서 가져오므로 컬러·사이즈만 준다. */
    color?: string;
    size?: string;
    pickupDate: string;
    returnDueDate: string;
    /** 생략하면 반납 예정일과 같다 — 반납 다음 날부터 다른 예약을 받는다. */
    availabilityEndDate?: string;
  },
): Promise<RentalAllocation> {
  return request<RentalAllocation>({ url: `/rental-orders/${orderId}/allocations`, method: 'POST', data: body });
}

/** 배정 ID 변경 — POST /rental-allocations/{id}/change-item (§13.6, §14.7) */
export function changeAllocationItem(
  allocationId: string,
  /** newInventoryItemId를 생략하면 같은 규격의 비어 있는 다른 실물을 서버가 고른다. */
  body: { newInventoryItemId?: string; reason: string; version: number },
): Promise<RentalAllocation> {
  return request<RentalAllocation>({
    url: `/rental-allocations/${allocationId}/change-item`,
    method: 'POST',
    data: body,
  });
}

/**
 * 렌탈 출고 — POST /rental-allocations/{id}/checkout.
 * 관리코드 재입력(확인 ID) 대조는 없앴다. 예약과 다른 옷을 내보냈다면 notes에 남긴다.
 */
export function checkoutAllocation(
  allocationId: string,
  body: { checkoutDate: string; notes?: string; version: number },
): Promise<RentalAllocation> {
  return request<RentalAllocation>({
    url: `/rental-allocations/${allocationId}/checkout`,
    method: 'POST',
    data: body,
  });
}

/**
 * 렌탈 반납 — POST /rental-allocations/{id}/return (계약 §5: returnDate)
 * availableFrom을 빼면 서버가 정비 기준(반납일 + 색 계열별 정비일)으로 채운다.
 */
export function returnAllocation(
  allocationId: string,
  body: { returnDate: string; availableFrom?: string; nextStatus: RentalItemStatus; version: number },
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

// ---------------------------------------------------------------------------
// 렌탈예약 달력 — GET /rental-inventory/availability-calendar (설계서 06 §4.4)
// ---------------------------------------------------------------------------

/** 달력 셀에 표시할 가용 실물 요약 (백엔드 availabilityCalendar.items[]) */
export interface RentalCalendarItem {
  id: string;
  managementCode: string;
  componentType: RentalComponentType;
  color: string;
  size: string;
}

/**
 * C5: 렌탈 선택 확정 → 배정 화면 프리필 전달 페이로드 (navigate state).
 * 자동 배정이 아니라, 배정 모달을 선택 실물·구성품 기본값으로 열기 위한 값만 담는다(날짜는 배정에서 입력).
 */
export interface RentalAllocatePrefillEntry {
  /** 배정 대상 구성품(contractItemComponentId = 배정 API의 componentId) */
  componentId: string;
  orderNo: string;
  customerName: string;
  item: RentalCalendarItem;
}

export interface RentalAllocatePrefill {
  items: RentalAllocatePrefillEntry[];
}

/** 일자별 가용 집계 (백엔드 availabilityCalendar 반환 배열 요소) */
export interface RentalCalendarDay {
  date: string;
  availableCount: number;
  items: RentalCalendarItem[];
}

export interface RentalCalendarFilters {
  from: string;
  to: string;
  componentType?: RentalComponentType;
  color?: string;
  size?: string;
  /** 자유 검색어(관리코드·컬러 부분일치) */
  q?: string;
}

/**
 * 기간 내 일자별 가용 집계 — GET /rental-inventory/availability-calendar (설계서 06 §4).
 * 달력 뷰용 표시 집계이며, 정합성(이중예약 차단)은 배정 시점 DB 제약이 보장한다.
 */
export function fetchAvailabilityCalendar(filters: RentalCalendarFilters): Promise<RentalCalendarDay[]> {
  const params: Record<string, string> = { from: filters.from, to: filters.to };
  if (filters.componentType) params.componentType = filters.componentType;
  if (filters.color) params.color = filters.color;
  if (filters.size) params.size = filters.size;
  if (filters.q?.trim()) params.q = filters.q.trim();
  return request<RentalCalendarDay[]>({ url: '/rental-inventory/availability-calendar', params });
}

// ---------------------------------------------------------------------------
// 렌탈 스타일 선택 세션 (v2 D3 / 설계서 04 §4 — rental-selection.controller.ts)
// ---------------------------------------------------------------------------

export type RentalSelectionStatus = 'IN_PROGRESS' | 'CONFIRMED';

export const RENTAL_SELECTION_STATUS_META: Record<RentalSelectionStatus, { label: string; color: string }> = {
  IN_PROGRESS: { label: '작성 중', color: 'processing' },
  CONFIRMED: { label: '확정', color: 'green' },
};

/** 선택 세션의 선택된 실물 요약 (detail.components[].selectedItem) */
export interface RentalSelectedItem {
  id: string;
  managementCode: string;
  color: string;
  size: string;
  status: RentalItemStatus;
}

/** 부위(구성품)별 선택 슬롯 (GET /rental-selections/:id) */
export interface RentalSelectionComponent {
  contractItemComponentId: string;
  componentType: RentalComponentType;
  sequenceNo?: number;
  colorCode: string | null;
  sizeCode: string | null;
  notes: string | null;
  selectedInventoryItemId: string | null;
  selectedItem: RentalSelectedItem | null;
}

/** 렌탈 선택 세션 상세 (start / current.session / detail 공통 형태) */
export interface RentalSelectionDetail {
  sessionId: string;
  contractItemId: string;
  displayName: string;
  productCategory?: string;
  customerId: string;
  customerName: string;
  status: RentalSelectionStatus;
  isCurrent: boolean;
  confirmedAt: string | null;
  version: number;
  /** 대여 기간 (필수값). 정하기 전에는 null이며, 없으면 후보 검색·확정이 막힌다. */
  pickupDate: string | null;
  returnDueDate: string | null;
  components: RentalSelectionComponent[];
}

/** 후보 실물 (대여 기간에 배정이 겹치지 않는 실물, componentType×color×size 필터) */
export interface RentalCandidate {
  id: string;
  managementCode: string;
  color: string;
  size: string;
  status: RentalItemStatus;
}

/** GET /rental-selections/:id/lines/:componentId/candidates */
export interface RentalLineCandidates {
  sessionId: string;
  contractItemComponentId: string;
  componentType: RentalComponentType;
  pickupDate: string | null;
  returnDueDate: string | null;
  colorCode: string | null;
  sizeCode: string | null;
  candidates: RentalCandidate[];
}

/** 확인서 부위별 행 (GET /rental-selections/:id/review — 코드→표시명 병기) */
export interface RentalReviewComponent {
  contractItemComponentId: string;
  componentType: RentalComponentType;
  colorCode: string | null;
  colorName: string | null;
  sizeCode: string | null;
  sizeName: string | null;
  notes: string | null;
  selectedItem: { id: string; managementCode: string } | null;
}

/** 확인서 (GET /rental-selections/:id/review) */
export interface RentalSelectionReview {
  sessionId: string;
  contractItemId: string;
  displayName: string;
  customerName: string;
  orderNo: string;
  status: RentalSelectionStatus;
  confirmedAt: string | null;
  components: RentalReviewComponent[];
  version: number;
}

/** 목록의 부위 슬롯 (GET /rental-selections/progress) — 코드+표시명 병기 */
export interface RentalProgressComponent {
  contractItemComponentId: string;
  componentType: RentalComponentType;
  sequenceNo: number;
  colorCode: string | null;
  colorName: string | null;
  sizeCode: string | null;
  sizeName: string | null;
  notes: string | null;
  selectedInventoryItemId: string | null;
  selectedItemCode: string | null;
  /** 컨설팅에서 [베스트 제외]한 부위 — 행은 남되 실물 선택이 잠긴다 (현업 확정 2026-08-01) */
  excluded?: boolean;
}

/**
 * 렌탈 품목별 부위 선택 현황 행 — 맞춤 option-progress와 같은 형태.
 * 세션이 없으면 sessionId=null, status='NOT_STARTED'이고 부위 슬롯만 채워진다.
 */
export interface RentalProgressItem {
  contractItemId: string;
  displayName: string;
  productCategory: string;
  contractId: string;
  contractNo: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  completionDueDate: string | null;
  sessionId: string | null;
  status: RentalSelectionStatus | 'NOT_STARTED';
  version: number;
  components: RentalProgressComponent[];
}

/** 렌탈 부위 선택 현황 — GET /rental-selections/progress?contractId= */
export function fetchRentalSelectionProgress(contractId?: string): Promise<RentalProgressItem[]> {
  return request<RentalProgressItem[]>({
    url: '/rental-selections/progress',
    params: contractId ? { contractId } : undefined,
  });
}

/** 세션 시작/현재본 반환 — POST /contract-items/:id/rental-selection (RENTAL 품목만) */
export function startRentalSelection(contractItemId: string): Promise<RentalSelectionDetail> {
  return request<RentalSelectionDetail>({
    url: `/contract-items/${contractItemId}/rental-selection`,
    method: 'POST',
  });
}

/** 현재 세션 상세 — GET /contract-items/:id/rental-selection (없으면 { session: null }) */
export function fetchCurrentRentalSelection(
  contractItemId: string,
): Promise<{ session: RentalSelectionDetail | null }> {
  return request<{ session: RentalSelectionDetail | null }>({
    url: `/contract-items/${contractItemId}/rental-selection`,
  });
}

/** 세션 상세 — GET /rental-selections/:id */
export function fetchRentalSelectionDetail(sessionId: string): Promise<RentalSelectionDetail> {
  return request<RentalSelectionDetail>({ url: `/rental-selections/${sessionId}` });
}

/**
 * 대여 기간 지정 — PUT /rental-selections/:id/period.
 * 기간이 바뀌면 서버가 이미 고른 실물 선택을 비운다(그 기간에 빈다는 보장이 사라지므로).
 */
export function saveRentalPeriod(
  sessionId: string,
  body: { pickupDate: string; returnDueDate: string; version?: number },
): Promise<RentalSelectionDetail> {
  return request<RentalSelectionDetail>({
    url: `/rental-selections/${sessionId}/period`,
    method: 'PUT',
    data: body,
  });
}

/** 부위별 컬러·사이즈·비고 upsert — PUT /rental-selections/:id/lines/:componentId */
export function saveRentalLine(
  sessionId: string,
  componentId: string,
  body: { colorCode?: string; sizeCode?: string; notes?: string; version?: number },
): Promise<RentalSelectionDetail> {
  return request<RentalSelectionDetail>({
    url: `/rental-selections/${sessionId}/lines/${componentId}`,
    method: 'PUT',
    data: body,
  });
}

/** 후보 실물 검색 — GET /rental-selections/:id/lines/:componentId/candidates */
export function fetchRentalLineCandidates(
  sessionId: string,
  componentId: string,
): Promise<RentalLineCandidates> {
  return request<RentalLineCandidates>({
    url: `/rental-selections/${sessionId}/lines/${componentId}/candidates`,
  });
}

/** 후보 실물 선택(또는 해제: inventoryItemId=null) — PUT /rental-selections/:id/lines/:componentId/item */
export function selectRentalLineItem(
  sessionId: string,
  componentId: string,
  body: { inventoryItemId?: string | null; itemCode?: string; version?: number },
): Promise<RentalSelectionDetail> {
  return request<RentalSelectionDetail>({
    url: `/rental-selections/${sessionId}/lines/${componentId}/item`,
    method: 'PUT',
    data: body,
  });
}

/** 확정 — POST /rental-selections/:id/confirm */
export function confirmRentalSelection(
  sessionId: string,
  body: { version?: number },
): Promise<RentalSelectionDetail> {
  return request<RentalSelectionDetail>({
    url: `/rental-selections/${sessionId}/confirm`,
    method: 'POST',
    data: body,
  });
}

/** 확인서 — GET /rental-selections/:id/review */
export function fetchRentalSelectionReview(sessionId: string): Promise<RentalSelectionReview> {
  return request<RentalSelectionReview>({ url: `/rental-selections/${sessionId}/review` });
}

// ---------------------------------------------------------------------------
// 렌탈 기준정보 — 품목별 컬러·사이즈 활성 코드 (설계서 04 §5, /admin/master)
// ---------------------------------------------------------------------------

/** 렌탈 컬러·사이즈 기준정보 코드 (활성만, sortOrder 정렬) */
export interface RentalMasterCode {
  code: string;
  name: string;
  /** 이 코드를 쓰는 품목. 비어 있으면 전 품목 공통. */
  componentTypes: RentalComponentType[];
  sortOrder: number;
}

interface RawMasterItem {
  code: string;
  name: string;
  componentTypes?: RentalComponentType[];
  sortOrder: number;
  active: boolean;
}

/**
 * 활성 코드 조회는 읽기 전용 엔드포인트를 쓴다.
 * /admin/master/* 는 ADMIN_MASTER_EDIT 권한이라 조회 권한만 있는 직원 화면에서 403이 난다.
 */
function fetchSelectionCodes(
  kind: 'colors' | 'sizes',
  componentType?: RentalComponentType,
): Promise<RentalMasterCode[]> {
  return request<{ colors: RawMasterItem[]; sizes: RawMasterItem[] }>({
    url: '/rental-selections/codes',
    params: componentType ? { componentType } : undefined,
  }).then((res) =>
    (res[kind] ?? [])
      .filter((r) => r.active)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((r) => ({
        code: r.code,
        name: r.name,
        componentTypes: r.componentTypes ?? [],
        sortOrder: r.sortOrder,
      })),
  );
}

/**
 * 렌탈 컬러 활성 코드 — GET /rental-selections/codes.
 * componentType을 주면 그 품목에 있는 색만 온다(정장 12색 / 셔츠 흰색 / 구두 검정·브라운).
 */
export function fetchRentalColors(componentType?: RentalComponentType): Promise<RentalMasterCode[]> {
  return fetchSelectionCodes('colors', componentType);
}

/**
 * 렌탈 사이즈 활성 코드 — GET /rental-selections/codes.
 * 품목마다 체계가 달라(상의 46~60, 하의 80~104, 셔츠 95~120, 구두 250~280)
 * componentType 없이 부르면 전 품목 사이즈가 섞여 온다.
 */
export function fetchRentalSizes(componentType?: RentalComponentType): Promise<RentalMasterCode[]> {
  return fetchSelectionCodes('sizes', componentType);
}
