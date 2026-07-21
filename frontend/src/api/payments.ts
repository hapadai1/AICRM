/** PAY-001 결제 관리 API (계약 문서 04 §4) */
import { request } from './client';
import type { ListResult } from './client';

export type PaymentType = 'DEPOSIT' | 'INTERIM' | 'BALANCE' | 'REPAIR_FEE' | 'REFUND' | 'ETC';

export const PAYMENT_TYPE_LABEL: Record<PaymentType, string> = {
  DEPOSIT: '계약금',
  INTERIM: '중도금',
  BALANCE: '잔금',
  REPAIR_FEE: '수선비',
  REFUND: '환불',
  ETC: '기타',
};

export interface ContractSearchItem {
  id: string;
  contractNo: string;
  customerId: string;
  customerName: string;
  contractTypeName: string;
  status: string;
  totalAmount: number;
  contractedAt?: string;
}

/** 결제 뷰 필드 paymentDate/paymentMethod (payerName은 백엔드에서 memo에 병합됨) */
export interface Payment {
  id: string;
  contractId: string;
  paymentType: PaymentType;
  amount: number;
  paymentDate: string;
  paymentMethod?: string;
  memo?: string;
  /** 백엔드 저장값은 COMPLETED/CANCELLED (payments.status) */
  status: 'COMPLETED' | 'CANCELLED';
  cancelReason?: string;
  createdAt: string;
}

/** 목록 응답 summary (계약 04 §4) */
export interface ContractPaymentSummary {
  contractNo: string;
  customerName: string;
  contractTypeName: string;
  contractAmount: number;
  paidAmount: number;
  balanceAmount: number;
  balanceDueDate: string | null;
}

export interface PaymentWarning {
  code: string; // 초과 수금 = 'OVER_COLLECTION'
  message?: string;
}

/** GET /contracts/:id/payments 응답 구조 { payments, summary, warning } */
export interface ContractPaymentsResponse {
  payments: Payment[];
  summary: ContractPaymentSummary;
  warning?: PaymentWarning | null;
}

/** 등록 요청 필드 paymentDate/paymentMethod/payerName (계약 04 §4) */
export interface CreatePaymentInput {
  paymentType: PaymentType;
  amount: number;
  paymentDate: string;
  paymentMethod?: string;
  payerName?: string;
  memo?: string;
}

export interface CreatePaymentResult {
  payment: Payment;
  warning?: PaymentWarning | null;
}

/** 결제 목록 행 — 결제 자체로 고객·계약이 읽히도록 기본정보를 함께 싣는다 (개편계획 05 §3.1) */
export interface PaymentListRow extends Payment {
  contractNo: string;
  contractTypeName: string | null;
  customerId: string;
  customerName: string;
  customerPhone: string;
}

/** 필터 전체 기준 합계 (COMPLETED만, REFUND 분리) */
export interface PaymentTotals {
  count: number;
  paidAmount: number;
  refundAmount: number;
  netAmount: number;
}

export interface PaymentListParams {
  dateFrom?: string;
  dateTo?: string;
  q?: string;
  customerId?: string;
  contractId?: string;
  paymentType?: PaymentType;
  status?: 'COMPLETED' | 'CANCELLED';
  paymentMethod?: string;
  page?: number;
  size?: number;
}

export type PaymentListResult = ListResult<PaymentListRow> & { totals: PaymentTotals };

/** GET /payments — 날짜 범위·고객 기준 통합 검색 */
export function searchPayments(params: PaymentListParams): Promise<PaymentListResult> {
  return request<PaymentListResult>({ url: '/payments', params });
}

export function searchContracts(query: string): Promise<ListResult<ContractSearchItem>> {
  return request<ListResult<ContractSearchItem>>({
    url: '/contracts',
    params: { q: query || undefined, page: 1, size: 30 },
  });
}

export function fetchContractPayments(contractId: string): Promise<ContractPaymentsResponse> {
  return request<ContractPaymentsResponse>({ url: `/contracts/${contractId}/payments` });
}

export function createPayment(
  contractId: string,
  payload: CreatePaymentInput,
): Promise<CreatePaymentResult> {
  return request<CreatePaymentResult>({
    url: `/contracts/${contractId}/payments`,
    method: 'POST',
    data: payload,
  });
}

export function cancelPayment(paymentId: string, reason: string): Promise<Payment> {
  return request<Payment>({ url: `/payments/${paymentId}/cancel`, method: 'POST', data: { reason } });
}

/** 잔금 결제 예정일 수정: PATCH /contracts/:id/payment-schedule { balanceDueDate } */
export function updatePaymentSchedule(
  contractId: string,
  balanceDueDate: string | null,
): Promise<{ contractId: string; balanceDueDate: string | null }> {
  return request<{ contractId: string; balanceDueDate: string | null }>({
    url: `/contracts/${contractId}/payment-schedule`,
    method: 'PATCH',
    data: { balanceDueDate },
  });
}
