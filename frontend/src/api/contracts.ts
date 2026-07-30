import { downloadFile, request, type ListResult } from './client';
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
 * COMPLETED(계약 완료)는 v2 흐름 확정(2026-07-28)으로 정식 상태가 되어 필터에도 넣는다.
 */
export const CONTRACT_FILTER_STATUSES: ContractStatus[] = [
  'DRAFT',
  'CONFIRMED',
  'CHANGED',
  'COMPLETED',
  'CANCELLED',
];

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
  /** 관리 코드 — 백엔드 필수(CreateContractTypeDto.code). 수정 시에는 보내지 않는다. */
  code?: string;
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
  completionDueDate?: string | null;
  photoDate?: string | null;
  weddingDate?: string | null;
  confirmedAt?: string | null;
  createdAt: string;
  lines?: ContractLineApiRow[];
}

/** 목록 응답의 currentVersion 은 select 가 좁다 */
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
  createdAt?: string | null;
  rowVersion: number;
  customer: { id: string; name: string; phone: string };
  contractType?: { code: string; name: string } | null;
  currentVersion?: ContractListVersionApiRow | null;
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
  /** 계약일 (`YYYY-MM-DD`). 확정 전 초안은 비어 있다. */
  contractedAt?: string;
  /** 작성일 (`YYYY-MM-DD`). 계약일이 없는 초안의 목록 표시·정렬 기준. */
  createdAt?: string;
  completionDueDate?: string;
}

/** 목록 요약 — 현재 필터 전체 기준(페이지 무관) */
export interface ContractListTotals {
  count: number;
  totalAmount: number;
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
  completionDueDate?: string;
  photoDate?: string;
  weddingDate?: string;
  lines: ContractLine[];
  versions: ContractVersion[];
  orders: ContractOrderSummary[];
  /**
   * 낙관적 잠금 값. 백엔드 응답 필드는 rowVersion 이며 요청 본문 필드명은 version 이다.
   * toContractDetail 에서 rowVersion 을 매핑한다 (변경/취소 확정 요청에 사용).
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
    contractedAt: toDateOnly(row.contractedAt),
    createdAt: toDateOnly(row.createdAt),
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
    // 낙관적 잠금: 백엔드 응답 rowVersion → 요청 본문 version 으로 그대로 전달한다.
    version: row.rowVersion,
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
  /**
   * 신체 정보 — 계약서 작성 전 보완 대상(설계서 07 D7).
   * weightKg는 Prisma Decimal이라 JSON에서 문자열로 내려온다.
   */
  heightCm?: number | null;
  weightKg?: number | string | null;
  age?: number | null;
  /** 낙관적 잠금 (보완 저장 시 필요) */
  version: number;
}

export interface ContractSearchParams {
  q?: string;
  status?: ContractStatus;
  customerId?: string;
  /** 기간 필터 기준 (기본 계약일) */
  dateField?: 'contractedAt' | 'completionDueDate';
  dateFrom?: string;
  dateTo?: string;
  contractTypeId?: string;
  /** `필드,방향` 예) `contractedAt,desc` */
  sort?: string;
  page?: number;
  size?: number;
}

// ---------- 계약 구분 (CONT-001) ----------

export function fetchContractTypes(includeInactive = false) {
  // 백엔드 쿼리 파라미터는 active(문자열)다. 비활성 포함 시엔 보내지 않아 전체를 받는다.
  return request<ContractType[]>({
    url: '/contract-types',
    params: includeInactive ? {} : { active: 'true' },
  });
}

export function createContractType(body: ContractTypeInput) {
  return request<ContractType>({ url: '/contract-types', method: 'POST', data: body });
}

export function updateContractType(id: string, body: Partial<ContractTypeInput>) {
  return request<ContractType>({ url: `/contract-types/${id}`, method: 'PATCH', data: body });
}

/** 복제 — 백엔드는 새 관리 코드를 필수로 요구한다(CloneContractTypeDto.code). */
export function cloneContractType(id: string, body: { code: string; name?: string }) {
  return request<ContractType>({ url: `/contract-types/${id}/clone`, method: 'POST', data: body });
}

export function retireContractType(id: string) {
  return request<ContractType>({ url: `/contract-types/${id}/retire`, method: 'POST' });
}

// ---------- 계약 (CONT-002 / CONT-003) ----------

export function fetchContracts(params: ContractSearchParams): Promise<ContractListResult> {
  return request<ContractListResult & { data: ContractListApiRow[] }>({
    url: '/contracts',
    params,
  }).then((res) => ({
    ...res,
    data: res.data.map(toContractListItem),
  }));
}

