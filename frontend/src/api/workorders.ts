import { request } from './client';
import { toDateOnly, toDateTime, toNumber } from './transform';

/**
 * WO-001·WO-002 작업지시서 API.
 * 백엔드(`work-orders.service.ts`)가 기준이며, 이 파일에서 화면용 형태로 매핑한다.
 * (2차 정합화 계획 docs/dev/08 §4)
 */

/**
 * 작업지시서 상태 (WO-001 §7.8) — 백엔드 resolveWorkOrderStatus 판정 결과
 * - WAITING: 옵션 확정·채촌 연결 전 (정식 출력 불가)
 * - UNORDERED: 출력 가능하나 출력 이력 없음 (미주문)
 * - REPRINT_NEEDED: 마지막 출력 이후 옵션·채촌 변경 (재출력 필요)
 * - CURRENT: 최신 출력본이 유효
 */
export type WorkOrderStatus = 'WAITING' | 'UNORDERED' | 'REPRINT_NEEDED' | 'CURRENT';

/**
 * 목록 status 필터로 보낼 수 있는 값.
 * 백엔드 WORK_ORDER_LIST_STATUSES가 허용하는 3종뿐이며, WAITING을 보내면 400이다.
 * (행에는 WAITING이 올 수 있으므로 라벨 맵에는 그대로 남겨둔다.)
 */
export type WorkOrderFilterStatus = 'UNORDERED' | 'REPRINT_NEEDED' | 'CURRENT';

export const WORK_ORDER_FILTER_STATUSES: WorkOrderFilterStatus[] = [
  'UNORDERED',
  'REPRINT_NEEDED',
  'CURRENT',
];

/** 채촌 항목 코드 라벨 (백엔드 measurement_values.measurement_code) */
export const MEASUREMENT_CODE_LABELS: Record<string, string> = {
  JACKET_LENGTH: '상의장',
  SHOULDER: '어깨',
  FRONT_WIDTH: '앞품',
  BACK_WIDTH: '뒤품',
  CHEST_UPPER: '상동',
  CHEST_MID: '중동',
  CHEST_LOW: '하동',
  SLEEVE_LEFT: '소매길이(좌)',
  SLEEVE_RIGHT: '소매길이(우)',
  SLEEVE_WIDTH: '소매통',
  SLEEVE_OPENING: '소매부리',
  WAIST: '허리',
  HIP: '엉덩이둘레',
  THIGH: '허벅둘레',
  FRONT_RISE: '앞밑윗길이',
  BACK_RISE: '뒤밑윗길이',
  KNEE: '무릎둘레',
  PANTS_OPENING: '바지부리',
  PANTS_LENGTH: '바지기장',
  SHOE_SIZE: '신발 사이즈',
};

const UNIT_SUFFIX: Record<string, string> = { CM: ' cm', MM: ' mm', SIZE: '' };

// --- 백엔드 원본 응답 -----------------------------------------------------------

/** toListRow() 결과 */
interface WorkOrderListApiRow {
  workOrderId: string | null;
  orderItemId: string;
  contractId: string;
  contractNo: string;
  customerId: string;
  customerName: string;
  orderId: string;
  orderNo: string;
  itemLabel: string;
  productCategory: string;
  sequenceNo: number;
  fabricName: string | null;
  status: string;
  currentVersionNo: number | null;
  lastIssuedAt: string | null;
  optionConfirmedAt: string | null;
  measurementLinkedAt: string | null;
}

/** buildOptionSnapshot() 결과 */
interface OptionSnapshotApi {
  optionSessionId: string;
  selectionVersionNo: number;
  confirmedAt: string | null;
  fabricName: string | null;
  stages: {
    stageCode: string;
    stageName: string;
    sequenceNo: number;
    choiceCode: string;
    choiceName: string;
    factoryLabel: string | null;
  }[];
}

/** buildMeasurementSnapshot() 결과 (+ preview에서만 linkedAt·isLinked) */
interface MeasurementSnapshotApi {
  measurementSessionId: string;
  versionNo: number;
  measurementDate: string;
  measurementType: string;
  values: {
    bodySection: string;
    measurementCode: string;
    value: number | string | null;
    textValue: string | null;
    unit: string | null;
    sortOrder: number;
  }[];
  linkedAt?: string | null;
  isLinked?: boolean;
}

/** preview().measurementCandidates 원소 */
interface MeasurementCandidateApi {
  measurementSessionId: string;
  versionNo: number;
  measurementDate: string;
  measurementType: string;
  completed: boolean;
  isLinked: boolean;
}

/** preview() 결과 */
interface WorkOrderPreviewApi {
  orderItemId: string;
  workOrderId: string | null;
  customerId: string;
  customerName: string;
  orderId: string;
  orderNo: string;
  itemLabel: string;
  productCategory: string;
  sequenceNo: number;
  fabricName: string | null;
  option: OptionSnapshotApi;
  measurement: MeasurementSnapshotApi | null;
  measurementCandidates: MeasurementCandidateApi[];
  currentVersionNo: number | null;
  lastIssuedAt: string | null;
  status: string;
  optionConfirmed?: boolean;
  measurementCompleted?: boolean;
  printable?: boolean;
}

