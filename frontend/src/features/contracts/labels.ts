import { COMPONENT_TYPE_LABELS, PRODUCT_CATEGORY_LABELS } from '../../api/code-labels';
import type { ProductCategory, TransactionType } from '../../api/contracts';
import { formatKrw as formatKrwShared } from '../../api/transform';
import { metaOf as metaOfShared, type StatusMeta } from '../../shared/status-meta';

/** 계약·주문 화면 공통 라벨·상태 메타 (상태는 텍스트+색상 병기 — 문서 03 §3.1) */

export type { StatusMeta };

export const TRANSACTION_TYPE_LABEL: Record<TransactionType, string> = {
  CUSTOM: '맞춤',
  RENTAL: '렌탈',
};

/**
 * 품목 표시 순서: 맞춤(정장>셔츠>구두) → 렌탈(정장>셔츠>구두).
 * 계약 구분 관리 표시·저장과 계약서 작성 시 기본 품목 채우기에서 함께 쓴다.
 */
const TRANSACTION_ORDER: Record<string, number> = { CUSTOM: 0, RENTAL: 1 };
const CATEGORY_ORDER: Record<string, number> = { SUIT: 0, SHIRT: 1, SHOES: 2 };

export function sortByCatalogOrder<T extends { transactionType: string; productCategory: string }>(
  lines: readonly T[],
): T[] {
  return [...lines].sort(
    (a, b) =>
      (TRANSACTION_ORDER[a.transactionType] ?? 99) - (TRANSACTION_ORDER[b.transactionType] ?? 99) ||
      (CATEGORY_ORDER[a.productCategory] ?? 99) - (CATEGORY_ORDER[b.productCategory] ?? 99),
  );
}

export const TRANSACTION_TYPE_TAG_COLOR: Record<TransactionType, string> = {
  CUSTOM: 'blue',
  RENTAL: 'purple',
};

// 품목·구성품 표시명은 중앙(api/code-labels)의 공유 맵을 그대로 쓴다.
// 관리자 표시명 편집이 하이드레이션을 통해 전 화면에 반영되도록 같은 객체 참조를 재노출한다.
export const PRODUCT_CATEGORY_LABEL = PRODUCT_CATEGORY_LABELS as Record<ProductCategory, string>;
export const COMPONENT_TYPE_LABEL = COMPONENT_TYPE_LABELS;

/**
 * 계약 상태 라벨 (현업 확정 2026-07-30).
 * 흐름: 작성중(수정·컨설팅) → 서명완료 → 계약완료 → 수정하기(버전업) → 작성중 … 반복.
 * 취소는 작성중에서만.
 */
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

/**
 * 주문 헤더 상태 — 실제로 쓰이는 값은 생성·취소 둘뿐이다 (현업 확정 2026-07-31).
 * 진행 상태는 품목(ORDER_ITEM_STATUS_META)이 담당한다.
 */
export const ORDER_STATUS_META: Record<string, StatusMeta> = {
  CREATED: { label: '생성', color: 'default' },
  CANCELLED: { label: '취소', color: 'red' },
};

export const ORDER_ITEM_STATUS_META: Record<string, StatusMeta> = {
  CREATED: { label: '생성', color: 'default' },
  OPTION_PENDING: { label: '옵션 대기', color: 'gold' },
  MEASUREMENT_PENDING: { label: '채촌 대기', color: 'gold' },
  READY_TO_ORDER: { label: '발주 가능(미주문)', color: 'orange' },
  PRODUCTION_REQUESTED: { label: '제작 요청', color: 'blue' },
  PRODUCTION_IN_PROGRESS: { label: '제작중', color: 'blue' },
  BASTING_RECEIVED: { label: '가봉 입고', color: 'geekblue' },
  FITTING_COMPLETED: { label: '가봉 완료', color: 'geekblue' },
  PRODUCTION_COMPLETED: { label: '제작 완료', color: 'cyan' },
  PARTIALLY_RECEIVED: { label: '부분 입고', color: 'cyan' },
  RECEIVED: { label: '입고 완료', color: 'green' },
  PARTIALLY_RELEASED: { label: '부분 출고', color: 'green' },
  RELEASED: { label: '출고', color: 'green' },
  COMPLETED: { label: '완료', color: 'green' },
  CANCELLED: { label: '취소', color: 'red' },
};

export const COMPONENT_STATUS_META: Record<string, StatusMeta> = {
  CREATED: { label: '생성', color: 'default' },
  PRODUCTION_REQUESTED: { label: '제작 요청', color: 'blue' },
  PRODUCTION_IN_PROGRESS: { label: '제작중', color: 'blue' },
  BASTING_RECEIVED: { label: '가봉 입고', color: 'geekblue' },
  PRODUCTION_COMPLETED: { label: '제작 완료', color: 'cyan' },
  RECEIVED: { label: '입고', color: 'green' },
  RELEASED: { label: '출고', color: 'green' },
  RESERVED: { label: '렌탈 예약', color: 'purple' },
  CHECKED_OUT: { label: '렌탈 출고', color: 'magenta' },
  RETURNED: { label: '반납', color: 'cyan' },
  CANCELLED: { label: '취소', color: 'red' },
};

/** 공용 헬퍼 위임 — 라벨 맵 직접 인덱싱(MAP[code].label) 금지 */
export function metaOf(map: Record<string, StatusMeta>, code: string | undefined | null): StatusMeta {
  return metaOfShared(map, code);
}

/**
 * 원화 표기. 금액은 Decimal 문자열("750000")로 오기 때문에
 * 문자열에 .toLocaleString() 을 부르면 서식이 적용되지 않는다. 공용 구현에 위임한다.
 */
export function formatKrw(value: string | number | undefined | null): string {
  return formatKrwShared(value);
}
