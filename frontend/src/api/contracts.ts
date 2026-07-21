import { request, type ListResult } from './client';
import { toDateOnly, toNumber } from './transform';

/**
 * 계약·계약구분 도메인 API (문서 03 §13.3)
 *
 * 응답 형태는 백엔드(`contracts.service.ts`)가 기준이다.
 * 백엔드는 Prisma raw row를 그대로 내보내므로 이 모듈이 아래를 흡수한다 (docs/dev/08 §2.1).
 *  - 금액(Decimal)은 문자열("750000")로 온다 → number 로 변환
 *  - 날짜는 ISO 문자열로 온다 → `YYYY-MM-DD` 로 자른다
 *  - 고객·계약구분·금액은 중첩(`customer.name`, `currentVersion.totalAmount`)이다 → 화면용 평면 필드로 편다
 */

export type TransactionType = 'CUSTOM' | 'RENTAL';
export type ProductCategory = 'SUIT' | 'SHIRT' | 'SHOES';
export type ContractStatus = 'DRAFT' | 'CONFIRMED' | 'CHANGED' | 'CANCELLED' | 'COMPLETED';
export type ContractVersionStatus = 'DRAFT' | 'CONFIRMED' | 'SUPERSEDED';

/**
 * 목록 필터로 보낼 수 있는 상태 — 백엔드 CONTRACT_STATUSES 와 동일해야 한다.
 * COMPLETED 는 DB에는 존재하지만 백엔드 필터 허용값이 아니라 400을 만든다. 그래서 필터에서 제외한다.
 * (라벨 맵에는 남겨 둬야 COMPLETED 행이 정상 표시된다 — features/contracts/labels.ts)
 */
export const CONTRACT_FILTER_STATUSES: ContractStatus[] = ['DRAFT', 'CONFIRMED', 'CHANGED', 'CANCELLED'];

export interface ContractTypeLine {
  transactionType: TransactionType;
  productCategory: ProductCategory;
  defaultQuantity: number;
}

export interface ContractType {
  id: string;
  code: string;
  name: string;
  description?: string;
  sortOrder: number;
  active: boolean;
  lines: ContractTypeLine[];
}

export interface ContractTypeInput {
  name: string;
  description?: string;
  sortOrder?: number;
  lines: ContractTypeLine[];
}

// ---------- 백엔드 원본 행 ----------

/** 백엔드 contract_lines 행 (금액은 Decimal 문자열, 이름은 lineAmount/notes) */
interface ContractLineApiRow {
  id: string;
  transactionType: TransactionType;
  productCategory: ProductCategory;
  itemDescription?: string | null;
  quantity: number;
  unitPrice?: string | number | null;
  lineAmount?: string | number | null;
  notes?: string | null;
  sortOrder: number;
}

/** 백엔드 contract_versions 행 (상태 필드명은 versionStatus, 사유는 changeReason) */
interface ContractVersionApiRow {
  id: string;
  contractId: string;
  versionNo: number;
  versionStatus: ContractVersionStatus;
  changeReason?: string | null;
  totalAmount: string | number;
  depositAmount: string | number;
  balanceAmount: string | number;
  completionDueDate?: string | null;
  photoDate?: string | null;
  weddingDate?: string | null;
  confirmedAt?: string | null;
  createdAt: string;
  lines?: ContractLineApiRow[];
}

/** 목록 응답의 currentVersion 은 select 가 좁다 (계약금·잔금 없음) */
interface ContractListVersionApiRow {
  versionNo: number;
  versionStatus: ContractVersionStatus;
  totalAmount: string | number;
  completionDueDate?: string | null;
}

interface ContractListApiRow {
  id: string;
  contractNo: string;
  customerId: string;
  contractTypeId?: string | null;
  status: ContractStatus;
  contractedAt?: string | null;
  balanceDueDate?: string | null;
  rowVersion: number;
  customer: { id: string; name: string; phone: string };
  contractType?: { code: string; name: string } | null;
  currentVersion?: ContractListVersionApiRow | null;
  /** 실수납액(환불 차감·취소 제외) — 개편계획 06 §3.2. 백엔드가 평면 필드로 내려준다 */
  paidAmount?: string | number | null;
  unpaidAmount?: string | number | null;
  lastPaymentDate?: string | null;
}

