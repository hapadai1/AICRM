import type { Appointment, Consultation, CustomerStatus, Paged } from './appointments';
import { request } from './client';

export interface CustomerListItem {
  id: string;
  name: string;
  phone: string;
  customerStatus: CustomerStatus;
  /** 예약·상담 중 최근 방문일 */
  lastVisitDate?: string;
  /** 최근 거래 유형 */
  lastTransactionType?: 'CUSTOM' | 'RENTAL';
  contractCount: number;
  balanceAmount: number;
}

export interface CustomerListParams {
  q?: string;
  /** true면 PROSPECT·INACTIVE 포함 (기본 CONTRACTED만) */
  includeProspect?: boolean;
  transactionType?: 'CUSTOM' | 'RENTAL';
  page?: number;
  size?: number;
}

export interface CustomerBase {
  id: string;
  name: string;
  phone: string;
  email?: string;
  customerStatus: CustomerStatus;
  firstReservedAt?: string;
  contractedAt?: string;
  notes?: string;
  inactiveReason?: string;
  version: number;
}

export interface CustomerSummary {
  contractCount: number;
  totalAmount: number;
  paidAmount: number;
  balanceAmount: number;
}

export interface CustomerContractRow {
  id: string;
  contractNo: string;
  contractTypeName: string | null;
  status: string;
  currentVersionNo: number | null;
  totalAmount: number;
  depositAmount: number;
  balanceAmount: number;
  contractedAt?: string | null;
  completionDueDate?: string | null;
}

export interface CustomerOrderItemRow {
  id: string;
  displayName: string;
  status: string;
  optionStatus: 'NOT_STARTED' | 'IN_PROGRESS' | 'REVIEW' | 'CONFIRMED';
  measurementLinked: boolean;
  workOrderVersionCount: number;
}

export interface CustomerOrderRow {
  id: string;
  orderNo: string;
  contractNo: string | null;
  transactionType: 'CUSTOM' | 'RENTAL';
  status: string;
  completionDueDate?: string | null;
  items: CustomerOrderItemRow[];
}

export interface CustomerMeasurementRow {
  id: string;
  date: string;
  type: 'INITIAL' | 'FITTING' | 'REMEASURE';
  staffName: string;
  usedByItems: string[];
}

export interface CustomerComponentRow {
  id: string;
  orderNo: string;
  itemName: string;
  componentType: string;
  status: string;
  expectedInboundDate?: string | null;
  actualInboundAt?: string | null;
  actualOutboundAt?: string | null;
  rentalItemCode?: string | null;
}

export interface CustomerRepairRow {
  id: string;
  receivedDate: string;
  target: string;
  content: string;
  status: string;
}

export interface CustomerPaymentRow {
  id: string;
  contractNo: string;
  type: string;
  amount: number;
  paidAt: string;
  method?: string | null;
}

/** GET /customers/:id 단일 aggregate 응답 (문서 03 §5.2) */
export interface CustomerAggregate {
  customer: CustomerBase;
  summary: CustomerSummary;
  appointments: Appointment[];
  consultations: Consultation[];
  contracts: CustomerContractRow[];
  orders: CustomerOrderRow[];
  measurements: CustomerMeasurementRow[];
  components: CustomerComponentRow[];
  rentals: CustomerComponentRow[];
  repairs: CustomerRepairRow[];
  payments: CustomerPaymentRow[];
}

export interface CustomerSaveBody {
  name: string;
  phone: string;
  email?: string;
  notes?: string;
  version?: number;
}

export function fetchCustomers(params: CustomerListParams): Promise<Paged<CustomerListItem>> {
  return request({
    url: '/customers',
    method: 'GET',
    params: {
      q: params.q || undefined,
      includeProspect: params.includeProspect ? 'true' : undefined,
      transactionType: params.transactionType || undefined,
      page: params.page ?? 1,
      size: params.size ?? 30,
    },
  });
}

export function fetchCustomer(id: string): Promise<CustomerAggregate> {
  return request({ url: `/customers/${id}`, method: 'GET' });
}

export function createCustomer(body: CustomerSaveBody): Promise<CustomerBase> {
  return request({ url: '/customers', method: 'POST', data: body });
}

export function updateCustomer(id: string, body: CustomerSaveBody): Promise<CustomerBase> {
  return request({ url: `/customers/${id}`, method: 'PATCH', data: body });
}

export function deactivateCustomer(id: string, reason: string): Promise<CustomerBase> {
  return request({ url: `/customers/${id}/deactivate`, method: 'POST', data: { reason } });
}

/** 전화번호로 기존 활성 고객 조회 (없으면 null) */
export function findCustomerByPhone(phone: string): Promise<CustomerBase | null> {
  return request({ url: `/customers/by-phone/${encodeURIComponent(phone)}`, method: 'GET' });
}