export function fetchContract(id: string): Promise<ContractDetail> {
  return request<ContractDetailApiRow>({ url: `/contracts/${id}` }).then(toContractDetail);
}

/**
 * 화면 품목(amount/note/id)을 백엔드 ContractLineDto(lineAmount/notes)로 변환한다.
 * id는 백엔드가 받지 않고, 미전송 필드는 forbidNonWhitelisted에서 400이므로 반드시 정제한다.
 */
function toLinePayload(lines: ContractLineInput[]) {
  return lines.map((l) => ({
    transactionType: l.transactionType,
    productCategory: l.productCategory,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    lineAmount: l.amount,
    ...(l.note ? { notes: l.note } : {}),
  }));
}

/**
 * 계약 초안 본문을 백엔드 CreateContractDto 허용 필드로만 정제한다.
 * appointmentId·contractTypeName·contractedAt·note는 백엔드에 컬럼/필드가 없어 제외한다(전엔 조용히 버려짐).
 */
function toDraftPayload(body: Partial<ContractDraftInput>): Record<string, unknown> {
  return {
    ...(body.customerId ? { customerId: body.customerId } : {}),
    ...(body.contractTypeId ? { contractTypeId: body.contractTypeId } : {}),
    ...(body.completionDueDate !== undefined ? { completionDueDate: body.completionDueDate } : {}),
    ...(body.photoDate !== undefined ? { photoDate: body.photoDate } : {}),
    ...(body.weddingDate !== undefined ? { weddingDate: body.weddingDate } : {}),
    ...(body.totalAmount !== undefined ? { totalAmount: body.totalAmount } : {}),
    ...(body.lines ? { lines: toLinePayload(body.lines) } : {}),
  };
}

export function createContractDraft(body: ContractDraftInput): Promise<ContractDetail> {
  return request<ContractDetailApiRow>({
    url: '/contracts',
    method: 'POST',
    data: toDraftPayload(body),
  }).then(toContractDetail);
}

export function updateContractDraft(id: string, body: Partial<ContractDraftInput>): Promise<ContractDetail> {
  // 초안 수정은 customerId를 바꾸지 않는다(UpdateContractDto에 없음) → 정제 시 제외된다.
  const { customerId: _customerId, ...rest } = body;
  return request<ContractDetailApiRow>({
    url: `/contracts/${id}`,
    method: 'PATCH',
    data: toDraftPayload(rest),
  }).then(toContractDetail);
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
    // 품목은 lineAmount/notes로 변환한다(ConfirmRevisionDto.lines = ContractLineDto).
    data: {
      ...(body.changeReason !== undefined ? { changeReason: body.changeReason } : {}),
      version: body.version,
      totalAmount: body.totalAmount,
      lines: toLinePayload(body.lines),
    },
  });
}

export function cancelContract(id: string, body: { reason: string; version: number }): Promise<ContractDetail> {
  return request<ContractDetailApiRow>({ url: `/contracts/${id}/cancel`, method: 'POST', data: body }).then(
    toContractDetail,
  );
}

/**
 * 계약 삭제 — 임시저장·취소 계약만. 진행 이력(작업지시서·렌탈 배정 등)이 있으면
 * 백엔드가 CONTRACT_NOT_DELETABLE 로 거부한다.
 */
export function deleteContract(id: string): Promise<{ id: string; contractNo: string }> {
  return request<{ id: string; contractNo: string }>({ url: `/contracts/${id}`, method: 'DELETE' });
}

// ---------- 고객 요약 (GET /customers/{id} — 계약 작성 화면의 자동 연결 표시용) ----------

/** 고객 상세는 { customer, summary, ... } aggregate 응답이므로 customer 평면 필드만 꺼낸다 (계약 문서 04 §2). */
export async function fetchCustomerSummary(id: string): Promise<CustomerSummary> {
  const aggregate = await request<{ customer: CustomerSummary }>({ url: `/customers/${id}` });
  return aggregate.customer;
}

// ---------- 전자서명 (설계서 v2 03 §3·§4) ----------

/** 서명 저장 요청 본문. imageDataUrl 은 `data:image/png;base64,...` 형식이어야 한다. */
export interface SaveSignatureInput {
  imageDataUrl: string;
  signerName: string;
  /** 낙관적 잠금 — contracts.rowVersion (ContractDetail.version) */
  version?: number;
}

/** 서명 저장 성공 응답 */
export interface SignatureSaveResult {
  versionId: string;
  signatureFileId: string;
  signerName: string;
  signedAt: string;
  downloadUrl: string;
}