interface ContractOrderApiRow {
  id: string;
  orderNo: string;
  transactionType: TransactionType;
  status: string;
}

interface ContractDetailApiRow extends Omit<ContractListApiRow, 'contractType' | 'currentVersion'> {
  customer: { id: string; name: string; phone: string; email?: string | null; customerStatus: string };
  contractType?: { id: string; code: string; name: string } | null;
  currentVersion?: ContractVersionApiRow | null;
  versions: ContractVersionApiRow[];
  orders: ContractOrderApiRow[];
}

// ---------- 화면용 뷰 ----------

/**
 * 화면용 품목 라인.
 * 필드명 amount/note 는 화면·요청 본문과 맞춘 이름이고, 응답 원본은 lineAmount/notes 다.
 * (요청 본문 필드명 정합화는 별도 단계 — docs/dev/08 §5)
 */
export interface ContractLine {
  id: string;
  transactionType: TransactionType;
  productCategory: ProductCategory;
  quantity: number;
  unitPrice: number;
  amount: number;
  note?: string;
  itemDescription?: string;
}

export interface ContractLineInput {
  id?: string;
  transactionType: TransactionType;
  productCategory: ProductCategory;
  quantity: number;
  unitPrice: number;
  amount: number;
  note?: string;
}

export interface ContractListItem {
  id: string;
  contractNo: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  contractTypeName: string;
  status: ContractStatus;
  currentVersionNo?: number;
  totalAmount?: number;
  /** 실수납액 = 완료 결제 합계 − 환불 (개편계획 06) */
  paidAmount: number;
  /** 미수금 = 계약금액 − 실수납액. 음수면 과납 */
  unpaidAmount: number;
  /** 최근 결제일 (`YYYY-MM-DD`), 없으면 null */
  lastPaymentDate: string | null;
  /** 계약일 (`YYYY-MM-DD`) */
  contractedAt?: string;
  completionDueDate?: string;
}

/** 목록 요약 — 현재 필터 전체 기준(페이지 무관) */
export interface ContractListTotals {
  count: number;
  totalAmount: number;
  paidAmount: number;
  unpaidAmount: number;
}

export type ContractListResult = ListResult<ContractListItem> & { totals?: ContractListTotals };

export interface ContractOrderSummary {
  id: string;
  orderNo: string;
  transactionType: TransactionType;
  status: string;
}

export interface ContractVersion {
  id: string;
  versionNo: number;
  /** 백엔드 필드명 그대로 — versions[].status 는 존재하지 않는다 */
  versionStatus: ContractVersionStatus;
  changeReason?: string;
  createdAt: string;
  totalAmount: number;
  depositAmount: number;
  balanceAmount: number;
  completionDueDate?: string;
  photoDate?: string;
  weddingDate?: string;
  lines: ContractLine[];
}

export interface ContractDetail {
  id: string;
  contractNo: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerStatus: string;
  contractTypeId?: string;
  contractTypeName: string;
  status: ContractStatus;
  contractedAt?: string;
  /** 현재 적용 버전(currentVersion)에서 편 값들 */
  currentVersionNo?: number;
  totalAmount?: number;
  depositAmount?: number;
  balanceAmount?: number;
  completionDueDate?: string;
  photoDate?: string;
  weddingDate?: string;
  lines: ContractLine[];
  versions: ContractVersion[];
  orders: ContractOrderSummary[];
  /**
   * 낙관적 잠금 값. 백엔드 응답 필드는 rowVersion 이며 요청 본문 필드명은 version 이다.
   * 요청 본문 정합화가 끝나기 전까지 매핑하지 않는다 (docs/dev/08 §5 — 요청 측 단계).
   */
  version?: number;
}

function toLine(row: ContractLineApiRow): ContractLine {
  return {
    id: row.id,
    transactionType: row.transactionType,
    productCategory: row.productCategory,
    quantity: row.quantity,
    unitPrice: toNumber(row.unitPrice) ?? 0,
    amount: toNumber(row.lineAmount) ?? 0,
    note: row.notes ?? undefined,
    itemDescription: row.itemDescription ?? undefined,
  };
}

