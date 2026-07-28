import type { Appointment, Consultation, CustomerStatus, Paged } from './appointments';
import { request } from './client';

/** 진행 journey의 현재 단계 (설계서 06 §2 / 02 진행상태 재정의) */
export interface CustomerCurrentStage {
  code: string;
  name: string;
  trackType: 'CUSTOM' | 'RENTAL' | 'REPAIR';
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
}

export interface CustomerListItem {
  id: string;
  name: string;
  phone: string;
  customerStatus: CustomerStatus;
  /** 예약·상담 중 최근 방문일 */
  lastVisitDate?: string;
  /** 최근 거래 유형 */
  lastTransactionType?: 'CUSTOM' | 'RENTAL';
  /** 세부 진행상태: 진행 journey의 현재 단계. 진행 journey가 없으면 null */
  currentStage?: CustomerCurrentStage | null;
  contractCount: number;
}

export interface CustomerListParams {
  q?: string;
  /**
   * 조회 범위 (설계서 07 D3). 기본 CONTRACT.
   * - CONTRACT: 계약을 한 건이라도 보유한 고객 (작성중·취소 포함)
   * - ALL:      계약 유무와 무관한 전 고객
   */
  scope?: 'CONTRACT' | 'ALL';
  transactionType?: 'CUSTOM' | 'RENTAL';
  /** 진행상태 검색: ACTIVE(진행중) | DONE(완료) | ALL(전체) */
  progress?: 'ACTIVE' | 'DONE' | 'ALL';
  page?: number;
  size?: number;
}

export interface CustomerBase {
  id: string;
  name: string;
  phone: string;
  email?: string;
  customerStatus: CustomerStatus;
  /** 고객으로 등록된 시각. 예약 자동생성분을 포함해 항상 채워진다 (설계서 07 D2) */
  registeredAt?: string | null;
  firstReservedAt?: string;
  contractedAt?: string;
  notes?: string;
  inactiveReason?: string;
  /** 신체 정보 (v2 작업지시서 연동). 계약서 작성 전 보완 대상 — 설계서 07 D7 */
  heightCm?: number | null;
  weightKg?: number | null;
  age?: number | null;
  version: number;
}

export interface CustomerSummary {
  contractCount: number;
  totalAmount: number;
}

export interface CustomerContractRow {
  id: string;
  contractNo: string;
  contractTypeName: string | null;
  status: string;
  currentVersionNo: number | null;
  totalAmount: number;
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
}

export interface CustomerSaveBody {
  name: string;
  phone: string;
  email?: string;
  notes?: string;
  /** 신체 정보 (v2 작업지시서 연동, 선택 입력) */
  heightCm?: number;
  weightKg?: number;
  age?: number;
  /** 최초 예약일 (ISO-8601). 생성 시에만 사용 */
  firstReservedAt?: string;
  version?: number;
}

export function fetchCustomers(params: CustomerListParams): Promise<Paged<CustomerListItem>> {
  return request({
    url: '/customers',
    method: 'GET',
    params: {
      q: params.q || undefined,
      scope: params.scope || undefined,
      transactionType: params.transactionType || undefined,
      progress: params.progress && params.progress !== 'ALL' ? params.progress : undefined,
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

/** 부분 수정 — 백엔드 UpdateCustomerDto는 version 외 전 필드가 선택이다 */
export function updateCustomer(
  id: string,
  body: Partial<CustomerSaveBody> & { version: number },
): Promise<CustomerBase> {
  return request({ url: `/customers/${id}`, method: 'PATCH', data: body });
}

/** 예약으로 생긴 미등록 고객을 정식 고객으로 등록 (CUST-001 [예약 고객 등록]) */
export function registerCustomer(
  id: string,
  body: { name: string; email?: string; notes?: string; version: number },
): Promise<CustomerBase> {
  return request({ url: `/customers/${id}/register`, method: 'POST', data: body });
}

export function deactivateCustomer(id: string, reason: string): Promise<CustomerBase> {
  return request({ url: `/customers/${id}/deactivate`, method: 'POST', data: { reason } });
}

/** 전화번호로 기존 활성 고객 조회 (없으면 null) */
export function findCustomerByPhone(phone: string): Promise<CustomerBase | null> {
  return request({ url: `/customers/by-phone/${encodeURIComponent(phone)}`, method: 'GET' });
}
