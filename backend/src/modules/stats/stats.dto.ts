import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { codesOf } from '../admin-master/code-labels.constants';

/**
 * 통계 지표. 집계 기준일은 "업무 발생일"이다(등록일 created_at 아님) —
 * 현업이 달력에서 세는 날짜와 통계가 어긋나지 않게 하려는 결정이다.
 *
 * | 지표                 | 단위 | 기준 컬럼                                            |
 * |----------------------|------|------------------------------------------------------|
 * | APPOINTMENT          | 건   | appointments.scheduled_start (취소 제외)             |
 * | CONTRACT             | 건   | contracts.contracted_at                              |
 * | CONTRACT_ITEM        | 건   | 계약확정일 기준, 현재 버전 계약줄 수량 합             |
 * | PRODUCTION_FLOW      | 건   | order_item_components.actual_inbound/outbound_at     |
 * | REPAIR               | 건   | repair_requests.request_date                          |
 * | RENTAL_FLOW          | 건   | rental_allocations.actual_pickup_at/actual_return_at |
 * | CONTRACT_AMOUNT      | 원   | 계약확정일 기준, 현재 버전 total_amount               |
 * | CONTRACT_ITEM_AMOUNT | 원   | 계약확정일 기준, 계약줄 line_amount + 옵션 추가금액    |
 *
 * 매출 원천이 계약 금액인 이유: 이 거래는 전부 일시불이라 계약금·잔금을 나누지 않고
 * (v2 확정 2026-07-28) 별도 결제 테이블도 없다. 확정된 계약 금액이 곧 매출이다.
 *
 * [주의] total_amount는 수기 입력값이고 옵션 확정 시 추가금액만큼 increment된다
 * (option-sessions.service). 즉 `total_amount = Σ line_amount`를 시스템이 보장하지 않는다.
 * 그래서 CONTRACT_ITEM_AMOUNT는 계약줄 금액에 옵션 추가금액을 '옵션' 항목으로 더해 주지만,
 * 그 합이 CONTRACT_AMOUNT와 반드시 같지는 않다(수기 입력 불일치가 남을 수 있다).
 */
export const STATS_METRICS = [
  'APPOINTMENT',
  'CONTRACT',
  'CONTRACT_ITEM',
  'PRODUCTION_FLOW',
  'REPAIR',
  'RENTAL_FLOW',
  'CONTRACT_AMOUNT',
  'CONTRACT_ITEM_AMOUNT',
] as const;
export type StatsMetric = (typeof STATS_METRICS)[number];

/** 금액 지표 — 응답 valueKind가 AMOUNT가 되고 화면은 원 단위로 표기한다. */
const AMOUNT_METRICS: readonly StatsMetric[] = ['CONTRACT_AMOUNT', 'CONTRACT_ITEM_AMOUNT'];

/** 품목별 매출에서 옵션 추가금액을 담는 계열 키 (품목 코드와 겹치지 않게 접두사를 둔다) */
export const OPTION_AMOUNT_KEY = '__OPTION__';

export function isAmountMetric(metric: StatsMetric): boolean {
  return AMOUNT_METRICS.includes(metric);
}

export const STATS_GRANULARITIES = ['DAY', 'WEEK', 'MONTH'] as const;
export type StatsGranularity = (typeof STATS_GRANULARITIES)[number];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class StatsCountsQueryDto {
  @IsIn(STATS_METRICS as unknown as string[])
  metric: StatsMetric;

  @IsIn(STATS_GRANULARITIES as unknown as string[])
  granularity: StatsGranularity;

  /** 집계 시작일(포함) */
  @Matches(DATE_RE, { message: 'from은 YYYY-MM-DD 형식이어야 합니다.' })
  from: string;

  /** 집계 종료일(포함) */
  @Matches(DATE_RE, { message: 'to는 YYYY-MM-DD 형식이어야 합니다.' })
  to: string;

  /**
   * 구분별 분해 여부. false면 합계 1계열만 반환한다.
   * PRODUCTION_FLOW·RENTAL_FLOW는 계열이 입고/출고처럼 고정이라 이 값과 무관하다.
   */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  breakdown?: boolean;
}

