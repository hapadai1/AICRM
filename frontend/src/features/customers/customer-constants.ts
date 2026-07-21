import type { CustomerStatus } from '../../api/appointments';

export const CUSTOMER_STATUS_META: Record<CustomerStatus, { label: string; color: string }> = {
  PROSPECT: { label: '미계약', color: 'gold' },
  CONTRACTED: { label: '계약', color: 'green' },
  INACTIVE: { label: '비활성', color: 'default' },
};

export const TRANSACTION_TYPE_LABEL: Record<'CUSTOM' | 'RENTAL', string> = {
  CUSTOM: '맞춤',
  RENTAL: '렌탈',
};

/** 원 단위 정수 금액 표기 (값이 없으면 '-') */
export function formatAmount(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return '-';
  return `${Number(amount).toLocaleString('ko-KR')}원`;
}
