/**
 * 상태 코드 사전 — 도메인별 상태 코드·표시명·색의 **단일 출처** (2026-08-05).
 *
 * 전에는 같은 상태의 표시명·색이 프론트 화면마다 손으로 복제돼 있었고
 * (주문품목 상태 맵 3벌, 옵션 상태 맵 3벌), 사본끼리 값이 어긋나
 * 같은 상태가 화면마다 다른 이름·다른 색으로 보였다. 여기서 한 번 정의하고
 * `GET /status-catalog`로 내려 주면 프론트가 code-labels처럼 하이드레이션한다.
 *
 * 흐름(순서)이 있는 도메인은 배열 순서가 곧 진행 순서다 — 프론트 진행률·완료 판정이
 * 이 순서를 그대로 쓰므로, 흐름 정의(production-status)에서 파생시켜 어긋날 수 없게 한다.
 *
 * DB enum 대신 varchar + 상수 배열 원칙(구현표준 1.2)은 그대로다 — 여기는 검증이 아니라
 * 표시의 출처이고, 전이 검증은 각 도메인의 흐름 배열이 담당한다.
 */
import { COMPONENT_STATUS_FLOW, ITEM_STATUS_FLOW } from '../modules/production/production-status';

export interface StatusCatalogEntry {
  code: string;
  label: string;
  color: string;
}

type Meta = { label: string; color: string };

/** 흐름 배열 + 라벨 맵 → 사전 엔트리. 흐름에 라벨이 빠지면 기동 시점에 죽는다(런타임 누락 방지). */
function fromFlow(codes: readonly string[], meta: Record<string, Meta>): StatusCatalogEntry[] {
  return codes.map((code) => {
    const m = meta[code];
    if (!m) throw new Error(`status-catalog: '${code}' 라벨 정의가 없습니다.`);
    return { code, ...m };
  });
}

/**
 * 주문품목 상태 표시 (ITEM_STATUS_FLOW 순서).
 * COMPLETED는 흐름 밖 표시 전용(시드·과거 데이터), CANCELLED는 종결 상태다.
 */
const ORDER_ITEM_META: Record<string, Meta> = {
  CREATED: { label: '생성', color: 'default' },
  OPTION_PENDING: { label: '옵션 대기', color: 'gold' },
  MEASUREMENT_PENDING: { label: '채촌 대기', color: 'gold' },
  READY_TO_ORDER: { label: '발주 가능', color: 'orange' },
  PRODUCTION_REQUESTED: { label: '제작 요청', color: 'blue' },
  PRODUCTION_IN_PROGRESS: { label: '제작 중', color: 'geekblue' },
  BASTING_RECEIVED: { label: '가봉 입고', color: 'purple' },
  FITTING_COMPLETED: { label: '가봉 완료', color: 'purple' },
  PRODUCTION_COMPLETED: { label: '제작 완료', color: 'cyan' },
  PARTIALLY_RECEIVED: { label: '부분 입고', color: 'orange' },
  RECEIVED: { label: '전체 입고', color: 'green' },
  PARTIALLY_RELEASED: { label: '부분 출고', color: 'lime' },
  RELEASED: { label: '전체 출고', color: 'green' },
  COMPLETED: { label: '완료', color: 'green' },
  CANCELLED: { label: '취소', color: 'red' },
};

/** 구성품 상태 표시 (COMPONENT_STATUS_FLOW 순서 + 렌탈 실물 흐름에서 오는 상태). */
const COMPONENT_META: Record<string, Meta> = {
  CREATED: { label: '생성', color: 'default' },
  PRODUCTION_REQUESTED: { label: '제작 요청', color: 'blue' },
  PRODUCTION_IN_PROGRESS: { label: '제작 중', color: 'geekblue' },
  BASTING_RECEIVED: { label: '가봉 입고', color: 'purple' },
  PRODUCTION_COMPLETED: { label: '제작 완료', color: 'cyan' },
  RECEIVED: { label: '입고', color: 'green' },
  RELEASED: { label: '출고', color: 'green' },
  RESERVED: { label: '렌탈 예약', color: 'purple' },
  CHECKED_OUT: { label: '렌탈 출고', color: 'magenta' },
  RETURNED: { label: '반납', color: 'cyan' },
  CANCELLED: { label: '취소', color: 'red' },
};

