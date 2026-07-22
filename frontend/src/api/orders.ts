import { request } from './client';
import { toDateOnly, toDateTime } from './transform';
import type { ProductCategory, TransactionType } from './contracts';

/**
 * 주문 도메인 API (문서 03 §13.3, ORD-001)
 *
 * 응답 형태는 백엔드(`orders.service.ts`)가 기준이다.
 * 고객은 주문이 아니라 계약 아래(`contract.customer`)에 있고, 촬영일·예식일은 주문에 있다.
 * 상태 타임라인·옵션 진행률·채촌 연결·작업지시서 출력 이력은 백엔드가 아직 내려주지 않는다 (docs/dev/08 §4).
 */

export type ComponentType = 'JACKET' | 'TROUSERS' | 'VEST' | 'SHIRT' | 'SHOES';

// ---------- 백엔드 원본 행 ----------

interface OrderComponentApiRow {
  id: string;
  orderItemId: string;
  componentType: ComponentType;
  sequenceNo: number;
  status: string;
  expectedInboundDate?: string | null;
  actualInboundAt?: string | null;
  actualOutboundAt?: string | null;
  notes?: string | null;
  active: boolean;
}

interface OrderItemApiRow {
  id: string;
  orderId: string;
  sourceContractLineId?: string | null;
  productCategory: ProductCategory;
  sequenceNo: number;
  displayName: string;
  status: string;
  cancelledReason?: string | null;
  cancelledAt?: string | null;
  components?: OrderComponentApiRow[];
  // GET /orders/:id/items 진행지표 (docs/dev/08 §4)
  optionProgress?: { status: string; current: number; total: number };
  measurement?: { linked: boolean; versionNo: number | null; completed: boolean };
  workOrderVersionCount?: number;
  workOrderIssued?: boolean;
}

interface OrderApiRow {
  id: string;
  orderNo: string;
  contractId: string;
  transactionType: TransactionType;
  status: string;
  completionDueDate?: string | null;
  photoDate?: string | null;
  weddingDate?: string | null;
  rowVersion: number;
  contract: {
    id: string;
    contractNo: string;
    status: string;
    customer: { id: string; name: string; phone: string };
  };
  items?: OrderItemApiRow[];
}

// ---------- 화면용 뷰 ----------

export interface OrderComponent {
  id: string;
  componentType: ComponentType;
  sequenceNo: number;
  status: string;
  /** `YYYY-MM-DD` */
  expectedInboundDate?: string;
  /** `YYYY-MM-DD HH:mm` */
  actualInboundAt?: string;
  actualOutboundAt?: string;
  notes?: string;
}

export interface OrderItemProgress {
  /** 옵션 진행률 (current/total 단계). 세션 없으면 status=NOT_STARTED */
  optionProgress: { status: string; current: number; total: number };
  /** 현재 연결된 채촌 */
  measurement: { linked: boolean; versionNo: number | null; completed: boolean };
  /** 작업지시서 출력(버전) 횟수 */
  workOrderVersionCount: number;
  workOrderIssued: boolean;
}

export interface OrderItem extends OrderItemProgress {
  id: string;
  orderId: string;
  productCategory: ProductCategory;
  sequenceNo: number;
  displayName: string;
  status: string;
  cancelledReason?: string;
  components: OrderComponent[];
}

export interface OrderDetail {
  id: string;
  orderNo: string;
  transactionType: TransactionType;
  status: string;
  completionDueDate?: string;
  /** 촬영일·예식일은 계약이 아니라 주문에 있다 */
  photoDate?: string;
  weddingDate?: string;
  contractId: string;
  contractNo: string;
  contractStatus: string;
  /** contract.customer 를 평면화한 값 */
  customerId: string;
  customerName: string;
  customerPhone: string;
  items: OrderItem[];
}

function toComponent(row: OrderComponentApiRow): OrderComponent {
  return {
    id: row.id,
    componentType: row.componentType,
    sequenceNo: row.sequenceNo,
    status: row.status,
    expectedInboundDate: toDateOnly(row.expectedInboundDate),
    actualInboundAt: toDateTime(row.actualInboundAt),
    actualOutboundAt: toDateTime(row.actualOutboundAt),
    notes: row.notes ?? undefined,
  };
}

function toOrderItem(row: OrderItemApiRow): OrderItem {
  return {
    id: row.id,
    orderId: row.orderId,
    productCategory: row.productCategory,
    sequenceNo: row.sequenceNo,
    displayName: row.displayName,
    status: row.status,
    cancelledReason: row.cancelledReason ?? undefined,
    components: (row.components ?? []).map(toComponent),
    optionProgress: row.optionProgress ?? { status: 'NOT_STARTED', current: 0, total: 0 },
    measurement: row.measurement ?? { linked: false, versionNo: null, completed: false },
    workOrderVersionCount: row.workOrderVersionCount ?? 0,
    workOrderIssued: row.workOrderIssued ?? false,
  };
}

function toOrderDetail(row: OrderApiRow): OrderDetail {
  return {
    id: row.id,
    orderNo: row.orderNo,
    transactionType: row.transactionType,
    status: row.status,
    completionDueDate: toDateOnly(row.completionDueDate),
    photoDate: toDateOnly(row.photoDate),
    weddingDate: toDateOnly(row.weddingDate),
    contractId: row.contractId,
    contractNo: row.contract?.contractNo ?? '-',
    contractStatus: row.contract?.status ?? '',
    customerId: row.contract?.customer?.id ?? '',
    customerName: row.contract?.customer?.name ?? '-',
    customerPhone: row.contract?.customer?.phone ?? '',
    items: (row.items ?? []).map(toOrderItem),
  };
}

export function fetchOrder(id: string): Promise<OrderDetail> {
  return request<OrderApiRow>({ url: `/orders/${id}` }).then(toOrderDetail);
}

export function fetchOrderItems(orderId: string): Promise<OrderItem[]> {
  return request<OrderItemApiRow[]>({ url: `/orders/${orderId}/items` }).then((rows) => rows.map(toOrderItem));
}

export function addOrderItemComponent(
  orderItemId: string,
  body: { componentType: ComponentType },
): Promise<OrderComponent> {
  return request<OrderComponentApiRow>({
    url: `/order-items/${orderItemId}/components`,
    method: 'POST',
    data: body,
  }).then(toComponent);
}
