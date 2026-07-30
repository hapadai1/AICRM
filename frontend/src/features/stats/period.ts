import dayjs from 'dayjs';
import type { StatsGranularity } from '../../api/stats';

/** 버킷 시작일을 사람이 읽는 기간 표기로. 툴팁·표 첫 칸에 쓴다. */
export function formatPeriod(period: string, granularity: StatsGranularity): string {
  const d = dayjs(period);
  if (granularity === 'MONTH') return d.format('YYYY년 M월');
  if (granularity === 'WEEK') return `${d.format('YYYY-MM-DD')} ~ ${d.add(6, 'day').format('MM-DD')}`;
  return d.format('YYYY-MM-DD (ddd)');
}

export const GRANULARITY_LABEL: Record<StatsGranularity, string> = {
  DAY: '일',
  WEEK: '주',
  MONTH: '월',
};

/** 단위별 기본 조회 기간 — 칸 수가 30~36개 정도 되게 잡는다. */
export function defaultRangeOf(granularity: StatsGranularity): { from: string; to: string } {
  const today = dayjs();
  if (granularity === 'MONTH')
    return { from: today.subtract(11, 'month').startOf('month').format('YYYY-MM-DD'), to: today.format('YYYY-MM-DD') };
  if (granularity === 'WEEK') {
    // 서버 주 버킷은 월요일 시작이다. 시작일을 월요일로 맞춰 첫 칸이 반쪽만 집계되는 것을 막는다.
    const base = today.subtract(11, 'week');
    const monday = base.subtract((base.day() + 6) % 7, 'day');
    return { from: monday.format('YYYY-MM-DD'), to: today.format('YYYY-MM-DD') };
  }
  return { from: today.subtract(29, 'day').format('YYYY-MM-DD'), to: today.format('YYYY-MM-DD') };
}