/** toVersionRow() 결과 */
interface WorkOrderVersionApiRow {
  id: string;
  versionNo: number;
  status: string;
  changeReason: string | null;
  sourceOptionSessionId: string;
  sourceMeasurementSessionId: string;
  sourceHash: string;
  issuedBy: { id: string; displayName: string } | null;
  issuedAt: string;
  sentAt: string | null;
  file: { id: string; fileName: string; downloadUrl: string };
}

// --- 화면용 뷰 ------------------------------------------------------------------

export interface WorkOrderListRow {
  orderItemId: string;
  workOrderId?: string;
  contractId: string;
  contractNo: string;
  customerId: string;
  customerName: string;
  orderId: string;
  orderNo: string;
  itemLabel: string;
  productCategory: string;
  sequenceNo: number;
  fabricName?: string;
  status: string;
  currentVersionNo?: number;
  /** `YYYY-MM-DD HH:mm` */
  lastIssuedAt?: string;
  optionConfirmedAt?: string;
  measurementLinkedAt?: string;
}

export interface WorkOrderOptionStage {
  key: string;
  sequenceNo: number;
  stageName: string;
  choiceName: string;
}

export interface WorkOrderMeasurementValue {
  key: string;
  code: string;
  label: string;
  bodySection: string;
  /** 단위까지 붙인 표시값. 값이 없으면 빈 문자열 */
  display: string;
}

export interface WorkOrderPreviewMeasurement {
  measurementSessionId: string;
  versionNo: number;
  /** `YYYY-MM-DD` */
  measurementDate: string;
  measurementType: string;
  linkedAt?: string;
  /** 품목에 연결된 채촌인지(false면 미리보기용으로 교체해 본 버전) */
  isLinked: boolean;
  values: WorkOrderMeasurementValue[];
}

/** 미리보기에서 골라볼 수 있는 채촌 버전 (같은 고객의 채촌 세션) */
export interface WorkOrderMeasurementCandidate {
  measurementSessionId: string;
  versionNo: number;
  /** `YYYY-MM-DD` */
  measurementDate: string;
  measurementType: string;
  completed: boolean;
  isLinked: boolean;
}

export interface WorkOrderPreview {
  orderItemId: string;
  workOrderId?: string;
  customerId: string;
  customerName: string;
  orderId: string;
  orderNo: string;
  itemLabel: string;
  productCategory: string;
  sequenceNo: number;
  fabricName?: string;
  status: string;
  currentVersionNo?: number;
  lastIssuedAt?: string;
  optionSessionId?: string;
  /** 옵션 세션 확정 버전 (표시용) */
  optionVersionNo?: number;
  optionStages: WorkOrderOptionStage[];
  measurement?: WorkOrderPreviewMeasurement;
  measurementCandidates: WorkOrderMeasurementCandidate[];
  /** 정식 Excel 출력 가능 여부 (옵션 확정 + 채촌 완료) — 백엔드 판정 */
  optionConfirmed: boolean;
  measurementCompleted: boolean;
  printable: boolean;
}

export interface WorkOrderVersionRow {
  id: string;
  versionNo: number;
  status: string;
  /** `YYYY-MM-DD HH:mm` */
  issuedAt: string;
  /** 백엔드는 `issuedBy: {id, displayName}` 객체로 보낸다 — 반드시 문자열로 편다. */
  issuedByName: string;
  fileName: string;
  downloadUrl: string;
  changeReason?: string;
  measurementSessionId: string;
}

/** §14.5 Excel 출력 응답 */
export interface WorkOrderIssueResult {
  workOrderId: string;
  workOrderVersionId: string;
  versionNo: number;
  issuedAt: string;
  file: { id: string; fileName: string; downloadUrl: string };
}

// --- 매퍼 ----------------------------------------------------------------------

function toListRow(row: WorkOrderListApiRow): WorkOrderListRow {
  return {
    orderItemId: row.orderItemId,
    workOrderId: row.workOrderId ?? undefined,
    contractId: row.contractId,
    contractNo: row.contractNo,
    customerId: row.customerId,
    customerName: row.customerName,
    orderId: row.orderId,
    orderNo: row.orderNo,
    itemLabel: row.itemLabel,
    productCategory: row.productCategory,
    sequenceNo: row.sequenceNo,
    fabricName: row.fabricName ?? undefined,
    status: row.status,
    currentVersionNo: row.currentVersionNo ?? undefined,
    lastIssuedAt: toDateTime(row.lastIssuedAt),
    optionConfirmedAt: toDateTime(row.optionConfirmedAt),
    measurementLinkedAt: toDateTime(row.measurementLinkedAt),
  };
}