function toVersion(row: ContractVersionApiRow): ContractVersion {
  return {
    id: row.id,
    versionNo: row.versionNo,
    versionStatus: row.versionStatus,
    changeReason: row.changeReason ?? undefined,
    createdAt: toDateOnly(row.createdAt) ?? '',
    totalAmount: toNumber(row.totalAmount) ?? 0,
    depositAmount: toNumber(row.depositAmount) ?? 0,
    balanceAmount: toNumber(row.balanceAmount) ?? 0,
    completionDueDate: toDateOnly(row.completionDueDate),
    photoDate: toDateOnly(row.photoDate),
    weddingDate: toDateOnly(row.weddingDate),
    lines: (row.lines ?? []).map(toLine),
  };
}

function toContractListItem(row: ContractListApiRow): ContractListItem {
  return {
    id: row.id,
    contractNo: row.contractNo,
    customerId: row.customerId,
    customerName: row.customer?.name ?? '-',
    customerPhone: row.customer?.phone ?? '',
    contractTypeName: row.contractType?.name ?? '-',
    status: row.status,
    currentVersionNo: row.currentVersion?.versionNo,
    totalAmount: toNumber(row.currentVersion?.totalAmount),
    paidAmount: toNumber(row.paidAmount) ?? 0,
    unpaidAmount: toNumber(row.unpaidAmount) ?? 0,
    lastPaymentDate: toDateOnly(row.lastPaymentDate) ?? null,
    contractedAt: toDateOnly(row.contractedAt),
    completionDueDate: toDateOnly(row.currentVersion?.completionDueDate),
  };
}

function toContractDetail(row: ContractDetailApiRow): ContractDetail {
  const current = row.currentVersion ?? null;
  return {
    id: row.id,
    contractNo: row.contractNo,
    customerId: row.customerId,
    customerName: row.customer?.name ?? '-',
    customerPhone: row.customer?.phone ?? '',
    customerStatus: row.customer?.customerStatus ?? '',
    contractTypeId: row.contractTypeId ?? undefined,
    contractTypeName: row.contractType?.name ?? '-',
    status: row.status,
    contractedAt: toDateOnly(row.contractedAt),
    currentVersionNo: current?.versionNo,
    totalAmount: toNumber(current?.totalAmount),
    depositAmount: toNumber(current?.depositAmount),
    balanceAmount: toNumber(current?.balanceAmount),
    completionDueDate: toDateOnly(current?.completionDueDate),
    photoDate: toDateOnly(current?.photoDate),
    weddingDate: toDateOnly(current?.weddingDate),
    // 품목 라인은 최상위가 아니라 현재 적용 버전 아래에 있다.
    lines: (current?.lines ?? []).map(toLine),
    versions: (row.versions ?? []).map(toVersion),
    orders: (row.orders ?? []).map((o) => ({
      id: o.id,
      orderNo: o.orderNo,
      transactionType: o.transactionType,
      status: o.status,
    })),
  };
}

export interface ContractDraftInput {
  customerId: string;
  appointmentId?: string;
  contractTypeId?: string;
  contractTypeName: string;
  contractedAt?: string;
  completionDueDate?: string;
  photoDate?: string;
  weddingDate?: string;
  totalAmount: number;
  depositAmount: number;
  note?: string;
  lines: ContractLineInput[];
}

export interface ContractConfirmResult {
  contractId: string;
  contractNo: string;
  status: string;
  customerStatus: string;
  orders: { id: string; orderNo: string; tradeType: TransactionType }[];
}

export interface RevisionConfirmInput {
  /** 변경 사유 — 요청 필드명은 changeReason (계약 문서 04 §3) */
  changeReason?: string;
  version: number;
  totalAmount: number;
  depositAmount: number;
  lines: ContractLineInput[];
}

/** 변경 확정 응답 — 생성·취소된 품목 목록은 오지 않는다. 적용 버전과 영향 주문만 온다. */
export interface RevisionConfirmResult {
  contractId: string;
  contractNo: string;
  status: string;
  versionNo: number;
  changeReason?: string;
  orders: { id: string; orderNo: string; tradeType: TransactionType }[];
}

export interface CustomerSummary {
  id: string;
  name: string;
  phone: string;
  customerStatus: 'PROSPECT' | 'CONTRACTED' | 'INACTIVE';
}

