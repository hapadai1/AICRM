/**
 * AUDIT-001 감사로그 조회
 * - 기간(기본 최근 7일)/사용자/기능(액션)/대상 검색
 * - 상세 드로어: 변경 전/후 JSON 비교(변경 필드 강조), IP·요청 ID·사유
 */
import { SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Input,
  Row,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { fetchAuditLog, fetchUsers, searchAuditLogs } from '../../api/admin';
import {
  COMPONENT_TYPE_LABELS,
  PRODUCT_CATEGORY_LABELS,
  REPAIR_TYPE_LABELS_MAP,
} from '../../api/code-labels';
import { JOURNEY_STATUS_META, TRACK_TYPE_LABELS } from '../../api/journeys';
import { NOTIFICATION_STATUS_META, TEMPLATE_STATUS_META } from '../../api/notifications';
import {
  ALLOCATION_STATUS_META,
  RENTAL_ITEM_STATUS_META,
  RENTAL_SELECTION_STATUS_META,
} from '../../api/rentals';
import { REPAIR_STATUS_META } from '../../api/repairs';
import { DataTable } from '../../shared/DataTable';
import { PageCard, PageShell } from '../../shared/PageShell';
import { APPT_STATUS_META } from '../appointments/appointment-constants';
import {
  COMPONENT_STATUS_META,
  CONTRACT_STATUS_META,
  CONTRACT_VERSION_STATUS_META,
  OPTION_STATUS_META,
  ORDER_ITEM_STATUS_META,
} from '../contracts/labels';
import { CUSTOMER_STATUS_META } from '../customers/customer-constants';
import type { AuditLogItem } from '../../api/admin';

/** 서비스 계층에서 실제로 기록하는 action 코드 전체 (backend `audit.log({ action })`). */
const ACTION_META: Record<string, { label: string; color: string }> = {
  CREATE: { label: '생성', color: 'blue' },
  UPDATE: { label: '수정', color: 'gold' },
  DELETE: { label: '삭제', color: 'red' },
  CONFIRM: { label: '확정', color: 'green' },
  CANCEL: { label: '취소', color: 'volcano' },
  STATUS_CHANGE: { label: '상태 변경', color: 'purple' },
  EXPORT: { label: '출력', color: 'geekblue' },
  SEND: { label: '발송', color: 'cyan' },
  ACTIVATE: { label: '활성화', color: 'green' },
  COMPLETE: { label: '완료', color: 'green' },
  REVISE: { label: '개정', color: 'orange' },
  SIGN: { label: '서명', color: 'magenta' },
  REAUTH: { label: '재인증', color: 'default' },
  LINK: { label: '연결', color: 'cyan' },
  UNLINK: { label: '연결 해제', color: 'volcano' },
  UPLOAD: { label: '파일 첨부', color: 'blue' },
};

/** entity_type 한글 표기. 없으면 코드를 그대로 보여준다. */
const ENTITY_TYPE_LABELS: Record<string, string> = {
  USER: '사용자',
  ROLE_PERMISSION: '역할 권한',
  CUSTOMER: '고객',
  CUSTOMER_JOURNEY: '고객 여정',
  JOURNEY_STAGE: '여정 단계',
  JOURNEY_STAGE_ITEM_COMPLETION: '여정 단계 항목',
  JOURNEY_EVENT: '여정 이벤트',
  APPOINTMENT: '예약',
  APPOINTMENT_PURPOSE: '예약 목적',
  CONSULTATION: '상담',
  CONTRACT: '계약',
  CONTRACT_VERSION: '계약서 버전',
  CONTRACT_TYPE: '계약 유형',
  PAYMENT_METHOD: '결제 수단',
  ORDER_ITEM: '주문 품목',
  ORDER_ITEM_COMPONENT: '주문 구성품',
  ORDER_ITEM_MEASUREMENT: '주문 치수',
  OPTION_SELECTION_SESSION: '옵션 선택 세션',
  OPTION_SET_VERSION: '옵션셋 버전',
  OPTION_CHOICE: '옵션 선택지',
  MEASUREMENT_SESSION: '채촌 세션',
  MEASUREMENT_SESSION_IMAGE: '채촌 이미지',
  FITTING_SESSION: '가봉 세션',
  WORK_ORDER_VERSION: '작업지시서 버전',
  RENTAL_SELECTION_SESSION: '렌탈 선택 세션',
  RENTAL_ALLOCATION: '렌탈 배정',
  RENTAL_INVENTORY_ITEM: '렌탈 재고',
  RENTAL_COLOR: '렌탈 색상',
  RENTAL_SIZE: '렌탈 사이즈',
  REPAIR_REQUEST: '수선 요청',
  NOTIFICATION: '알림',
  NOTIFICATION_RULE: '알림 규칙',
  NOTIFICATION_TEMPLATE: '알림 템플릿',
  SHARED_NOTE: '공유 메모',
  DASHBOARD_TASK: '대시보드 할 일',
  MASTER_CODE_LABEL: '코드 라벨',
  FILE: '파일',
};

/** 그 기록이 어느 화면에서 생긴 것인지 — "옵션셋 버전"만 봐서는 어느 메뉴인지 알 수 없다. */
const ENTITY_MENU_LABELS: Record<string, string> = {
  USER: '관리자 > 사용자·권한',
  ROLE_PERMISSION: '관리자 > 사용자·권한',
  CUSTOMER: '고객',
  CUSTOMER_JOURNEY: '진행 현황',
  JOURNEY_STAGE: '진행 현황',
  JOURNEY_STAGE_ITEM_COMPLETION: '진행 현황',
  JOURNEY_EVENT: '진행 현황',
  APPOINTMENT: '예약',
  CONSULTATION: '예약',
  APPOINTMENT_PURPOSE: '관리자 > 기준정보',
  CONTRACT: '계약 관리',
  CONTRACT_VERSION: '계약 관리',
  CONTRACT_TYPE: '관리자 > 계약 구분',
  PAYMENT_METHOD: '관리자 > 계약 구분',
  ORDER_ITEM: '제작 관리',
  ORDER_ITEM_COMPONENT: '제작 관리',
  ORDER_ITEM_MEASUREMENT: '채촌',
  OPTION_SELECTION_SESSION: '스타일 컨설팅',
  OPTION_SET_VERSION: '관리자 > 옵션 세트',
  OPTION_CHOICE: '관리자 > 옵션 세트',
  MEASUREMENT_SESSION: '채촌',
  MEASUREMENT_SESSION_IMAGE: '채촌',
  FITTING_SESSION: '제작 관리',
  WORK_ORDER_VERSION: '제작 관리',
  RENTAL_SELECTION_SESSION: '스타일 컨설팅',
  RENTAL_ALLOCATION: '렌탈 관리 > 렌탈 예약',
  RENTAL_INVENTORY_ITEM: '렌탈 관리 > 렌탈 재고',
  RENTAL_COLOR: '관리자 > 기준정보',
  RENTAL_SIZE: '관리자 > 기준정보',
  REPAIR_REQUEST: '수선',
  NOTIFICATION: '고객 연락',
  NOTIFICATION_RULE: '관리자 > 연락 문구',
  NOTIFICATION_TEMPLATE: '관리자 > 연락 문구',
  SHARED_NOTE: '대시보드',
  DASHBOARD_TASK: '대시보드',
  MASTER_CODE_LABEL: '관리자 > 기준정보',
};

function actionTag(action: string) {
  const meta = ACTION_META[action];
  return <Tag color={meta?.color ?? 'default'}>{meta?.label ?? action} ({action})</Tag>;
}

/** 옵션셋 버전 상태 — 옵션 기준정보 화면(AdminOptionsPage)과 같은 표시명. */
const OPTION_SET_VERSION_STATUS_META: Record<string, { label: string }> = {
  DRAFT: { label: '작성중' },
  ACTIVE: { label: '사용중' },
  RETIRED: { label: '종료' },
};

/**
 * status 코드는 대상마다 뜻이 다르다(ACTIVE = 옵션셋은 '사용중', 여정은 '진행 중').
 * 그래서 각 화면이 쓰는 상태 표시명 맵을 대상 유형별로 그대로 빌려 쓴다.
 */
const STATUS_META_BY_ENTITY: Record<string, Record<string, { label: string }>> = {
  OPTION_SET_VERSION: OPTION_SET_VERSION_STATUS_META,
  OPTION_SELECTION_SESSION: OPTION_STATUS_META,
  CONTRACT: CONTRACT_STATUS_META,
  CONTRACT_VERSION: CONTRACT_VERSION_STATUS_META,
  ORDER_ITEM: ORDER_ITEM_STATUS_META,
  ORDER_ITEM_COMPONENT: COMPONENT_STATUS_META,
  APPOINTMENT: APPT_STATUS_META,
  CUSTOMER: CUSTOMER_STATUS_META,
  CUSTOMER_JOURNEY: JOURNEY_STATUS_META,
  REPAIR_REQUEST: REPAIR_STATUS_META,
  NOTIFICATION: NOTIFICATION_STATUS_META,
  NOTIFICATION_TEMPLATE: TEMPLATE_STATUS_META,
  RENTAL_INVENTORY_ITEM: RENTAL_ITEM_STATUS_META,
  RENTAL_ALLOCATION: ALLOCATION_STATUS_META,
  RENTAL_SELECTION_SESSION: RENTAL_SELECTION_STATUS_META,
};

/** 첨부 파일의 용도 코드 (entity_files.purpose). */
const FILE_PURPOSE_META: Record<string, { label: string }> = {
  FACTORY_SENT: { label: '공장 발송본' },
  FACTORY_REPLY: { label: '공장 회신본' },
  PHOTO: { label: '채촌 사진' },
};

/** 대상 유형과 무관하게 뜻이 고정된 코드 필드. */
const VALUE_META_BY_FIELD: Record<string, Record<string, { label: string }>> = {
  customerStatus: CUSTOMER_STATUS_META,
  versionStatus: CONTRACT_VERSION_STATUS_META,
  itemStatus: RENTAL_ITEM_STATUS_META,
  optionStatus: OPTION_STATUS_META,
  purpose: FILE_PURPOSE_META,
};

/**
 * 코드값의 한글 표시명. 없으면 null — 호출부가 원래 값을 그대로 쓴다.
 * 품목·구성품·수선구분 표시명은 로그인 후 서버 값으로 하이드레이션되는 공유 맵이라 호출 시점에 읽는다.
 */
function codeLabel(entityType: string, key: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (key === 'productCategory') return PRODUCT_CATEGORY_LABELS[value] ?? null;
  if (key === 'componentType' || key === 'componentGroup') return COMPONENT_TYPE_LABELS[value] ?? null;
  if (key === 'repairType') return REPAIR_TYPE_LABELS_MAP[value] ?? null;
  if (key === 'trackType') return TRACK_TYPE_LABELS[value as keyof typeof TRACK_TYPE_LABELS] ?? null;
  const byField = VALUE_META_BY_FIELD[key]?.[value]?.label;
  if (byField) return byField;
  if (key === 'status') return STATUS_META_BY_ENTITY[entityType]?.[value]?.label ?? null;
  return null;
}

/**
 * 감사로그 전/후는 DB 행 스냅샷이라 업무상 의미 없는 키가 섞여 있다.
 * 식별자·자동 타임스탬프·정규화 사본은 감춰서 "무엇이 어떻게 바뀌었나"만 남긴다.
 */
const NOISE_KEYS = new Set([
  'id',
  'createdAt',
  'updatedAt',
  'createdBy',
  'updatedBy',
  'rowVersion',
  'phoneNormalized',
]);

/** 자주 나오는 필드의 한글 표기. 없으면 원래 키를 그대로 보여준다. */
const FIELD_LABELS: Record<string, string> = {
  name: '이름',
  phone: '연락처',
  email: '이메일',
  notes: '메모',
  memo: '메모',
  status: '상태',
  customerStatus: '고객 상태',
  registeredAt: '정식등록일',
  contractedAt: '계약일',
  firstReservedAt: '최초 예약일',
  contractNo: '계약번호',
  contractTypeId: '계약 유형',
  versionNo: '버전',
  totalAmount: '총액',
  depositAmount: '계약금',
  balanceAmount: '잔금',
  completionDueDate: '완성 예정일',
  photoDate: '촬영일',
  weddingDate: '예식일',
  signedAt: '서명일시',
  signerName: '서명자',
  lines: '품목',
  quantity: '수량',
  startAt: '시작',
  endAt: '종료',
  purposeCode: '목적',
  stageCode: '단계',
  completed: '완료 여부',
  completedAt: '완료일시',
  valueCount: '입력 항목 수',
  reason: '사유',
  // 옵션 선택지 추가금액 수정 이력 — "과거 계약 옵션 가격이 왜 이랬지"를 되짚을 때 본다.
  extraPrice: '추가금액',
  stageName: '단계',
  choiceName: '선택지',
  optionSetName: '옵션셋',
  customerName: '고객',
  originalName: '파일명',
  purpose: '용도',
  stageCount: '단계 수',
  productCategory: '품목',
  componentType: '구성품',
  componentGroup: '구성품',
  managementCode: '관리번호',
  orderNo: '주문번호',
  assignedBy: '배정자',
  repairType: '수선 구분',
  trackType: '진행 트랙',
  loginId: '로그인 ID',
  templateName: '연락 문구',
  targetUserName: '대상 사용자',
  permissions: '권한',
  changeReason: '변경 사유',
  selectionVersionNo: '선택 버전',
  optionSummary: '선택 요약',
  linkedOrderItems: '연결 품목',
  customerPhone: '고객 연락처',
  staffName: '담당자',
  measurementDate: '채촌일',
  measurementType: '채촌 구분',
  itemStatus: '실물 상태',
  versionStatus: '버전 상태',
  active: '사용 여부',
  pickupDate: '출고일',
  returnDueDate: '반납 예정일',
  checkoutDate: '출고일',
  availableFrom: '대여 가능일',
  clearedSelections: '해제된 선택',
  // 렌탈 배정 스냅샷은 실물·구성품을 통째로 담는다 — 안쪽 항목까지 한글로 읽혀야 한다.
  rentalInventoryItem: '렌탈 실물',
  rentalSku: '실물 규격',
  orderItemComponent: '주문 구성품',
  orderItem: '주문 품목',
  displayName: '품목명',
  color: '색상',
  size: '사이즈',
  sequenceNo: '순번',
  availabilityEndDate: '가용 종료일',
  actualPickupAt: '실제 출고일시',
  actualReturnAt: '실제 반납일시',
  assignedAt: '배정일시',
  acquiredAt: '입고일',
  retiredAt: '폐기일',
  description: '설명',
  effectiveFrom: '적용 시작일',
};

const DATE_KEY_RE = /(At|Date)$/;
// extraPrice 처럼 Price 로 끝나는 금액 항목도 원화로 포맷한다.
const AMOUNT_KEY_RE = /(Amount|Price)$/;
/**
 * `...Id` 값은 UUID라 사람이 알아볼 수 없다 — 요약에서는 감추고 '전체 보기'에서만 본다.
 * (해당 대상의 이름은 서비스 계층이 전/후 스냅샷에 함께 남긴다: optionSetName 등)
 */
const ID_KEY_RE = /Ids?$/;
/** 키 이름과 상관없이(assignedBy 등) UUID 값은 요약에서 감춘다 — 사람이 알아볼 수 없다. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): boolean => typeof v === 'string' && UUID_RE.test(v);

/**
 * 중첩된 객체가 어느 대상의 데이터인지 — 상태 코드를 그 대상의 표시명으로 읽기 위해 쓴다.
 * (배정의 RESERVED는 '예약', 실물의 RESERVED는 '예약됨'처럼 같은 코드가 다르게 읽힌다)
 */
const NESTED_ENTITY_TYPE: Record<string, string> = {
  rentalInventoryItem: 'RENTAL_INVENTORY_ITEM',
  orderItemComponent: 'ORDER_ITEM_COMPONENT',
  orderItem: 'ORDER_ITEM',
  components: 'ORDER_ITEM_COMPONENT',
};

/**
 * 중첩 객체(렌탈 배정의 실물·구성품 등)를 "라벨 값" 나열로 편다.
 * JSON을 그대로 보여 주면 무슨 데이터가 담긴 줄인지 읽는 사람이 알 수 없다.
 * 한 단계 아래부터는 한 줄로 이어 붙여(`색상 블랙 · 사이즈 46`) 표가 세로로 늘어지지 않게 한다.
 */
function fmtObject(value: Record<string, unknown>, entityType: string, withCode: boolean, depth = 0): string {
  const entries = Object.entries(value).filter(
    ([key, v]) =>
      !NOISE_KEYS.has(key) && !ID_KEY_RE.test(key) && v !== null && v !== undefined && v !== '',
  );
  if (entries.length === 0) return '(없음)';
  const parts = entries.map(
    ([key, v]) => `${fieldLabel(entityType, key)} ${fmtValue(key, v, entityType, withCode, depth + 1)}`,
  );
  // 안쪽 묶음은 괄호로 싸야 어디까지가 그 항목의 값인지 보인다.
  return depth === 0 ? parts.join('\n') : `(${parts.join(' · ')})`;
}

/** 값을 사람이 읽는 형태로. 코드는 한글 표시명, 배열은 줄바꿈, 날짜는 로컬 표기, 금액은 천단위 구분. */
function fmtValue(key: string, v: unknown, entityType = '', withCode = false, depth = 0): string {
  if (v === undefined || v === null || v === '') return '-';
  const label = codeLabel(entityType, key, v);
  if (label) return withCode ? `${label} (${String(v)})` : label;
  if (typeof v === 'boolean') return v ? '예' : '아니오';
  // 객체 배열(예: 가봉 adjustments)을 String()으로 이으면 [object Object]만 남는다.
  if (Array.isArray(v))
    return v.length === 0
      ? '(없음)'
      : v
          .map((x) =>
            x !== null && typeof x === 'object'
              ? fmtObject(
                  x as Record<string, unknown>,
                  NESTED_ENTITY_TYPE[key] ?? entityType,
                  withCode,
                  depth + 1,
                )
              : String(x),
          )
          .join('\n');
  if (typeof v === 'string' && DATE_KEY_RE.test(key) && dayjs(v).isValid()) {
    const d = dayjs(v);
    return d.hour() === 0 && d.minute() === 0 ? d.format('YYYY-MM-DD') : d.format('YYYY-MM-DD HH:mm');
  }
  if (AMOUNT_KEY_RE.test(key)) {
    const n = Number(v);
    if (!Number.isNaN(n)) return `${n.toLocaleString('ko-KR')}원`;
  }
  if (typeof v === 'object')
    return fmtObject(
      v as Record<string, unknown>,
      NESTED_ENTITY_TYPE[key] ?? entityType,
      withCode,
      depth,
    );
  return String(v);
}

/** 목록에서 한 줄로 보여줄 변경 항목 수. 넘치면 상세 드로어로 넘긴다. */
const CHANGES_INLINE_LIMIT = 3;

/**
 * 목록 한 줄에 들어갈 만큼 짧게 자른 값.
 * fmtValue는 배열을 줄바꿈으로 이어 붙이고 객체를 JSON으로 펼쳐 목록에서는 너무 길어진다.
 */
function fmtInline(key: string, v: unknown, entityType: string): string {
  const text = fmtValue(key, v, entityType).replace(/\s+/g, ' ');
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** 비교용 원시 표현 — 표시 포맷과 달리 값 동일성만 본다. */
const raw = (v: unknown) => (v === undefined ? ' undefined' : JSON.stringify(v));

/** 전/후 JSON에서 값이 달라진 키만 추린다. 한쪽이 null(생성·삭제)이면 반대쪽 키 전체가 변경이다. */
function changedKeys(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string[] {
  const keys = Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]));
  const oneSided = !before || !after;
  const changed = keys.filter((key) => {
    if (NOISE_KEYS.has(key)) return false;
    // 생성·삭제 로그에서 값이 비어 있던 항목("실제 반납일시 -")은 알려 줄 게 없다.
    if (oneSided) {
      const value = (before ?? after)?.[key];
      return value !== null && value !== undefined && value !== '';
    }
    return raw(before?.[key]) !== raw(after?.[key]);
  });
  const readable = changed.filter(
    (key) => !ID_KEY_RE.test(key) && !isUuid(before?.[key]) && !isUuid(after?.[key]),
  );
  // 바뀐 게 식별자뿐인 로그(예: 배정 실물 교체)는 감추면 보여줄 게 없어진다 — 그대로 둔다.
  return readable.length > 0 ? readable : changed;
}

