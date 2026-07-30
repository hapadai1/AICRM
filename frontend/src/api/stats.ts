/** STAT-001 건수 통계 API */
import { request } from './client';

export const STATS_METRICS = [
  'APPOINTMENT',
  'CONTRACT',
  'CONTRACT_ITEM',
  'PRODUCTION_FLOW',
  'REPAIR',
  'RENTAL_FLOW',
  // 매출(금액) 지표 — 응답 valueKind가 AMOUNT로 온다
  'CONTRACT_AMOUNT',
  'CONTRACT_ITEM_AMOUNT',
] as const;
export type StatsMetric = (typeof STATS_METRICS)[number];

export type StatsGranularity = 'DAY' | 'WEEK' | 'MONTH';

export interface StatsSeries {
  key: string;
  label: string;
  /** 색 슬롯 번호. -1은 '기타' 묶음(회색) */
  colorIndex: number;
}

export interface StatsBucket {
  /** 버킷 시작일 YYYY-MM-DD (DAY=그 날, WEEK=월요일, MONTH=1일) */
  period: string;
  /** 축에 그릴 짧은 표기 */
  label: string;
  total: number;
  values: Record<string, number>;
}

export interface StatsCounts {
  metric: StatsMetric;
  granularity: StatsGranularity;
  from: string;
  to: string;
  /** 집계 기준 안내 문구 (서버가 지표별로 채운다) */
  basis: string;
  /** COUNT=건수, AMOUNT=금액(원) */
  valueKind: 'COUNT' | 'AMOUNT';
  series: StatsSeries[];
  buckets: StatsBucket[];
  total: number;
  /** 합계에 기여한 원천 행 수 — 금액 지표의 건당 평균 분모 */
  sourceCount: number;
}

export interface StatsCountsParams {
  metric: StatsMetric;
  granularity: StatsGranularity;
  from: string;
  to: string;
  breakdown?: boolean;
}

export function fetchStatsCounts(params: StatsCountsParams): Promise<StatsCounts> {
  return request<StatsCounts>({
    url: '/stats/counts',
    params: { ...params, breakdown: params.breakdown ? 'true' : 'false' },
  });
}

export interface OptionPopularityChoice {
  choiceCode: string;
  choiceName: string;
  count: number;
  /** 해당 단계 확정 건수 중 비율(%) */
  share: number;
  /** 현재 옵션 세트에는 없지만 선택 이력이 있는 선택지 */
  retired: boolean;
}

export interface OptionPopularityStage {
  stageCode: string;
  stageName: string;
  componentGroup: string | null;
  total: number;
  /** 그 단계 선택지 전체 — 많이 선택된 순 */
  choices: OptionPopularityChoice[];
}

export interface OptionPopularity {
  componentType: string;
  from: string;
  to: string;
  basis: string;
  sessionCount: number;
  stages: OptionPopularityStage[];
}

export function fetchOptionPopularity(params: {
  componentType: string;
  from: string;
  to: string;
}): Promise<OptionPopularity> {
  return request<OptionPopularity>({ url: '/stats/option-popularity', params });
}

export interface RentalPopularityRow {
  rentalSkuId: string;
  componentType: string;
  color: string;
  size: string;
  count: number;
  share: number;
}

export interface RentalPopularity {
  from: string;
  to: string;
  componentType: string | null;
  basis: string;
  total: number;
  rows: RentalPopularityRow[];
  omittedSkus: number;
}

export function fetchRentalPopularity(params: {
  from: string;
  to: string;
  componentType?: string;
  limit?: number;
}): Promise<RentalPopularity> {
  return request<RentalPopularity>({ url: '/stats/rental-popularity', params });
}
