import type { StatsGranularity } from '../../api/stats';

/** 화면 상단 필터 한 줄이 정하는 조회 구간 — 모든 카드가 이 값을 공유한다. */
export interface StatsRangeState {
  granularity: StatsGranularity;
  from: string;
  to: string;
}