/**
 * 기록 형태. 삭제는 전 값만, 생성은 후 값만 남는데 이를 "값 → -" 로 보여주면
 * 무엇이 사라졌다는 건지 읽는 사람이 헷갈린다. 한쪽만 있는 로그는 화살표 없이 그 값만 보여준다.
 */
type ChangeMode = 'before' | 'after' | 'diff';

function changeMode(log: Pick<AuditLogItem, 'before' | 'after'>): ChangeMode {
  const hasBefore = !!log.before && Object.keys(log.before).length > 0;
  const hasAfter = !!log.after && Object.keys(log.after).length > 0;
  if (hasBefore && !hasAfter) return 'before';
  if (!hasBefore && hasAfter) return 'after';
  return 'diff';
}

/** 스냅샷에서 사람이 부르는 이름을 만드는 필드 (앞선 것부터 쓴다). */
const NAME_KEYS = [
  'optionSetName',
  'contractNo',
  'managementCode',
  'customerName',
  'name',
  'displayName',
  'templateName',
  'title',
  'stageName',
  'originalName',
];

/**
 * 같은 키가 대상에 따라 다른 뜻인 경우의 라벨 (displayName: 주문 품목은 '품목명', 사용자는 '이름').
 */
const FIELD_LABELS_BY_ENTITY: Record<string, Record<string, string>> = {
  USER: { displayName: '이름', status: '계정 상태' },
  SHARED_NOTE: { content: '메모' },
};

