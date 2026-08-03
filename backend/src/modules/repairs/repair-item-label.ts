import { defaultLabelsOf } from '../admin-master/code-labels.constants';

/**
 * 수선 대상 품목 라벨 (component-type). 기준정보 상수의 기본 표시명을 쓴다 —
 * 관리자 오버라이드는 반영하지 않는다(조회마다 master_code_labels를 읽지 않기 위함).
 */
const REPAIR_TARGET_PRODUCT_LABELS = defaultLabelsOf('component-type');

/**
 * 수선 대상 표기: `상의 1 · 하의 2`.
 * 줄이 없으면 undefined — 부르는 쪽이 예전 방식(주문 품목·구성품 연결) 라벨로 폴백한다.
 */
export function repairItemsLabel(
  items: { targetProduct: string; quantity: number }[],
): string | undefined {
  if (!items.length) return undefined;
  return items
    .map((i) => `${REPAIR_TARGET_PRODUCT_LABELS[i.targetProduct] ?? i.targetProduct} ${i.quantity}`)
    .join(' · ');
}
