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
 * 상태 메타의 정본은 중앙 사전(api/status-catalog)이다 — 화면마다 사본이 어긋나던 것을
 * 한곳으로 모았다(2026-08-05). 기존 소비처의 import 경로를 지키기 위해 재노출한다.
 */
export {
  CONTRACT_STATUS_META,
  CONTRACT_VERSION_STATUS_META,
  ORDER_STATUS_META,
  ORDER_ITEM_STATUS_META,
  COMPONENT_STATUS_META,
} from '../../api/status-catalog';

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