function toMeasurementValue(
  v: MeasurementSnapshotApi['values'][number],
): WorkOrderMeasurementValue {
  const numeric = toNumber(v.value);
  const suffix = UNIT_SUFFIX[v.unit ?? ''] ?? '';
  const display =
    numeric !== undefined ? `${numeric}${suffix}` : (v.textValue ?? '') + (v.textValue ? suffix : '');
  return {
    key: v.measurementCode,
    code: v.measurementCode,
    label: MEASUREMENT_CODE_LABELS[v.measurementCode] ?? v.measurementCode,
    bodySection: v.bodySection,
    display,
  };
}

function toMeasurement(m: MeasurementSnapshotApi): WorkOrderPreviewMeasurement {
  return {
    measurementSessionId: m.measurementSessionId,
    versionNo: m.versionNo,
    measurementDate: toDateOnly(m.measurementDate) ?? '',
    measurementType: m.measurementType,
    linkedAt: toDateTime(m.linkedAt),
    isLinked: m.isLinked ?? true,
    values: (m.values ?? []).map(toMeasurementValue),
  };
}

function toPreview(raw: WorkOrderPreviewApi): WorkOrderPreview {
  return {
    orderItemId: raw.orderItemId,
    workOrderId: raw.workOrderId ?? undefined,
    customerId: raw.customerId,
    customerName: raw.customerName,
    orderId: raw.orderId,
    orderNo: raw.orderNo,
    itemLabel: raw.itemLabel,
    productCategory: raw.productCategory,
    sequenceNo: raw.sequenceNo,
    fabricName: raw.fabricName ?? raw.option?.fabricName ?? undefined,
    status: raw.status,
    currentVersionNo: raw.currentVersionNo ?? undefined,
    lastIssuedAt: toDateTime(raw.lastIssuedAt),
    optionSessionId: raw.option?.optionSessionId,
    optionVersionNo: raw.option?.selectionVersionNo,
    optionStages: (raw.option?.stages ?? []).map((s) => ({
      key: s.stageCode,
      sequenceNo: s.sequenceNo,
      stageName: s.stageName,
      choiceName: s.choiceName,
    })),
    measurement: raw.measurement ? toMeasurement(raw.measurement) : undefined,
    measurementCandidates: (raw.measurementCandidates ?? []).map((c) => ({
      ...c,
      measurementDate: toDateOnly(c.measurementDate) ?? '',
    })),
    optionConfirmed: raw.optionConfirmed ?? false,
    measurementCompleted: raw.measurementCompleted ?? false,
    printable: raw.printable ?? false,
  };
}

function toVersionRow(row: WorkOrderVersionApiRow): WorkOrderVersionRow {
  return {
    id: row.id,
    versionNo: row.versionNo,
    status: row.status,
    issuedAt: toDateTime(row.issuedAt) ?? '-',
    issuedByName: row.issuedBy?.displayName ?? '-',
    fileName: row.file?.fileName ?? '-',
    downloadUrl: row.file?.downloadUrl ?? '',
    changeReason: row.changeReason ?? undefined,
    measurementSessionId: row.sourceMeasurementSessionId,
  };
}

// --- 호출부 --------------------------------------------------------------------

/** WO-001 작업지시서 목록. status는 백엔드 허용 값만 보낸다(WAITING 전송 시 400). */
export function fetchWorkOrders(statuses?: WorkOrderFilterStatus[]): Promise<WorkOrderListRow[]> {
  return request<{ data: WorkOrderListApiRow[] }>({
    url: '/work-orders',
    params: {
      size: 100,
      ...(statuses && statuses.length > 0 ? { status: statuses.join(',') } : {}),
    },
  }).then((r) => (r.data ?? []).map(toListRow));
}

/**
 * WO-002 미리보기.
 * 옵션 확정이 없으면 백엔드가 422(WORK_ORDER_PREREQUISITE_MISSING)를 낸다.
 * measurementSessionId를 주면 연결된 채촌 대신 그 버전으로 미리본다(출력 API와 같은 규칙).
 */
export function fetchWorkOrderPreview(
  orderItemId: string,
  measurementSessionId?: string,
): Promise<WorkOrderPreview> {
  return request<WorkOrderPreviewApi>({
    url: `/order-items/${orderItemId}/work-order/preview`,
    params: measurementSessionId ? { measurementSessionId } : undefined,
  }).then(toPreview);
}

/** Excel 출력 → 새 작업지시서 버전 생성 (§14.5) */
export function issueWorkOrderVersion(
  orderItemId: string,
  body: { measurementSessionId?: string; note?: string },
): Promise<WorkOrderIssueResult> {
  return request<WorkOrderIssueResult>({
    url: `/order-items/${orderItemId}/work-order-versions`,
    method: 'POST',
    data: body,
  });
}

/** 출력 이력 — GET /work-orders/{workOrderId}/versions */
export function fetchWorkOrderVersions(workOrderId: string): Promise<WorkOrderVersionRow[]> {
  return request<WorkOrderVersionApiRow[]>({ url: `/work-orders/${workOrderId}/versions` }).then(
    (rows) => (rows ?? []).map(toVersionRow),
  );
}