export const STATUS_CATALOG: Record<string, StatusCatalogEntry[]> = {
  /** 계약 흐름: 작성중 → 서명완료 → 계약완료 → (수정하기로) 작성중 … / 취소는 종결 (0731). */
  contract: [
    { code: 'DRAFT', label: '작성중', color: 'gold' },
    { code: 'SIGNED', label: '서명완료', color: 'geekblue' },
    { code: 'COMPLETED', label: '계약완료', color: 'blue' },
    { code: 'CANCELLED', label: '취소', color: 'red' },
  ],
  'contract-version': [
    { code: 'DRAFT', label: '작성중', color: 'gold' },
    { code: 'CONFIRMED', label: '적용', color: 'green' },
    { code: 'SUPERSEDED', label: '이전 버전', color: 'default' },
  ],
  /** 주문 헤더 — 실제로 쓰는 값은 생성·취소 (COMPLETED는 시드·과거 데이터 표시용). */
  order: [
    { code: 'CREATED', label: '생성', color: 'default' },
    { code: 'COMPLETED', label: '완료', color: 'green' },
    { code: 'CANCELLED', label: '취소', color: 'red' },
  ],
  'order-item': fromFlow([...ITEM_STATUS_FLOW, 'COMPLETED', 'CANCELLED'], ORDER_ITEM_META),
  component: fromFlow(
    [...COMPONENT_STATUS_FLOW, 'RESERVED', 'CHECKED_OUT', 'RETURNED', 'CANCELLED'],
    COMPONENT_META,
  ),
  /** 렌탈 선택 세션 (렌탈 스타일 컨설팅) 진행 상태 — NOT_STARTED는 세션 없음의 화면 표기. */
  'rental-selection': [
    { code: 'NOT_STARTED', label: '미시작', color: 'default' },
    { code: 'IN_PROGRESS', label: '작성 중', color: 'processing' },
    { code: 'CONFIRMED', label: '확정', color: 'green' },
  ],
  /** 옵션 선택 세션 (맞춤 스타일 컨설팅) 진행 상태. */
  'option-session': [
    { code: 'NOT_STARTED', label: '미시작', color: 'default' },
    { code: 'IN_PROGRESS', label: '진행중', color: 'blue' },
    { code: 'REVIEW', label: '확인대기', color: 'orange' },
    { code: 'CONFIRMED', label: '확정', color: 'green' },
  ],
  /** 작업지시서 목록 판정 (work-order-status.resolveWorkOrderStatus 계산값). */
  'work-order': [
    { code: 'WAITING', label: '준비 미완', color: 'default' },
    { code: 'UNORDERED', label: '미주문', color: 'red' },
    { code: 'CURRENT', label: '최신', color: 'green' },
  ],
  /** 채촌 구분 — 채촌을 하게 된 업무 단계로 표기한다. */
  'measurement-type': [
    { code: 'INITIAL', label: '스타일 컨설팅', color: 'blue' },
    { code: 'FITTING', label: '가봉', color: 'purple' },
    { code: 'REMEASURE', label: '수선', color: 'orange' },
    { code: 'OTHER', label: '기타', color: 'default' },
  ],
};

export interface StatusCatalogResponse {
  statuses: Record<string, StatusCatalogEntry[]>;
  /** 진행 순서가 있는 도메인의 흐름 — 프론트 진행률·완료 판정이 이 순서를 쓴다. */
  flows: { orderItem: string[]; component: string[] };
}

export function statusCatalogResponse(): StatusCatalogResponse {
  return {
    statuses: STATUS_CATALOG,
    flows: { orderItem: [...ITEM_STATUS_FLOW], component: [...COMPONENT_STATUS_FLOW] },
  };
}
