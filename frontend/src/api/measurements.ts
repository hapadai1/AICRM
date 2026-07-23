import { request, type ListResult } from './client';
import { toDateOnly, toNumber } from './transform';

/**
 * 채촌 도메인 API (화면·API 정의서 §14, MEAS-001~003)
 * 응답 형태·코드값은 백엔드(`measurements.service.ts`, `measurement-catalog.ts`)가 기준이다.
 *
 * 백엔드는 아래 형태로 응답한다. 화면용 뷰로 변환하는 책임은 이 모듈이 진다.
 * - 목록/상세: `measurementType`, `measurementDate`, `completed: boolean`, `linkedOrderItems`
 * - 채촌값: 객체가 아니라 `{ measurementCode, numericValue, textValue }` 배열
 * - 비교: `items` 배열 + `previous/current` 중첩
 */

export type MeasurementType = 'INITIAL' | 'FITTING' | 'REMEASURE' | 'OTHER';
/** 백엔드는 상태 코드 대신 `completed: boolean`을 보낸다. 화면 표시용 파생 코드. */
export type MeasurementSessionStatus = 'DRAFT' | 'COMPLETED';
/** 백엔드 body_section 코드 (UPPER/LOWER/SHIRT/SHOES) */
export type MeasurementGroup = 'UPPER' | 'LOWER' | 'SHIRT' | 'SHOES';

/** 채촌 구분 = 채촌을 하게 된 업무 단계 (스타일 컨설팅·가봉·수선) */
export const MEASUREMENT_TYPE_LABELS: Record<string, string> = {
  INITIAL: '스타일 컨설팅',
  FITTING: '가봉',
  REMEASURE: '수선',
  OTHER: '기타',
};

export const MEASUREMENT_GROUP_LABELS: Record<string, string> = {
  UPPER: '상의',
  LOWER: '하의',
  SHIRT: '셔츠',
  SHOES: '구두',
};

/** completed 플래그 → 화면 상태 코드 */
export function measurementStatusOf(completed: boolean): MeasurementSessionStatus {
  return completed ? 'COMPLETED' : 'DRAFT';
}

export interface MeasurementFieldDef {
  /** 백엔드 measurement_code (JACKET_LENGTH, CHEST_UPPER, SLEEVE_LEFT ...) */
  key: string;
  label: string;
  group: MeasurementGroup;
  /** number: cm 소수 허용, text: 문자 사이즈 (차이값 대신 변경 여부만 표시) */
  kind: 'number' | 'text';
}

/**
 * 채촌 항목 카탈로그 — 백엔드 `measurement-catalog.ts` MEASUREMENT_ITEMS와 코드·순서를 맞춘다.
 * (상의 11 / 하의 8 / 구두 1). SHOE_SIZE는 백엔드 valueType=ANY이나 화면은 문자 입력으로 다룬다.
 */
