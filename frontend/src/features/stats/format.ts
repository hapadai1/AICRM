import type { StatsCounts } from '../../api/stats';

/**
 * 통계 값 표기 (STAT-001).
 *
 * 건수와 금액은 같은 차트 껍데기를 쓰지만 읽는 방식이 다르다.
 * 금액은 자릿수가 커서 축에 원 단위 전체를 적으면 축 라벨이 차트를 밀어낸다 —
 * 축은 만·억으로 줄이고, 툴팁·표에서는 원 단위 전체를 보여 준다.
 */

const MAN = 10_000;
const EOK = 100_000_000;

/** 소수점 뒤 불필요한 0을 지운다 (1.0만 → 1만) */
function trim(value: number, digits: number): string {
  return Number(value.toFixed(digits)).toLocaleString('ko-KR');
}

/** 축·헤드라인용 축약 금액 — 1,234만 / 2.5억 */
export function formatAmountShort(value: number): string {
  if (value === 0) return '0';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= EOK) return `${sign}${trim(abs / EOK, 1)}억`;
  if (abs >= MAN) return `${sign}${trim(abs / MAN, abs >= 10 * MAN ? 0 : 1)}만`;
  return `${sign}${abs.toLocaleString('ko-KR')}`;
}

/** 툴팁·표용 전체 금액 — 12,340,000원 */
export function formatAmountFull(value: number): string {
  return `${Math.round(value).toLocaleString('ko-KR')}원`;
}

export function formatCount(value: number): string {
  return `${value.toLocaleString('ko-KR')}건`;
}

/** 축 눈금 표기 */
export function formatAxis(value: number, kind: StatsCounts['valueKind']): string {
  return kind === 'AMOUNT' ? formatAmountShort(value) : value.toLocaleString('ko-KR');
}

/** 툴팁·표의 값 표기 (단위 포함) */
export function formatValue(value: number, kind: StatsCounts['valueKind']): string {
  return kind === 'AMOUNT' ? formatAmountFull(value) : formatCount(value);
}

/** 카드 우상단 헤드라인 — 금액은 축약해 자리를 아낀다 */
export function formatHeadline(value: number, kind: StatsCounts['valueKind']): string {
  return kind === 'AMOUNT' ? `${formatAmountShort(value)}원` : formatCount(value);
}
