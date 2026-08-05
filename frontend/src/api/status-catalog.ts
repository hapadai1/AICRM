/**
 * 상태 코드 사전 — 도메인별 상태 표시명·색·흐름 순서의 중앙 관리.
 *
 * **단일 출처는 서버(common/status-catalog.ts)**이며, 여기 값은 하이드레이션 전 폴백이다.
 * code-labels와 같은 방식: 아래 맵·배열은 "공유 가변 객체"다. 모든 소비처가 이 객체 참조를
 * 그대로 import 해 쓰고, 로그인 후 /status-catalog 를 받아 in-place 갱신하면 전 화면에 반영된다.
 *
 * 전에는 주문품목 상태 맵이 화면마다 3벌(계약·제작·고객 상세) 복제돼 같은 상태가
 * 다른 이름·다른 색으로 보였고, 진행 흐름 순서(ITEM_STATUS_FLOW)도 손 복사 사본이
 * 2벌 있었다. 이 파일 하나로 모은다 (2026-08-05).
 *
 * 조회는 반드시 `metaOf()`(shared/status-meta)를 쓴다 — 미등록 코드가 와도 죽지 않는다.
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { request } from './client';
import type { StatusMeta } from '../shared/status-meta';

// ---------------------------------------------------------------------------
// 공유 가변 맵 (하이드레이션 전 폴백 — 서버 카탈로그와 같은 값)
// ---------------------------------------------------------------------------

/** 계약 흐름: 작성중 → 서명완료 → 계약완료 → (수정하기로) 작성중 … / 취소는 종결 (0731). */
export const CONTRACT_STATUS_META: Record<string, StatusMeta> = {
  DRAFT: { label: '작성중', color: 'gold' },
  SIGNED: { label: '서명완료', color: 'geekblue' },
  COMPLETED: { label: '계약완료', color: 'blue' },
  CANCELLED: { label: '취소', color: 'red' },
};

export const CONTRACT_VERSION_STATUS_META: Record<string, StatusMeta> = {
  DRAFT: { label: '작성중', color: 'gold' },
  CONFIRMED: { label: '적용', color: 'green' },
  SUPERSEDED: { label: '이전 버전', color: 'default' },
};

/** 주문 헤더 — 실제로 쓰는 값은 생성·취소. 진행 상태는 품목(ORDER_ITEM_STATUS_META) 담당. */
export const ORDER_STATUS_META: Record<string, StatusMeta> = {
  CREATED: { label: '생성', color: 'default' },
  COMPLETED: { label: '완료', color: 'green' },
  CANCELLED: { label: '취소', color: 'red' },
};

export const ORDER_ITEM_STATUS_META: Record<string, StatusMeta> = {
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

export const COMPONENT_STATUS_META: Record<string, StatusMeta> = {
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

/** 옵션·렌탈 선택 세션 (스타일 컨설팅) 진행 상태. */
export const OPTION_STATUS_META: Record<string, StatusMeta> = {
  NOT_STARTED: { label: '미시작', color: 'default' },
  IN_PROGRESS: { label: '진행중', color: 'blue' },
  REVIEW: { label: '확인대기', color: 'orange' },
  CONFIRMED: { label: '확정', color: 'green' },
};

/** 작업지시서 목록 판정 (백엔드 resolveWorkOrderStatus 계산값). */
export const WORK_ORDER_STATUS_META: Record<string, StatusMeta> = {
  WAITING: { label: '준비 미완', color: 'default' },
  UNORDERED: { label: '미주문', color: 'red' },
  CURRENT: { label: '최신', color: 'green' },
};

/** 채촌 구분 (measurementType) — 채촌을 하게 된 업무 단계로 표기한다. */
export const MEASUREMENT_TYPE_META: Record<string, StatusMeta> = {
  INITIAL: { label: '스타일 컨설팅', color: 'blue' },
  FITTING: { label: '가봉', color: 'purple' },
  REMEASURE: { label: '수선', color: 'orange' },
  OTHER: { label: '기타', color: 'default' },
};

// ---------------------------------------------------------------------------
// 흐름 순서 (공유 가변 배열) — 진행률·완료 판정용
// ---------------------------------------------------------------------------

/** 품목 제작 흐름 순서 (백엔드 ITEM_STATUS_FLOW). 하이드레이션으로 서버 순서를 따른다. */
export const ITEM_STATUS_FLOW: string[] = [
  'CREATED',
  'OPTION_PENDING',
  'MEASUREMENT_PENDING',
  'READY_TO_ORDER',
  'PRODUCTION_REQUESTED',
  'PRODUCTION_IN_PROGRESS',
  'BASTING_RECEIVED',
  'FITTING_COMPLETED',
  'PRODUCTION_COMPLETED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'PARTIALLY_RELEASED',
  'RELEASED',
];

/** 흐름 순위 맵 — ITEM_STATUS_FLOW에서 파생한다(손 복사 금지). 흐름 밖 상태는 undefined. */
export const ITEM_STATUS_RANK: Record<string, number> = {};

function rebuildItemRank(): void {
  Object.keys(ITEM_STATUS_RANK).forEach((k) => delete ITEM_STATUS_RANK[k]);
  ITEM_STATUS_FLOW.forEach((code, i) => {
    ITEM_STATUS_RANK[code] = i;
  });
}
rebuildItemRank();

// ---------------------------------------------------------------------------
// 하이드레이션
// ---------------------------------------------------------------------------

const DOMAIN_MAPS: Record<string, Record<string, StatusMeta>> = {
  contract: CONTRACT_STATUS_META,
  'contract-version': CONTRACT_VERSION_STATUS_META,
  order: ORDER_STATUS_META,
  'order-item': ORDER_ITEM_STATUS_META,
  component: COMPONENT_STATUS_META,
  'option-session': OPTION_STATUS_META,
  'work-order': WORK_ORDER_STATUS_META,
  'measurement-type': MEASUREMENT_TYPE_META,
};

export interface StatusCatalogEntry {
  code: string;
  label: string;
  color: string;
}

export interface StatusCatalogResponse {
  statuses: Record<string, StatusCatalogEntry[]>;
  flows: { orderItem: string[]; component: string[] };
}

/** 서버 사전을 공유 객체에 in-place 반영한다. 서버에서 사라진 코드는 맵에서 제거한다. */
export function hydrateStatusCatalog(data: StatusCatalogResponse): void {
  Object.entries(DOMAIN_MAPS).forEach(([domain, map]) => {
    const items = data.statuses?.[domain];
    if (!items) return;
    Object.keys(map).forEach((code) => {
      if (!items.some((i) => i.code === code)) delete map[code];
    });
    items.forEach(({ code, label, color }) => {
      map[code] = { label, color };
    });
  });
  if (data.flows?.orderItem?.length) {
    ITEM_STATUS_FLOW.splice(0, Infinity, ...data.flows.orderItem);
    rebuildItemRank();
  }
}

export const STATUS_CATALOG_QUERY_KEY = ['status-catalog'] as const;

/**
 * 앱 진입 시 상태 사전을 받아 공유 맵을 갱신한다(AppLayout 등 상위에서 1회 호출).
 * 상태 정의는 배포 단위로만 바뀌므로 오래 캐시한다.
 */
export function useHydrateStatusCatalog(): void {
  const { data } = useQuery({
    queryKey: STATUS_CATALOG_QUERY_KEY,
    queryFn: () => request<StatusCatalogResponse>({ url: '/status-catalog' }),
    staleTime: 30 * 60 * 1000,
  });
  useEffect(() => {
    if (data) hydrateStatusCatalog(data);
  }, [data]);
}
