/**
 * 품목 구성 칸 — 계약 목록·스타일 컨설팅 목록·제작 관리 목록이 함께 쓴다.
 *
 * 규칙은 하나다: **내용이 있는 거래구분만 태그와 함께 한 줄씩 낸다.**
 *  - 맞춤만: `[맞춤] 정장 2 · 셔츠 1`
 *  - 렌탈만: `[렌탈] 정장 1 · 구두 1`
 *  - 섞임:  두 줄
 *
 * 예전에는 화면마다 같은 코드를 따로 두어, 렌탈만 있는 계약에서 내용 없는 `맞춤` 태그가
 * 빈 줄로 찍혔다(2026-08-04 현업 지적). 한곳에서 만들어 목록 네 곳이 같은 결과를 쓴다.
 * 맞춤일 때 태그를 감추던 규칙도 없앴다 — 어느 줄이 무엇인지 늘 같은 자리에서 읽히는 편이 낫다.
 */
import { Space, Tag, Typography } from 'antd';
import type { ProductCategory } from '../../api/contracts';
import {
  CATEGORY_ORDER,
  PRODUCT_CATEGORY_LABEL,
  TRANSACTION_TYPE_LABEL,
  TRANSACTION_TYPE_TAG_COLOR,
} from './labels';

type Counts = Partial<Record<string, number>>;

/** 품목 구성 요약 — "정장 2 · 셔츠 1". 카테고리는 항상 정장→셔츠→구두 순. 빈 맵이면 빈 문자열 */
export function itemComposition(counts: Counts): string {
  return Object.keys(counts)
    .filter((c) => (counts[c] ?? 0) > 0)
    .sort((a, b) => (CATEGORY_ORDER[a] ?? 99) - (CATEGORY_ORDER[b] ?? 99))
    .map((c) => `${PRODUCT_CATEGORY_LABEL[c as ProductCategory] ?? c} ${counts[c]}`)
    .join(' · ');
}

interface ItemCompositionCellProps {
  customCounts: Counts;
  rentalCounts: Counts;
}

export function ItemCompositionCell({ customCounts, rentalCounts }: ItemCompositionCellProps) {
  const custom = itemComposition(customCounts);
  const rental = itemComposition(rentalCounts);

  if (!custom && !rental) return <Typography.Text type="secondary">-</Typography.Text>;

  const line = (type: 'CUSTOM' | 'RENTAL', text: string) => (
    <Typography.Text ellipsis>
      <Tag color={TRANSACTION_TYPE_TAG_COLOR[type]}>{TRANSACTION_TYPE_LABEL[type]}</Tag>
      {text}
    </Typography.Text>
  );

  if (!rental) return line('CUSTOM', custom);
  if (!custom) return line('RENTAL', rental);
  return (
    <Space direction="vertical" size={0}>
      {line('CUSTOM', custom)}
      {line('RENTAL', rental)}
    </Space>
  );
}