/** 서명 메타(존재 여부·서명자·다운로드 경로). 확정/엑셀 버튼 게이팅에 쓴다. */
export interface SignatureMeta {
  versionId: string;
  signed: boolean;
  signatureFileId?: string | null;
  signerName?: string | null;
  /** 서버 ISO 문자열 — 표시용으로만 사용한다(초 단위까지). */
  signedAt?: string | null;
  downloadUrl?: string | null;
}

/**
 * 계약 흐름 게이팅 (GET /contracts/:id/flow).
 * 계약서 등록 → 스타일 컨설팅 → 서명 → 계약 완료 중 어디까지 왔는지 알려준다.
 */
export interface ContractFlow {
  contractId: string;
  status: ContractStatus;
  version: number;
  currentVersionId: string | null;
  registered: boolean;
  consulting: {
    ready: boolean;
    targetCount: number;
    pending: { contractItemId: string; displayName: string; transactionType: TransactionType }[];
  };
  signed: boolean;
  signedAt: string | null;
  signerName: string | null;
  canSign: boolean;
  canComplete: boolean;
  completed: boolean;
  excelStored: boolean;
}

export function fetchContractFlow(id: string): Promise<ContractFlow> {
  return request<ContractFlow>({ url: `/contracts/${id}/flow` });
}

/** 계약 완료 — 서명이 끝난 확정 계약만. 완료 시점 계약서 엑셀이 보관된다. */
export interface ContractCompleteResult {
  contractId: string;
  contractNo: string;
  status: ContractStatus;
  versionNo: number;
  excelFileId: string;
  downloadUrl: string;
}

export function completeContract(id: string, body: { version?: number }): Promise<ContractCompleteResult> {
  return request<ContractCompleteResult>({
    url: `/contracts/${id}/complete`,
    method: 'POST',
    data: body,
  });
}

/** 서명 이미지 저장·교체 (컨설팅 확정 후 현재 확정 버전 한정). */
export function saveSignature(
  contractId: string,
  versionId: string,
  body: SaveSignatureInput,
): Promise<SignatureSaveResult> {
  return request<SignatureSaveResult>({
    url: `/contracts/${contractId}/versions/${versionId}/signature`,
    method: 'POST',
    data: body,
  });
}

/** 서명 제거 (다시 받기용, DRAFT 한정). */
export function removeSignature(contractId: string, versionId: string): Promise<{ versionId: string; signed: boolean }> {
  return request({
    url: `/contracts/${contractId}/versions/${versionId}/signature`,
    method: 'DELETE',
  });
}

/** 서명 메타 조회. */
export function getSignature(contractId: string, versionId: string): Promise<SignatureMeta> {
  return request<SignatureMeta>({ url: `/contracts/${contractId}/versions/${versionId}/signature` });
}

// ---------- 계약서 엑셀 (설계서 v2 03 §5·§8) ----------

/**
 * 계약서 엑셀(xlsx)을 blob 으로 내려받는다.
 * 인증 헤더가 필요하므로 `<a href>` 가 아니라 axios blob 다운로드(client.downloadFile)를 쓴다.
 */
export function downloadContractExcel(contractId: string, contractNo: string): Promise<void> {
  return downloadFile(`/contracts/${contractId}/excel`, `contract-${contractNo}.xlsx`);
}

// ---------- 계약서 웹 표시 (설계서 v2 03 §6·§7) ----------

/** 웹 표시용 라인 — 세부품목(구성품)·세부가격을 노출한다(D7). */
/** 부위 아래에 붙는 유료 옵션 한 건 (추가금액 0원 옵션은 서버에서 제외된다) */
export interface ContractDocumentComponentOption {
  /** 옵션 단계명 (스티치·카라 등) */
  stageName: string;
  optionName: string;
  extraPrice: number;
}

/** 주문품목의 부위 한 칸 (상의·하의·베스트 …) */
export interface ContractDocumentComponent {
  group: string;
  groupLabel: string;
  options: ContractDocumentComponentOption[];
}

/** 계약 라인 아래의 계약품목 (정장 #1, 정장 #2 …) */
export interface ContractDocumentItem {
  contractItemId: string;
  orderNo: string | null;
  displayName: string;
  sequenceNo: number;
  components: ContractDocumentComponent[];
  optionTotal: number;
}

export interface ContractDocumentLine {
  transactionType: TransactionType;
  productCategory: ProductCategory;
  categoryLabel: string;
  itemDescription?: string;
  /** 주문 생성 전(계약 확정 전) 폴백용 구성품 라벨(상의·하의 등) */
  components: string[];
  quantity: number;
  unitPrice: number;
  lineAmount: number;
  notes?: string;
  /** 주문품목 × 부위 × 유료옵션 계층 */
  items: ContractDocumentItem[];
}