function fieldLabel(entityType: string, key: string): string {
  return FIELD_LABELS_BY_ENTITY[entityType]?.[key] ?? FIELD_LABELS[key] ?? key;
}

/**
 * 이름을 여러 항목으로 만들어야 하는 대상.
 * 렌탈 배정은 관리번호만으로는 "누구 것인지" 알 수 없어 고객명을 앞에 붙인다.
 */
const ENTITY_NAME_PARTS: Record<string, string[]> = {
  RENTAL_ALLOCATION: ['customerName', 'managementCode'],
  CONTRACT: ['customerName', 'contractNo'],
  CONTRACT_VERSION: ['customerName', 'contractNo'],
  // 주문 품목에서 뻗어 나온 대상들 — 계약번호보다 "누구의 어떤 품목"이 먼저 읽혀야 한다.
  ORDER_ITEM: ['customerName', 'displayName'],
  ORDER_ITEM_COMPONENT: ['customerName', 'displayName'],
  OPTION_SELECTION_SESSION: ['customerName', 'displayName'],
  RENTAL_SELECTION_SESSION: ['customerName', 'displayName'],
  FITTING_SESSION: ['customerName', 'displayName'],
  WORK_ORDER_VERSION: ['customerName', 'displayName'],
  MEASUREMENT_SESSION: ['customerName'],
  MEASUREMENT_SESSION_IMAGE: ['customerName'],
  REPAIR_REQUEST: ['customerName'],
  CUSTOMER_JOURNEY: ['customerName'],
  APPOINTMENT: ['customerName'],
  CONSULTATION: ['customerName'],
  CUSTOMER: ['customerName'],
  USER: ['name', 'displayName'],
  FILE: ['originalName'],
};