export const MEASUREMENT_FIELDS: MeasurementFieldDef[] = [
  { key: 'JACKET_LENGTH', label: '상의장', group: 'UPPER', kind: 'number' },
  { key: 'SHOULDER', label: '어깨', group: 'UPPER', kind: 'number' },
  { key: 'FRONT_WIDTH', label: '앞품', group: 'UPPER', kind: 'number' },
  { key: 'BACK_WIDTH', label: '뒤품', group: 'UPPER', kind: 'number' },
  { key: 'CHEST_UPPER', label: '상동', group: 'UPPER', kind: 'number' },
  { key: 'CHEST_MID', label: '중동', group: 'UPPER', kind: 'number' },
  { key: 'CHEST_LOW', label: '하동', group: 'UPPER', kind: 'number' },
  { key: 'SLEEVE_LEFT', label: '소매길이(좌)', group: 'UPPER', kind: 'number' },
  { key: 'SLEEVE_RIGHT', label: '소매길이(우)', group: 'UPPER', kind: 'number' },
  { key: 'SLEEVE_WIDTH', label: '소매통', group: 'UPPER', kind: 'number' },
  { key: 'SLEEVE_OPENING', label: '소매부리', group: 'UPPER', kind: 'number' },
  { key: 'WAIST', label: '허리', group: 'LOWER', kind: 'number' },
  { key: 'HIP', label: '엉덩이둘레', group: 'LOWER', kind: 'number' },
  { key: 'THIGH', label: '허벅둘레', group: 'LOWER', kind: 'number' },
  { key: 'FRONT_RISE', label: '앞밑윗길이', group: 'LOWER', kind: 'number' },
  { key: 'BACK_RISE', label: '뒤밑윗길이', group: 'LOWER', kind: 'number' },
  { key: 'KNEE', label: '무릎둘레', group: 'LOWER', kind: 'number' },
  { key: 'PANTS_OPENING', label: '바지부리', group: 'LOWER', kind: 'number' },
  { key: 'PANTS_LENGTH', label: '바지기장', group: 'LOWER', kind: 'number' },
  { key: 'SHIRT_NECK', label: '목', group: 'SHIRT', kind: 'number' },
  { key: 'SHIRT_SHOULDER', label: '어깨', group: 'SHIRT', kind: 'number' },
  { key: 'SHIRT_CHEST_UPPER', label: '상동', group: 'SHIRT', kind: 'number' },
  { key: 'SHIRT_CHEST_MID', label: '중동', group: 'SHIRT', kind: 'number' },
  { key: 'SHIRT_SLEEVE', label: '소매', group: 'SHIRT', kind: 'number' },
  { key: 'SHIRT_LENGTH', label: '기장', group: 'SHIRT', kind: 'number' },
  { key: 'SHIRT_CUFF', label: '카우스', group: 'SHIRT', kind: 'number' },
  { key: 'SHIRT_ARM', label: '팔통', group: 'SHIRT', kind: 'number' },
  { key: 'SHOE_SIZE', label: '신발 사이즈', group: 'SHOES', kind: 'text' },
];

const MEASUREMENT_FIELD_MAP = new Map(MEASUREMENT_FIELDS.map((f) => [f.key, f]));

/** 카탈로그에 없는 코드가 와도 화면이 죽지 않도록 기본값을 만들어 준다. */
export function measurementFieldOf(code: string): MeasurementFieldDef {
  return MEASUREMENT_FIELD_MAP.get(code) ?? { key: code, label: code, group: 'UPPER', kind: 'number' };
}

/** 항목 코드 → 값 (화면 입력·저장 payload 형태) */
export type MeasurementValues = Record<string, number | string | null>;

export interface MeasurementUsedItem {
  id: string;
  displayName: string;
}

// ---------------------------------------------------------------------------
// 백엔드 원본 행
// ---------------------------------------------------------------------------

interface MeasurementUserApiRow {
  id: string;
  displayName: string;
}

/** listByCustomer() / search() 응답 행 (search는 고객·잠금 정보를 더 준다) */
interface MeasurementSummaryApiRow {
  id: string;
  versionNo: number;
  measurementDate: string;
  measurementType: string;
  previousSessionId?: string | null;
  fitPreference?: string | null;
  completed: boolean;
  completedAt?: string | null;
  createdBy?: MeasurementUserApiRow | null;
  staffName?: string;
  createdAt: string;
  valueCount: number;
  linkedOrderItemCount: number;
  linkedOrderItems: { id: string; displayName: string; productCategory: string }[];
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  locked?: boolean;
  workOrderVersionCount?: number;
}

interface MeasurementValueApiRow {
  id: string;
  bodySection: string;
  measurementCode: string;
  label: string;
  numericValue: number | string | null;
  textValue: string | null;
  unit: string;
  sortOrder: number;
}

/** toDetail() 응답 */
interface MeasurementSessionApiRow {
  id: string;
  customerId: string;
  customerName?: string;
  customerPhone?: string;
  staffName?: string;
  locked?: boolean;
  workOrderVersionCount?: number;
  contractId?: string | null;
  contractNo?: string | null;
  linkedOrderItems?: { id: string; displayName: string; productCategory?: string }[];
  relatedOrderId?: string | null;
  versionNo: number;
  measurementDate: string;
  measurementType: string;
  previousSessionId?: string | null;
  fitPreference?: string | null;
  bodyNotes?: string | null;
  notes?: string | null;
  completed: boolean;
  completedAt?: string | null;
  createdBy?: MeasurementUserApiRow | null;
  createdAt: string;
  values: MeasurementValueApiRow[];
}

