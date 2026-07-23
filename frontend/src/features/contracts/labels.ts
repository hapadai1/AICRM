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

export const TRANSACTION_TYPE_TAG_COLOR: Record<TransactionType, string> = {
  CUSTOM: 'blue',
  RENTAL: 'purple',
};

// 품목·구성품 표시명은 중앙(api/code-labels)의 공유 맵을 그대로 쓴다.
// 관리자 표시명 편집이 하이드레이션을 통해 전 화면에 반영되도록 같은 객체 참조를 재노출한다.
export const PRODUCT_CATEGORY_LABEL = PRODUCT_CATEGORY_LABELS as Record<ProductCategory, string>;
export const COMPONENT_TYPE_LABEL = COMPONENT_TYPE_LABELS;

/**
 * 계약 상태 라벨. COMPLETED 는 DB에 실제로 존재하므로 라벨 맵에는 반드시 남긴다.
 * 다만 목록 필터로는 보낼 수 없다(백엔드 CONTRACT_STATUSES 미포함 → 400) — api/contracts.ts 의 CONTRACT_FILTER_STATUSES 참고.
 */
export const CONTRACT_STATUS_META: Record<string, StatusMeta> = {
  DRAFT: { label: '작성중', color: 'gold' },
  CONFIRMED: { label: '확정', color: 'green' },
  CHANGED: { label: '변경 확정', color: 'geekblue' },
  CANCELLED: { label: '취소', color: 'red' },
  COMPLETED: { label: '완료', color: 'blue' },
};

export const CONTRACT_VERSION_STATUS_META: Record<string, StatusMeta> = {
  DRAFT: { label: '변경 초안', color: 'gold' },
  CONFIRMED: { label: '확정', color: 'green' },
  SUPERSEDED: { label: '이전 버전', color: 'default' },
};

export const ORDER_STATUS_META: Record<string, StatusMeta> = {
  CREATED: { label: '생성', color: 'default' },
  IN_PROGRESS: { label: '진행중', color: 'blue' },
  COMPLETED: { label: '완료', color: 'green' },
  CANCELLED: { label: '취소', color: 'red' },
};

export const ORDER_ITEM_STATUS_META: Record<string, StatusMeta> = {
  CREATED: { label: '생성', color: 'default' },
  OPTION_PENDING: { label: '옵션 대기', color: 'gold' },
  MEASUREMENT_PENDING: { label: '채촌 대기', color: 'gold' },
  READY_TO_ORDER: { label: '발주 가능(미주문)', color: 'orange' },
  PRODUCTION_REQUESTED: { label: '제작 요청', color: 'blue' },
  PRODUCTION_IN_PROGRESS: { label: '제작중', color: 'blue' },
  PARTIALLY_RECEIVED: { label: '부분 입고', color: 'cyan' },
  RECEIVED: { label: '입고 완료', color: 'green' },
  RELEASED: { label: '출고', color: 'green' },
  COMPLETED: { label: '완료', color: 'green' },
  CANCELLED: { label: '취소', color: 'red' },
};

export const OPTION_STATUS_META: Record<string, StatusMeta> = {
  NOT_STARTED: { label: '미시작', color: 'default' },
  IN_PROGRESS: { label: '진행중', color: 'blue' },
  REVIEW: { label: '확인대기', color: 'gold' },
  CONFIRMED: { label: '확정', color: 'green' },
};

export const COMPONENT_STATUS_META: Record<string, StatusMeta> = {
  CREATED: { label: '생성', color: 'default' },
  PRODUCTION_REQUESTED: { label: '제작 요청', color: 'blue' },
  PRODUCTION_IN_PROGRESS: { label: '제작중', color: 'blue' },
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