const isFilledString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * 스냅샷 하나에서 사람이 부르는 이름을 만든다 — "정장 옵션 버전 2", "홍길동 · JKT-BLACK-46-001".
 * 서비스 계층이 전/후 스냅샷에 이름(optionSetName·customerName 등)을 함께 남겨 주는 것이 전제다.
 */
function snapshotName(snapshot: Record<string, unknown> | null, entityType: string): string | null {
  if (!snapshot) return null;
  const parts = ENTITY_NAME_PARTS[entityType];
  const picked = parts
    ? parts.map((key) => snapshot[key]).filter(isFilledString)
    : [NAME_KEYS.map((key) => snapshot[key]).find(isFilledString)].filter(isFilledString);
  const versionNo = snapshot.versionNo;
  // 보강된 이름과 스냅샷의 이름이 겹칠 수 있다("관리자 · 관리자") — 같은 값은 한 번만 쓴다.
  const name = Array.from(new Set(picked)).join(' · ');
  return [name || null, versionNo != null ? `버전 ${String(versionNo)}` : null]
    .filter(Boolean)
    .join(' ') || null;
}

/** 이름으로 이미 쓴 필드 — 같은 값을 '변경 내용'에서 또 읽게 하지 않는다. */
function nameKeySet(entityType: string): Set<string> {
  return new Set([...(ENTITY_NAME_PARTS[entityType] ?? NAME_KEYS), 'versionNo']);
}