// ---------------------------------------------------------------------------
// 화면용 뷰
// ---------------------------------------------------------------------------

/** MEAS-001 목록 행 */
export interface MeasurementSummary {
  id: string;
  /** 전역 검색 응답에만 있다. 고객별 이력 응답에서는 빈 문자열 */
  customerId: string;
  customerName: string;
  customerPhone: string;
  versionNo: number;
  measurementDate: string;
  measurementType: string;
  /** completed 파생 상태 */
  status: MeasurementSessionStatus;
  completed: boolean;
  /** 백엔드는 담당자를 createdBy(작성자)로만 내려 준다. */
  staffName: string;
  valueCount: number;
  /** 현재 이 버전을 사용 중인 주문 품목 */
  linkedOrderItems: MeasurementUsedItem[];
  /** 작업지시서 출력 근거로 쓰여 수정·삭제가 막힌 상태 */
  locked: boolean;
  previousSessionId?: string;
  fitPreference?: string;
  createdAt?: string;
}

/** MEAS-002 상세 — 값 배열을 항목 코드 맵으로 편다. */
export interface MeasurementSession {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  /** 이 채촌이 속한 계약 (연결 주문 또는 사용 품목에서 유도). 없으면 null */
  contractId: string | null;
  contractNo: string | null;
  versionNo: number;
  measurementDate: string;
  measurementType: string;
  status: MeasurementSessionStatus;
  completed: boolean;
  locked: boolean;
  staffName: string;
  values: MeasurementValues;
  linkedOrderItems: MeasurementUsedItem[];
  fitPreference: string | null;
  bodyNotes: string | null;
  notes: string | null;
}

function toSummary(row: MeasurementSummaryApiRow): MeasurementSummary {
  return {
    id: row.id,
    customerId: row.customerId ?? '',
    customerName: row.customerName ?? '',
    customerPhone: row.customerPhone ?? '',
    versionNo: row.versionNo,
    measurementDate: toDateOnly(row.measurementDate) ?? '',
    measurementType: row.measurementType,
    status: measurementStatusOf(row.completed),
    completed: row.completed,
    staffName: row.staffName ?? row.createdBy?.displayName ?? '-',
    valueCount: row.valueCount,
    linkedOrderItems: (row.linkedOrderItems ?? []).map((it) => ({ id: it.id, displayName: it.displayName })),
    locked: row.locked ?? (row.workOrderVersionCount ?? 0) > 0,
    previousSessionId: row.previousSessionId ?? undefined,
    fitPreference: row.fitPreference ?? undefined,
    createdAt: row.createdAt,
  };
}

/** 값 배열 → 항목 코드 맵. 숫자값이 없으면 문자값을 쓴다. */
function toValueMap(values: MeasurementValueApiRow[]): MeasurementValues {
  const out: MeasurementValues = {};
  for (const v of values ?? []) {
    const numeric = toNumber(v.numericValue);
    out[v.measurementCode] = numeric ?? v.textValue ?? null;
  }
  return out;
}

function toSession(row: MeasurementSessionApiRow): MeasurementSession {
  return {
    id: row.id,
    customerId: row.customerId,
    customerName: row.customerName ?? '',
    customerPhone: row.customerPhone ?? '',
    contractId: row.contractId ?? null,
    contractNo: row.contractNo ?? null,
    versionNo: row.versionNo,
    measurementDate: toDateOnly(row.measurementDate) ?? '',
    measurementType: row.measurementType,
    status: measurementStatusOf(row.completed),
    completed: row.completed,
    locked: row.locked ?? (row.workOrderVersionCount ?? 0) > 0,
    staffName: row.staffName ?? row.createdBy?.displayName ?? '-',
    values: toValueMap(row.values),
    linkedOrderItems: (row.linkedOrderItems ?? []).map((it) => ({ id: it.id, displayName: it.displayName })),
    fitPreference: row.fitPreference ?? null,
    bodyNotes: row.bodyNotes ?? null,
    notes: row.notes ?? null,
  };
}