export interface ContractSearchParams {
  q?: string;
  status?: ContractStatus;
  customerId?: string;
  /** 기간 필터 기준 (기본 계약일) */
  dateField?: 'contractedAt' | 'paymentDate' | 'completionDueDate';
  dateFrom?: string;
  dateTo?: string;
  contractTypeId?: string;
  /** 미수금이 남은 계약만 */
  unpaidOnly?: boolean;
  /** `필드,방향` 예) `contractedAt,desc` */
  sort?: string;
  page?: number;
  size?: number;
}

// ---------- 계약 구분 (CONT-001) ----------

export function fetchContractTypes(includeInactive = false) {
  return request<ContractType[]>({ url: '/contract-types', params: { includeInactive } });
}

export function createContractType(body: ContractTypeInput) {
  return request<ContractType>({ url: '/contract-types', method: 'POST', data: body });
}

export function updateContractType(id: string, body: Partial<ContractTypeInput>) {
  return request<ContractType>({ url: `/contract-types/${id}`, method: 'PATCH', data: body });
}

export function cloneContractType(id: string) {
  return request<ContractType>({ url: `/contract-types/${id}/clone`, method: 'POST' });
}

export function retireContractType(id: string) {
  return request<ContractType>({ url: `/contract-types/${id}/retire`, method: 'POST' });
}

// ---------- 계약 (CONT-002 / CONT-003) ----------

export function fetchContracts(params: ContractSearchParams): Promise<ContractListResult> {
  return request<ContractListResult & { data: ContractListApiRow[] }>({
    url: '/contracts',
    // false는 서버에서 문자열 'false'로 굳어지므로 아예 보내지 않는다.
    params: { ...params, unpaidOnly: params.unpaidOnly ? true : undefined },
  }).then((res) => ({
    ...res,
    data: res.data.map(toContractListItem),
  }));
}

export function fetchContract(id: string): Promise<ContractDetail> {
  return request<ContractDetailApiRow>({ url: `/contracts/${id}` }).then(toContractDetail);
}

export function createContractDraft(body: ContractDraftInput): Promise<ContractDetail> {
  return request<ContractDetailApiRow>({ url: '/contracts', method: 'POST', data: body }).then(toContractDetail);
}

export function updateContractDraft(id: string, body: Partial<ContractDraftInput>): Promise<ContractDetail> {
  return request<ContractDetailApiRow>({ url: `/contracts/${id}`, method: 'PATCH', data: body }).then(
    toContractDetail,
  );
}

export function confirmContract(id: string, body: { version: number; confirmedDate?: string }) {
  return request<ContractConfirmResult>({ url: `/contracts/${id}/confirm`, method: 'POST', data: body });
}

export function fetchContractVersions(id: string): Promise<ContractVersion[]> {
  return request<ContractVersionApiRow[]>({ url: `/contracts/${id}/versions` }).then((rows) =>
    rows.map(toVersion),
  );
}

/** 변경 초안 생성 — body 필드명 changeReason (계약 문서 04 §3) */
export function createContractRevision(id: string, body: { changeReason: string }): Promise<ContractVersion> {
  return request<ContractVersionApiRow>({ url: `/contracts/${id}/revisions`, method: 'POST', data: body }).then(
    toVersion,
  );
}

export function confirmContractRevision(id: string, revisionId: string, body: RevisionConfirmInput) {
  return request<RevisionConfirmResult>({
    url: `/contracts/${id}/revisions/${revisionId}/confirm`,
    method: 'POST',
    data: body,
  });
}

export function cancelContract(id: string, body: { reason: string; version: number }): Promise<ContractDetail> {
  return request<ContractDetailApiRow>({ url: `/contracts/${id}/cancel`, method: 'POST', data: body }).then(
    toContractDetail,
  );
}

// ---------- 고객 요약 (GET /customers/{id} — 계약 작성 화면의 자동 연결 표시용) ----------

/** 고객 상세는 { customer, summary, ... } aggregate 응답이므로 customer 평면 필드만 꺼낸다 (계약 문서 04 §2). */
export async function fetchCustomerSummary(id: string): Promise<CustomerSummary> {
  const aggregate = await request<{ customer: CustomerSummary }>({ url: `/customers/${id}` });
  return aggregate.customer;
}