/**
 * 목록 '대상'에 함께 보여줄 이름 — "옵션셋 버전"만으로는 어느 화면의 무엇인지 알 수 없다.
 */
function targetName(log: Pick<AuditLogItem, 'before' | 'after' | 'entityType'>): string | null {
  return snapshotName({ ...(log.before ?? {}), ...(log.after ?? {}) }, log.entityType);
}

/** 한쪽만 남는 로그의 반대쪽 표기 — "-" 로 두면 무슨 일이 일어난 건지 읽히지 않는다. */
const ONE_SIDED_COUNTERPART: Record<'before' | 'after', string> = {
  before: '삭제됨',
  after: '없음',
};

/**
 * 대상을 "무엇 → 어떻게 됐는지"로 읽히게 만든다.
 * - 삭제: `정장 옵션 버전 2 → 삭제됨`
 * - 생성: `없음 → 홍길동`
 * - 수정: 이름이 그대로면 이름만, 이름 자체가 바뀌었으면 `옛 이름 → 새 이름`
 */
function targetFlow(log: Pick<AuditLogItem, 'before' | 'after' | 'entityType'>): {
  from: string | null;
  to: string;
  /** 삭제 로그 — 사라졌다는 사실을 색으로도 구분한다. */
  removed?: boolean;
} {
  const typeLabel = ENTITY_TYPE_LABELS[log.entityType] ?? log.entityType;
  const mode = changeMode(log);
  if (mode === 'before') {
    return {
      from: snapshotName(log.before, log.entityType) ?? typeLabel,
      to: ONE_SIDED_COUNTERPART.before,
      removed: true,
    };
  }
  if (mode === 'after') {
    const name = snapshotName(log.after, log.entityType);
    // 이름이 없으면 "없음 → 가봉 세션"이 되어 세션을 새로 만든 것처럼 읽힌다 — 유형만 둔다.
    return name ? { from: ONE_SIDED_COUNTERPART.after, to: name } : { from: null, to: typeLabel };
  }
  const before = snapshotName(log.before, log.entityType);
  const after = snapshotName(log.after, log.entityType);
  if (before && after && before !== after) return { from: before, to: after };
  return { from: null, to: after ?? before ?? typeLabel };
}

/**
 * 조사(을/를·으로/로)를 고르기 위한 받침 판정. 0=받침 없음, 8=ㄹ, 그 외=받침 있음.
 * 숫자로 끝나는 이름("버전 2")도 읽는 음을 따라야 "버전 2를"처럼 자연스럽다.
 */
const DIGIT_FINAL: Record<string, number> = {
  '0': 21, // 영
  '1': 8, // 일
  '2': 0, // 이
  '3': 16, // 삼
  '4': 0, // 사
  '5': 0, // 오
  '6': 1, // 육
  '7': 8, // 칠
  '8': 8, // 팔
  '9': 0, // 구
};