export class OptionPopularityQueryDto {
  /** 구성품 (JACKET | TROUSERS | VEST | SHIRT | SHOES) — 상의·하의·베스트·셔츠·구두 */
  @IsIn(codesOf('component-type'))
  componentType: string;

  @Matches(DATE_RE, { message: 'from은 YYYY-MM-DD 형식이어야 합니다.' })
  from: string;

  @Matches(DATE_RE, { message: 'to는 YYYY-MM-DD 형식이어야 합니다.' })
  to: string;
}

export class RentalPopularityQueryDto {
  @Matches(DATE_RE, { message: 'from은 YYYY-MM-DD 형식이어야 합니다.' })
  from: string;

  @Matches(DATE_RE, { message: 'to는 YYYY-MM-DD 형식이어야 합니다.' })
  to: string;

  /** 구성품으로 좁혀 보기 (미지정 시 전 구성품) */
  @IsOptional()
  @IsIn(codesOf('component-type'))
  componentType?: string;

  /** 상위 몇 개까지 반환할지 (기본 5) */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

/** 계열(색 슬롯 대상) 1개. colorIndex -1은 '기타' 묶음이며 화면에서 회색으로 그린다. */
export interface StatsSeries {
  key: string;
  label: string;
  colorIndex: number;
}

/** 기간 버킷 1개. values는 계열 key별 건수(0 포함). */
export interface StatsBucket {
  /** 버킷 시작일 (DAY=그 날, WEEK=월요일, MONTH=1일) */
  period: string;
  /** 축에 그릴 짧은 표기 */
  label: string;
  total: number;
  values: Record<string, number>;
}

export interface StatsCountsResult {
  metric: StatsMetric;
  granularity: StatsGranularity;
  from: string;
  to: string;
  /** 집계 기준 컬럼 안내 문구 — 화면 하단에 그대로 노출한다 */
  basis: string;
  /** COUNT=건수, AMOUNT=금액(원). 화면 축·툴팁 표기를 이 값으로 가른다. */
  valueKind: 'COUNT' | 'AMOUNT';
  series: StatsSeries[];
  buckets: StatsBucket[];
  total: number;
  /**
   * 이 합계에 기여한 원천 행 수 (계약 N건 / 계약줄 N줄 / 옵션 세션 N건).
   * 금액 지표에서 건당 평균을 내는 데 쓴다.
   * 수량을 합치는 CONTRACT_ITEM처럼 total과 다를 수 있다(줄 수 vs 수량 합).
   */
  sourceCount: number;
}

export interface OptionPopularityChoice {
  choiceCode: string;
  choiceName: string;
  count: number;
  /** 이 단계 전체 확정 건수 중 비율(0~100, 소수 1자리) */
  share: number;
  /** 현재 옵션 세트에는 없지만 기간 안에 선택된 이력이 있는 선택지 (지난 버전 잔재) */
  retired: boolean;
}

export interface OptionPopularityStage {
  stageCode: string;
  stageName: string;
  componentGroup: string | null;
  /** 이 단계에서 선택이 확정된 총 건수 */
  total: number;
  /** 그 단계의 선택지 전체. 많이 선택된 순 → 같은 건수면 선택지 코드 순. */
  choices: OptionPopularityChoice[];
}

export interface OptionPopularityResult {
  componentType: string;
  from: string;
  to: string;
  basis: string;
  /** 기간 안에 옵션이 확정된 주문 품목 건수 */
  sessionCount: number;
  stages: OptionPopularityStage[];
}

export interface RentalPopularityRow {
  rentalSkuId: string;
  componentType: string;
  color: string;
  size: string;
  count: number;
  /** 기간 전체 출고 건수 중 비율(0~100, 소수 1자리) */
  share: number;
}

export interface RentalPopularityResult {
  from: string;
  to: string;
  componentType: string | null;
  basis: string;
  /** 기간 안 렌탈 출고 총 건수 (상위 N개 밖까지 포함) */
  total: number;
  rows: RentalPopularityRow[];
  /** 상위 N개에 들지 못한 SKU 종류 수 */
  omittedSkus: number;
}