/** 웹 표시용 스타일 옵션 — 옵션명·추가금액을 노출한다(D7). */
export interface ContractDocumentOption {
  optionName: string;
  extraPrice: number;
}

/** 서명 상태(웹 표시·게이팅용) */
export interface ContractDocumentSignature {
  signed: boolean;
  signerName?: string;
  signedAt?: string;
  downloadUrl?: string;
}

export interface ContractDocument {
  contractNo: string;
  status: ContractStatus;
  contractedAt?: string;
  customer: { id: string; name: string; phone: string };
  contractTypeName?: string;
  versionNo?: number;
  totalAmount: number;
  completionDueDate?: string;
  photoDate?: string;
  weddingDate?: string;
  lines: ContractDocumentLine[];
  options: ContractDocumentOption[];
  signature: ContractDocumentSignature;
}

interface ContractDocumentLineApiRow {
  transactionType: TransactionType;
  productCategory: ProductCategory;
  categoryLabel: string;
  itemDescription?: string | null;
  components: string[];
  quantity: number;
  unitPrice?: string | number | null;
  lineAmount?: string | number | null;
  notes?: string | null;
  items?: ContractDocumentItemApiRow[] | null;
}

interface ContractDocumentItemApiRow {
  contractItemId: string;
  orderNo: string | null;
  displayName: string;
  sequenceNo: number;
  components?:
    | {
        group: string;
        groupLabel: string;
        options?: { stageName: string; optionName: string; extraPrice?: string | number | null }[] | null;
      }[]
    | null;
  optionTotal?: string | number | null;
}

interface ContractDocumentApiRow {
  contractNo: string;
  status: ContractStatus;
  contractedAt?: string | null;
  customer: { id: string; name: string; phone: string };
  contractType?: { id?: string; code: string; name: string } | null;
  version?: {
    versionNo: number;
    versionStatus: ContractVersionStatus;
    totalAmount: string | number;
    completionDueDate?: string | null;
    photoDate?: string | null;
    weddingDate?: string | null;
  } | null;
  lines: ContractDocumentLineApiRow[];
  options: { optionName: string; extraPrice?: string | number | null }[];
  signature: { signed: boolean; signerName?: string | null; signedAt?: string | null; downloadUrl?: string | null };
}

/** 웹 계약서 표시 데이터. 금액은 Decimal 문자열로 오므로 number 로 흡수한다. */
export function fetchContractDocument(id: string): Promise<ContractDocument> {
  return request<ContractDocumentApiRow>({ url: `/contracts/${id}/document` }).then((row) => ({
    contractNo: row.contractNo,
    status: row.status,
    contractedAt: toDateOnly(row.contractedAt),
    customer: row.customer,
    contractTypeName: row.contractType?.name ?? undefined,
    versionNo: row.version?.versionNo,
    totalAmount: toNumber(row.version?.totalAmount) ?? 0,
    completionDueDate: toDateOnly(row.version?.completionDueDate),
    photoDate: toDateOnly(row.version?.photoDate),
    weddingDate: toDateOnly(row.version?.weddingDate),
    lines: (row.lines ?? []).map((l) => ({
      transactionType: l.transactionType,
      productCategory: l.productCategory,
      categoryLabel: l.categoryLabel,
      itemDescription: l.itemDescription ?? undefined,
      components: l.components ?? [],
      quantity: l.quantity,
      unitPrice: toNumber(l.unitPrice) ?? 0,
      lineAmount: toNumber(l.lineAmount) ?? 0,
      notes: l.notes ?? undefined,
      items: (l.items ?? []).map((it) => ({
        contractItemId: it.contractItemId,
        orderNo: it.orderNo ?? null,
        displayName: it.displayName,
        sequenceNo: it.sequenceNo,
        components: (it.components ?? []).map((c) => ({
          group: c.group,
          groupLabel: c.groupLabel,
          options: (c.options ?? []).map((o) => ({
            stageName: o.stageName,
            optionName: o.optionName,
            extraPrice: toNumber(o.extraPrice) ?? 0,
          })),
        })),
        optionTotal: toNumber(it.optionTotal) ?? 0,
      })),
    })),
    options: (row.options ?? []).map((o) => ({
      optionName: o.optionName,
      extraPrice: toNumber(o.extraPrice) ?? 0,
    })),
    signature: {
      signed: row.signature?.signed ?? false,
      signerName: row.signature?.signerName ?? undefined,
      signedAt: row.signature?.signedAt ?? undefined,
      downloadUrl: row.signature?.downloadUrl ?? undefined,
    },
  }));
}