function finalConsonant(word: string): number {
  // 이름을 괄호로 감싼 경우("… (옵션셋 버전)") 닫는 기호 말고 그 앞 글자로 판단한다.
  const trimmed = word.trim().replace(/[)\]'"’”」』]+$/, '');
  const last = trimmed.slice(-1);
  if (!last) return 0;
  if (DIGIT_FINAL[last] !== undefined) return DIGIT_FINAL[last];
  const code = last.charCodeAt(0);
  // 한글이 아니면(영문·확장자 등) 받침 없음으로 본다 — "…xlsx를" 이 자연스럽다.
  if (code < 0xac00 || code > 0xd7a3) return 0;
  return (code - 0xac00) % 28;
}

const objectSuffix = (word: string) => (finalConsonant(word) === 0 ? '를' : '을');
const towardSuffix = (word: string) => {
  const final = finalConsonant(word);
  return final === 0 || final === 8 ? '로' : '으로';
};

/** 액션을 문장 서술어로. 목록의 태그(삭제/수정)와 같은 말을 쓴다. */
const ACTION_PREDICATE: Record<string, string> = {
  CREATE: '등록했습니다',
  UPDATE: '수정했습니다',
  DELETE: '삭제했습니다',
  CONFIRM: '확정했습니다',
  CANCEL: '취소했습니다',
  STATUS_CHANGE: '바꿨습니다',
  EXPORT: '출력했습니다',
  SEND: '발송했습니다',
  ACTIVATE: '활성화했습니다',
  COMPLETE: '완료 처리했습니다',
  REVISE: '개정했습니다',
  SIGN: '서명했습니다',
  REAUTH: '재인증했습니다',
  LINK: '연결했습니다',
  UNLINK: '연결을 해제했습니다',
  UPLOAD: '첨부했습니다',
};

/** 문장에서 한 번에 읽어 줄 변경 항목 수. 넘으면 "등 N개 항목"으로 줄인다. */
const SENTENCE_FIELD_LIMIT = 2;

/**
 * 로그 한 줄을 "뭘 어떻게 했다"는 문장으로 만든다.
 * 대상 칸과 값이 겹치더라도, 목록만 훑어도 무슨 일이 있었는지 알 수 있는 쪽을 택했다.
 * - 삭제: `정장 옵션 버전 2(옵션셋 버전)을 삭제했습니다`
 * - 한 항목 수정: `계약 C-2026-0001(계약)의 상태를 작성중 → 등록으로 수정했습니다`
 * - 여러 항목 수정: `… 의 상태·총액 등 3개 항목을 수정했습니다`
 */
function changeSentence(log: Pick<AuditLogItem, 'action' | 'before' | 'after' | 'entityType'>): string {
  const typeLabel = ENTITY_TYPE_LABELS[log.entityType] ?? log.entityType;
  const name = targetName(log);
  const subject = name ? `${name}(${typeLabel})` : typeLabel;
  const predicate =
    ACTION_PREDICATE[log.action] ?? `${ACTION_META[log.action]?.label ?? log.action} 처리했습니다`;

  // 파일 첨부는 "무슨 파일을 붙였나"가 핵심이다.
  // 예전 로그는 액션이 CREATE로 남아 있어 파일명 유무로도 알아본다.
  const fileName = (log.after?.originalName ?? log.before?.originalName) as string | undefined;
  if (log.action === 'UPLOAD' || (fileName && log.action === 'CREATE')) {
    return fileName
      ? `${typeLabel}에 파일 ${fileName}${objectSuffix(fileName)} 첨부했습니다`
      : `${typeLabel}에 파일을 첨부했습니다`;
  }

  const named = nameKeySet(log.entityType);
  const keys = changedKeys(log.before, log.after).filter((key) => !named.has(key));
  if (changeMode(log) === 'diff' && keys.length > 0) {
    if (keys.length === 1) {
      const key = keys[0];
      const label = fieldLabel(log.entityType, key);
      const from = fmtInline(key, log.before?.[key], log.entityType);
      const to = fmtInline(key, log.after?.[key], log.entityType);
      return `${subject}의 ${label}${objectSuffix(label)} ${from} → ${to}${towardSuffix(to)} ${predicate}`;
    }
    const labels = keys
      .slice(0, SENTENCE_FIELD_LIMIT)
      .map((key) => fieldLabel(log.entityType, key))
      .join('·');
    const rest = keys.length > SENTENCE_FIELD_LIMIT ? ` 등 ${keys.length}개 항목` : '';
    return `${subject}의 ${labels}${rest}${objectSuffix(`${labels}${rest}`)} ${predicate}`;
  }
  return `${subject}${objectSuffix(subject)} ${predicate}`;
}

/** 한쪽 값만 남는 로그(생성·삭제)의 표 제목 — "변경 전/후" 라고 쓰면 사라진 값인지 새 값인지 모른다. */
const SINGLE_COLUMN_TITLE: Record<'before' | 'after', string> = {
  before: '삭제 전 값',
  after: '등록된 값',
};

/**
 * 변경 전/후 비교. 기본은 실제로 달라진 필드만 보여주고,
 * 나머지(안 바뀐 값·내부 식별자)는 '전체 보기'로 펼친다.
 * 상태 코드는 한글 표시명으로 바꾸되, 문제를 되짚을 때 필요하도록 원래 코드도 괄호로 함께 둔다.
 */