// ---------------------------------------------------------------------------
// 비교 (MEAS-003)
// ---------------------------------------------------------------------------

interface MeasurementCompareSideApiRow {
  id: string;
  customerId?: string;
  customerName?: string;
  versionNo: number;
  measurementDate: string;
  measurementType: string;
  fitPreference?: string | null;
  bodyNotes?: string | null;
}

interface MeasurementCompareItemApiRow {
  measurementCode: string;
  label: string;
  bodySection: string;
  unit: string;
  previous: { numericValue: number | string | null; textValue: string | null };
  current: { numericValue: number | string | null; textValue: string | null };
  diff: number | string | null;
  changed: boolean;
}

interface MeasurementCompareApiRow {
  left: MeasurementCompareSideApiRow;
  right: MeasurementCompareSideApiRow;
  items: MeasurementCompareItemApiRow[];
}

/** 비교 대상 버전 메타 */
export interface MeasurementCompareVersionMeta {
  id: string;
  customerId: string;
  customerName: string;
  versionNo: number;
  measurementDate: string;
  measurementType: string;
  fitPreference: string | null;
  bodyNotes: string | null;
}

export interface MeasurementCompareRow {
  /** 항목 코드 (rowKey) */
  key: string;
  label: string;
  group: MeasurementGroup;
  kind: 'number' | 'text';
  leftValue: number | string | null;
  rightValue: number | string | null;
  /** 숫자 항목만 계산 (우측 - 좌측), 둘 중 하나라도 없으면 null */
  diff: number | null;
  /** 문자 항목의 변경 여부 */
  changed: boolean;
}

export interface MeasurementCompareData {
  left: MeasurementCompareVersionMeta;
  right: MeasurementCompareVersionMeta;
  rows: MeasurementCompareRow[];
  /** 비교는 같은 고객끼리만 가능하므로 좌측 기준으로 채운다 */
  customerId: string;
  customerName: string;
}

function toCompareSide(side: MeasurementCompareSideApiRow): MeasurementCompareVersionMeta {
  return {
    id: side.id,
    customerId: side.customerId ?? '',
    customerName: side.customerName ?? '',
    versionNo: side.versionNo,
    measurementDate: toDateOnly(side.measurementDate) ?? '',
    measurementType: side.measurementType,
    fitPreference: side.fitPreference ?? null,
    bodyNotes: side.bodyNotes ?? null,
  };
}

function toCompareRow(item: MeasurementCompareItemApiRow): MeasurementCompareRow {
  const leftNumeric = toNumber(item.previous?.numericValue);
  const rightNumeric = toNumber(item.current?.numericValue);
  const def = MEASUREMENT_FIELD_MAP.get(item.measurementCode);
  // 카탈로그에 없는 코드는 실제 값 형태로 판정한다.
  const kind: 'number' | 'text' =
    def?.kind ??
    (leftNumeric === undefined && rightNumeric === undefined ? 'text' : 'number');
  const group = (item.bodySection as MeasurementGroup) ?? def?.group ?? 'UPPER';
  return {
    key: item.measurementCode,
    label: item.label || def?.label || item.measurementCode,
    group,
    kind,
    leftValue: leftNumeric ?? item.previous?.textValue ?? null,
    rightValue: rightNumeric ?? item.current?.textValue ?? null,
    diff: toNumber(item.diff) ?? null,
    changed: item.changed,
  };
}

// ---------------------------------------------------------------------------
// 요청
// ---------------------------------------------------------------------------

/** MEAS-001 고객 검색용 최소 고객 정보 */
export interface CustomerOption {
  id: string;
  name: string;
  phone: string;
  customerStatus: string;
}

/** 고객 검색 (MEAS-001 고객 선택) — 목록 응답은 `{data, page}` 형태 */
export async function searchCustomers(q: string): Promise<CustomerOption[]> {
  const res = await request<ListResult<CustomerOption>>({ url: '/customers', params: { q, size: 100 } });
  return res.data;
}