function DiffView({
  before,
  after,
  entityType,
}: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  entityType: string;
}) {
  const [showAll, setShowAll] = useState(false);

  const allKeys = Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]));
  const changed = changedKeys(before, after);
  const keys = showAll ? allKeys : changed;
  const mode = changeMode({ before, after });

  if (allKeys.length === 0) {
    return <Typography.Text type="secondary">변경값 기록이 없습니다.</Typography.Text>;
  }
  const cell = { padding: '6px 8px', border: '1px solid #f0f0f0', whiteSpace: 'pre-line' as const };
  const single = mode === 'diff' ? null : (mode as 'before' | 'after');
  const summary =
    single !== null
      ? `기록된 항목 ${changed.length}건`
      : changed.length === 0
        ? '달라진 값이 없습니다.'
        : `변경된 항목 ${changed.length}건`;
  return (
    <div style={{ overflowX: 'auto' }}>
      <Space style={{ marginBottom: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {summary}
        </Typography.Text>
        <Typography.Link style={{ fontSize: 12 }} onClick={() => setShowAll((v) => !v)}>
          {showAll ? '변경된 항목만' : `전체 보기 (${allKeys.length})`}
        </Typography.Link>
      </Space>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: '#fafafa' }}>
            <th style={{ textAlign: 'left', ...cell }}>항목</th>
            {single !== null ? (
              <th style={{ textAlign: 'left', ...cell }}>{SINGLE_COLUMN_TITLE[single]}</th>
            ) : (
              <>
                <th style={{ textAlign: 'left', ...cell }}>변경 전</th>
                <th style={{ textAlign: 'left', ...cell }}>변경 후</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => {
            const b = before?.[key];
            const a = after?.[key];
            const isChanged = raw(b) !== raw(a);
            return (
              <tr key={key} style={{ background: isChanged ? '#fffbe6' : undefined }}>
                <td style={{ ...cell, fontWeight: 600 }}>{fieldLabel(entityType, key)}</td>
                {single !== null ? (
                  <td style={cell}>{fmtValue(key, single === 'before' ? b : a, entityType, true)}</td>
                ) : (
                  <>
                    <td style={cell}>{fmtValue(key, b, entityType, true)}</td>
                    <td style={cell}>
                      {isChanged ? (
                        <Typography.Text mark>{fmtValue(key, a, entityType, true)}</Typography.Text>
                      ) : (
                        fmtValue(key, a, entityType, true)
                      )}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface Filters {
  range: [Dayjs, Dayjs];
  userId?: string;
  action?: string;
  query?: string;
}

export function AuditLogPage() {
  // 입력 중 값과 실제 적용된 검색 조건을 분리한다 (검색 버튼/Enter로 실행).
  const [draft, setDraft] = useState<Filters>({ range: [dayjs().subtract(6, 'day'), dayjs()] });
  const [applied, setApplied] = useState<Filters>(draft);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(30);
  const [detailId, setDetailId] = useState<string | null>(null);

  const usersQuery = useQuery({ queryKey: ['users'], queryFn: fetchUsers });

  const searchParams = useMemo(
    () => ({
      from: applied.range[0].format('YYYY-MM-DD'),
      to: applied.range[1].format('YYYY-MM-DD'),
      userId: applied.userId,
      action: applied.action,
      query: applied.query?.trim() || undefined,
      page,
      size,
    }),
    [applied, page, size],
  );

  const logsQuery = useQuery({
    queryKey: ['audit-logs', searchParams],
    queryFn: () => searchAuditLogs(searchParams),
  });

  const detailQuery = useQuery({
    queryKey: ['audit-logs', 'detail', detailId],
    queryFn: () => fetchAuditLog(detailId!),
    enabled: !!detailId,
  });
  const detail = detailQuery.data;

  const applyFilters = () => {
    setPage(1);
    setApplied(draft);
  };

  const columns: ColumnsType<AuditLogItem> = [
    {
      title: '일시',
      dataIndex: 'occurredAt',
      width: 150,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
    },
    { title: '사용자', dataIndex: 'userName', width: 140 },
    { title: '작업', dataIndex: 'action', width: 150, render: actionTag },
    {
      // 엔티티 코드·UUID는 목록에서 뺐다 — 줄마다 40자를 차지하면서 정작 궁금한
      // "무엇이 어떻게 바뀌었나"를 오른쪽으로 밀어냈다. 전문은 상세 드로어에서 본다.
      // 대신 대상 이름을 "정장 옵션 버전 2 → 삭제됨" 처럼 전/후로 보여준다 —
      // 유형만으로는 어느 화면의 무엇이 어떻게 됐는지 알 수 없다.
      title: '대상',
      key: 'target',
      width: 200,
      render: (_, log) => {
        const type = ENTITY_TYPE_LABELS[log.entityType] ?? log.entityType;
        const flow = targetFlow(log);
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text style={{ fontSize: 12 }}>
              {flow.from && (
                <>
                  <Typography.Text strong={flow.removed} style={{ fontSize: 12 }}>
                    {flow.from}
                  </Typography.Text>
                  {' → '}
                </>
              )}
              <Typography.Text
                strong={!flow.removed}
                type={flow.removed ? 'danger' : undefined}
                style={{ fontSize: 12 }}
              >
                {flow.to}
              </Typography.Text>
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {type}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      // 첫 줄은 "뭘 어떻게 했다"는 문장, 아랫줄은 그 근거가 되는 값이다.
      // 대상 칸과 이름이 겹치더라도 목록만 훑어서 무슨 일이 있었는지 알 수 있는 쪽을 택했다.
      title: '변경 내용',
      key: 'changes',
      render: (_, log) => {
        const changed = changedKeys(log.before, log.after);
        const mode = changeMode(log);
        // 이름·버전은 문장에 이미 들어 있다 — 값 줄에서는 나머지만 보여준다.
        const named = nameKeySet(log.entityType);
        const withoutName = changed.filter((key) => !named.has(key));
        const keys = withoutName.length > 0 ? withoutName : changed;
        const shown = keys.slice(0, CHANGES_INLINE_LIMIT);
        const values = shown
          .map((key) => {
            const label = fieldLabel(log.entityType, key);
            if (mode === 'diff') {
              const from = fmtInline(key, log.before?.[key], log.entityType);
              const to = fmtInline(key, log.after?.[key], log.entityType);
              return `${label} ${from} → ${to}`;
            }
            const v = mode === 'before' ? log.before?.[key] : log.after?.[key];
            return `${label} ${fmtInline(key, v, log.entityType)}`;
          })
          .join(' · ');
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text strong style={{ fontSize: 12 }}>
              {changeSentence(log)}
            </Typography.Text>
            {shown.length > 0 && (
              // 값만 나열하면 "지금 이런 상태"로 읽힌다 — 언제 시점의 값인지 먼저 밝힌다.
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {mode === 'diff' ? '' : `${SINGLE_COLUMN_TITLE[mode]} · `}
                {values}
                {keys.length > shown.length && ` · 외 ${keys.length - shown.length}건`}
              </Typography.Text>
            )}
          </Space>
        );
      },
    },
    { title: '사유', dataIndex: 'reason', width: 200, render: (v?: string) => v ?? '-' },
    { title: 'IP', dataIndex: 'ip', width: 130, render: (v?: string) => v ?? '-' },
  ];

  return (
    <PageShell>
      {/* 제목은 헤더가 "감사로그"로 보여 준다 — 카드에서 반복하지 않는다. */}
      <PageCard>
        <Row gutter={[12, 12]} align="middle">
          <Col>
            <Space size="small">
              <Typography.Text>기간</Typography.Text>
              <DatePicker.RangePicker
                value={draft.range}
                allowClear={false}
                onChange={(range) => {
                  if (range?.[0] && range[1]) {
                    setDraft((prev) => ({ ...prev, range: [range[0]!, range[1]!] }));
                  }
                }}
              />
            </Space>
          </Col>
          <Col>
            <Select
              allowClear
              placeholder="사용자"
              style={{ minWidth: 140 }}
              value={draft.userId}
              onChange={(v: string | undefined) => setDraft((prev) => ({ ...prev, userId: v }))}
              options={(usersQuery.data ?? []).map((u) => ({ value: u.id, label: u.name }))}
            />
          </Col>
          <Col>
            <Select
              allowClear
              placeholder="기능(작업)"
              style={{ minWidth: 150 }}
              value={draft.action}
              onChange={(v: string | undefined) => setDraft((prev) => ({ ...prev, action: v }))}
              options={Object.entries(ACTION_META).map(([value, meta]) => ({
                value,
                label: `${meta.label} (${value})`,
              }))}
            />
          </Col>
          <Col flex="260px">
            <Input
              allowClear
              placeholder="대상 검색 (엔티티·ID·라벨)"
              prefix={<SearchOutlined />}
              value={draft.query}
              onChange={(e) => setDraft((prev) => ({ ...prev, query: e.target.value }))}
              onPressEnter={applyFilters}
            />
          </Col>
          <Col>
            <Button type="primary" icon={<SearchOutlined />} onClick={applyFilters}>
              검색
            </Button>
          </Col>
        </Row>
      </PageCard>

      <PageCard>
        <DataTable<AuditLogItem>
          rowKey="id"
          loading={logsQuery.isLoading}
          dataSource={logsQuery.data?.data ?? []}
          columns={columns}
          pagination={{
            current: page,
            pageSize: size,
            total: logsQuery.data?.page.totalElements ?? 0,
            showSizeChanger: true,
            pageSizeOptions: [30, 50, 100],
            onChange: (nextPage, nextSize) => {
              setPage(nextPage);
              setSize(nextSize);
            },
            showTotal: (total) => `총 ${total}건`,
          }}
          onRow={(log) => ({
            onClick: () => setDetailId(log.id),
            style: { cursor: 'pointer' },
          })}
          locale={{ emptyText: '조회된 감사로그가 없습니다.' }}
        />
      </PageCard>

      <Drawer
        title="감사로그 상세"
        width={640}
        open={!!detailId}
        onClose={() => setDetailId(null)}
        loading={detailQuery.isLoading}
      >
        {detail && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions
              size="small"
              column={1}
              bordered
              items={[
                {
                  key: 'summary',
                  label: '요약',
                  children: (
                    <Typography.Text strong>{`${detail.userName} — ${changeSentence(detail)}`}</Typography.Text>
                  ),
                },
                {
                  key: 'when',
                  label: '일시',
                  children: dayjs(detail.occurredAt).format('YYYY-MM-DD HH:mm:ss'),
                },
                { key: 'who', label: '사용자', children: detail.userName },
                { key: 'action', label: '작업', children: actionTag(detail.action) },
                {
                  key: 'target',
                  label: '대상',
                  children: (() => {
                    const flow = targetFlow(detail);
                    const type = ENTITY_TYPE_LABELS[detail.entityType] ?? detail.entityType;
                    const name = flow.from ? `${flow.from} → ${flow.to}` : flow.to;
                    return name === type ? type : `${name} — ${type}`;
                  })(),
                },
                {
                  key: 'menu',
                  label: '메뉴',
                  children: ENTITY_MENU_LABELS[detail.entityType] ?? '-',
                },
                {
                  // 식별자는 문의·재현 때만 필요하다 — 대상 이름 아래로 내렸다.
                  key: 'identity',
                  label: '식별자',
                  children: `${detail.entityType} / ${detail.entityId}`,
                },
                { key: 'reason', label: '사유', children: detail.reason ?? '-' },
                { key: 'ip', label: 'IP', children: detail.ip ?? '-' },
              ]}
            />
            <div>
              <Typography.Title level={5}>변경 전/후 비교</Typography.Title>
              <DiffView
                before={detail.before}
                after={detail.after}
                entityType={detail.entityType}
              />
            </div>
          </Space>
        )}
      </Drawer>
    </PageShell>
  );
}