/**
 * MEAS-001 채촌 대상 행 (계약 단위).
 * 기준은 "채촌 기록"이 아니라 "스타일 컨설팅(맞춤 계약 품목)" — 아직 채촌하지 않은 계약도 나온다.
 * 채촌 관련 수치는 고객의 과거 이력이 아니라 **이 계약에 연결된** 채촌만 센다.
 */
export interface MeasurementTargetRow {
  contractId: string;
  contractNo: string;
  /** 신규 채촌을 이 계약에 연결할 때 쓰는 대표 주문 */
  orderId: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  categoryCounts: Partial<Record<'SUIT' | 'SHIRT' | 'SHOES', number>>;
  itemCount: number;
  consultingConfirmedCount: number;
  consultingComplete: boolean;
  dueDate: string | null;
  measurementCount: number;
  measurementCompletedCount: number;
  lastSessionId: string | null;
  lastMeasurementDate: string | null;
  lastVersionNo: number | null;
  lastMeasurementType: MeasurementType | null;
  lastCompleted: boolean | null;
}

/** 채촌 대상 목록 (페이지 없는 단순 배열) */
export function fetchMeasurementTargets(): Promise<MeasurementTargetRow[]> {
  return request<MeasurementTargetRow[]>({ url: '/measurements/targets' }).then((rows) => rows ?? []);
}

/** MEAS-001 전역 채촌 검색 (설계서 09 §3.1) */
export interface MeasurementListParams {
  q?: string;
  customerId?: string;
  dateFrom?: string;
  dateTo?: string;
  type?: MeasurementType;
  status?: MeasurementSessionStatus;
  page?: number;
  size?: number;
}

export interface MeasurementListResult {
  items: MeasurementSummary[];
  total: number;
  page: number;
  size: number;
}

export async function fetchMeasurementList(params: MeasurementListParams): Promise<MeasurementListResult> {
  const res = await request<ListResult<MeasurementSummaryApiRow>>({
    url: '/measurements',
    params: {
      q: params.q?.trim() || undefined,
      customerId: params.customerId || undefined,
      dateFrom: params.dateFrom || undefined,
      dateTo: params.dateTo || undefined,
      type: params.type || undefined,
      status: params.status || undefined,
      page: params.page ?? 1,
      size: params.size ?? 30,
    },
  });
  return {
    items: (res.data ?? []).map(toSummary),
    total: res.page?.totalElements ?? res.data?.length ?? 0,
    page: res.page?.number ?? params.page ?? 1,
    size: res.page?.size ?? params.size ?? 30,
  };
}

/** MEAS-001 고객별 채촌 이력 — 응답은 페이지 없는 단순 배열 */
export function fetchMeasurements(customerId: string): Promise<MeasurementSummary[]> {
  return request<MeasurementSummaryApiRow[]>({ url: `/customers/${customerId}/measurements` }).then((rows) =>
    (rows ?? []).map(toSummary),
  );
}

/** 신규 채촌 세션 생성 (고객은 본문으로 지정) */
export function createMeasurement(body: {
  customerId: string;
  measurementDate: string;
  measurementType: MeasurementType;
  /** 이 채촌을 특정 계약(주문)에 연결한다 — 계약별 채촌 상태 판단 근거 */
  relatedOrderId?: string | null;
  fitPreference?: string | null;
  bodyNotes?: string | null;
  notes?: string | null;
}): Promise<MeasurementSession> {
  return request<MeasurementSessionApiRow>({
    url: '/measurements',
    method: 'POST',
    data: {
      customerId: body.customerId,
      measurementDate: body.measurementDate,
      measurementType: body.measurementType,
      ...(body.relatedOrderId ? { relatedOrderId: body.relatedOrderId } : {}),
      ...(body.fitPreference ? { fitPreference: body.fitPreference } : {}),
      ...(body.bodyNotes ? { bodyNotes: body.bodyNotes } : {}),
      ...(body.notes ? { notes: body.notes } : {}),
    },
  }).then(toSession);
}

/** 채촌 상세 */
export function fetchMeasurement(id: string): Promise<MeasurementSession> {
  return request<MeasurementSessionApiRow>({ url: `/measurements/${id}` }).then(toSession);
}

/**
 * 화면의 `{코드: 값}` 맵을 백엔드 값 배열로 변환한다.
 * 빈 값은 numeric·text 모두 null로 보내 "해당 항목 삭제"를 의미한다 (설계서 09 §3.3).
 */
function toValuePayload(values: MeasurementValues) {
  return Object.entries(values).map(([code, value]) => {
    const def = measurementFieldOf(code);
    if (value === null || value === '') return { measurementCode: code };
    return def.kind === 'number'
      ? { measurementCode: code, numericValue: Number(value) }
      : { measurementCode: code, textValue: String(value) };
  });
}

/** 채촌 저장 (임시 저장 = 값 UPSERT + 빈 값 삭제) */
export function updateMeasurement(
  id: string,
  body: {
    measurementDate?: string;
    measurementType?: MeasurementType;
    values?: MeasurementValues;
    fitPreference?: string | null;
    bodyNotes?: string | null;
    notes?: string | null;
  },
): Promise<MeasurementSession> {
  return request<MeasurementSessionApiRow>({
    url: `/measurements/${id}`,
    method: 'PATCH',
    data: {
      ...(body.measurementDate ? { measurementDate: body.measurementDate } : {}),
      ...(body.measurementType ? { measurementType: body.measurementType } : {}),
      ...(body.values ? { values: toValuePayload(body.values) } : {}),
      fitPreference: body.fitPreference ?? null,
      bodyNotes: body.bodyNotes ?? null,
      notes: body.notes ?? null,
    },
  }).then(toSession);
}

/** 채촌 삭제 (작업지시서에 쓰인 채촌은 409) */
export function deleteMeasurement(id: string): Promise<{ id: string; deleted: boolean }> {
  return request<{ id: string; deleted: boolean }>({ url: `/measurements/${id}`, method: 'DELETE' });
}

/** 채촌 완료 (§14.4) */
export function completeMeasurement(id: string): Promise<MeasurementSession> {
  return request<MeasurementSessionApiRow>({
    url: `/measurements/${id}/complete`,
    method: 'POST',
  }).then(toSession);
}

/** 완료 해제 (설계서 09 §3.5) */
export function reopenMeasurement(id: string): Promise<MeasurementSession> {
  return request<MeasurementSessionApiRow>({
    url: `/measurements/${id}/reopen`,
    method: 'POST',
  }).then(toSession);
}

/** 기존 버전 복사 (새 날짜 버전) */
export function cloneMeasurement(
  id: string,
  body?: { measurementType?: MeasurementType; measurementDate?: string },
): Promise<MeasurementSession> {
  return request<MeasurementSessionApiRow>({
    url: `/measurements/${id}/clone`,
    method: 'POST',
    data: {
      ...(body?.measurementType ? { measurementType: body.measurementType } : {}),
      ...(body?.measurementDate ? { measurementDate: body.measurementDate } : {}),
    },
  }).then(toSession);
}

/** MEAS-003 채촌 버전 비교 (같은 고객의 두 기록) */
export async function fetchMeasurementCompare(
  leftId: string,
  rightId: string,
): Promise<MeasurementCompareData> {
  const compare = await request<MeasurementCompareApiRow>({
    url: '/measurements/compare',
    params: { left: leftId, right: rightId },
  });
  const left = toCompareSide(compare.left);
  return {
    left,
    right: toCompareSide(compare.right),
    rows: (compare.items ?? []).map(toCompareRow),
    customerId: left.customerId,
    customerName: left.customerName,
  };
}

/** 주문 품목에 사용 채촌 버전 지정 (§14.4) */
export function linkOrderItemMeasurement(
  orderItemId: string,
  measurementSessionId: string,
): Promise<{ orderItemId: string; measurementSessionId: string }> {
  return request<{ orderItemId: string; measurementSessionId: string }>({
    url: `/order-items/${orderItemId}/measurement`,
    method: 'PUT',
    data: { measurementSessionId },
  });
}
