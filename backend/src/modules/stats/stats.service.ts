import { Injectable } from '@nestjs/common';
import { BusinessException } from '../../common/business.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { CodeLabelsService } from '../admin-master/code-labels.service';
import {
  isAmountMetric,
  OPTION_AMOUNT_KEY,
  OptionPopularityQueryDto,
  OptionPopularityResult,
  OptionPopularityStage,
  RentalPopularityQueryDto,
  RentalPopularityResult,
  StatsBucket,
  StatsCountsQueryDto,
  StatsCountsResult,
  StatsGranularity,
  StatsSeries,
} from './stats.dto';

/**
 * 색 슬롯 개수 상한. 계열이 이보다 많으면 상위 건수만 남기고 나머지를 '기타'로 묶는다.
 * (예약 목적은 마스터에 10종이 있어 그대로 그리면 색이 서로 구분되지 않는다.)
 */
const MAX_SERIES = 7;
const OTHER_KEY = '__OTHER__';

/** 버킷 개수 상한 — 잘못된 기간으로 수천 칸을 그리지 않게 막는다. */
const MAX_BUCKETS = 400;

/**
 * 구성품 → 옵션 단계를 어디서 찾을지.
 *
 * 옵션 세트는 품목(정장·셔츠·구두) 단위이고, 정장 세트만 부위(componentGroup)로 갈린다.
 * 셔츠·구두 세트는 세트 전체가 그 구성품이라 componentGroup이 비어 있어(null) 따로 받아 준다.
 */
const OPTION_COMPONENT_SCOPE: Record<
  string,
  { productCategories: string[]; componentGroups: (string | null)[] }
> = {
  JACKET: { productCategories: ['SUIT'], componentGroups: ['JACKET'] },
  TROUSERS: { productCategories: ['SUIT'], componentGroups: ['TROUSERS'] },
  VEST: { productCategories: ['SUIT'], componentGroups: ['VEST'] },
  SHIRT: { productCategories: ['SHIRT'], componentGroups: ['SHIRT', null] },
  SHOES: { productCategories: ['SHOES'], componentGroups: ['SHOES', null] },
};

/** 합계 1계열만 그릴 때의 계열 정의 */
const TOTAL_SERIES: StatsSeries = { key: 'TOTAL', label: '합계', colorIndex: 0 };

/** 'YYYY-MM-DD' → 로컬 자정 Date. 형식이 맞아도 실제 날짜가 아니면 null. */
function parseLocalDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function dateKey(y: number, m0: number, d: number): string {
  return `${y}-${String(m0 + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 타임스탬프를 로컬 달력의 연·월·일로 쪼갠다.
 *
 * @db.Date 컬럼(requestDate 등)은 Prisma가 UTC 자정 Date로 돌려주므로 로컬 게터를 쓰면
 * 타임존이 UTC보다 뒤인 곳에서 하루 밀린다. 그래서 컬럼 종류를 받아 게터를 갈라 쓴다.
 */
function partsOf(value: Date, kind: 'DATE' | 'TIMESTAMP'): { y: number; m0: number; d: number } {
  return kind === 'DATE'
    ? { y: value.getUTCFullYear(), m0: value.getUTCMonth(), d: value.getUTCDate() }
    : { y: value.getFullYear(), m0: value.getMonth(), d: value.getDate() };
}

/** 그 날짜가 속한 버킷의 시작일 키 (WEEK은 월요일, MONTH은 1일) */
function bucketKeyOf(value: Date, kind: 'DATE' | 'TIMESTAMP', granularity: StatsGranularity): string {
  const { y, m0, d } = partsOf(value, kind);
  if (granularity === 'MONTH') return dateKey(y, m0, 1);
  if (granularity === 'DAY') return dateKey(y, m0, d);
  // WEEK — 월요일 시작. getDay()는 일요일이 0이라 월요일 기준으로 되돌린다.
  const local = new Date(y, m0, d);
  const offset = (local.getDay() + 6) % 7;
  const monday = addDays(local, -offset);
  return dateKey(monday.getFullYear(), monday.getMonth(), monday.getDate());
}

/** 기간을 덮는 버킷 목록(빈 구간 0으로 채운 축). 라벨은 축에 그릴 짧은 표기다. */
function buildBuckets(from: Date, to: Date, granularity: StatsGranularity): StatsBucket[] {
  const sameYear = from.getFullYear() === to.getFullYear();
  const keys: string[] = [];
  const labels: string[] = [];

  if (granularity === 'MONTH') {
    let cursor = new Date(from.getFullYear(), from.getMonth(), 1);
    while (cursor <= to && keys.length < MAX_BUCKETS) {
      keys.push(dateKey(cursor.getFullYear(), cursor.getMonth(), 1));
      labels.push(
        sameYear
          ? `${cursor.getMonth() + 1}월`
          : `${String(cursor.getFullYear()).slice(2)}.${cursor.getMonth() + 1}`,
      );
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }
  } else {
    const step = granularity === 'WEEK' ? 7 : 1;
    // WEEK은 from이 속한 주의 월요일부터 시작한다.
    let cursor =
      granularity === 'WEEK' ? addDays(from, -((from.getDay() + 6) % 7)) : new Date(from);
    while (cursor <= to && keys.length < MAX_BUCKETS) {
      keys.push(dateKey(cursor.getFullYear(), cursor.getMonth(), cursor.getDate()));
      labels.push(`${cursor.getMonth() + 1}/${cursor.getDate()}`);
      cursor = addDays(cursor, step);
    }
  }

  return keys.map((period, i) => ({ period, label: labels[i], total: 0, values: {} }));
}

/** 계열 후보 1건 — 집계 전 원본 행에서 뽑아낸 (버킷, 계열, 건수) */
interface Tally {
  bucket: string;
  key: string;
  label: string;
  /** 마스터 정렬 순서 — 색 슬롯 배정에 쓴다(건수 순위가 아니라 이 순서를 따른다) */
  order: number;
  count: number;
}

/**
 * 조회 구간. timestamptz 컬럼과 @db.Date 컬럼의 경계값이 다르다.
 * - timestamptz: 로컬 자정 (대시보드와 같은 기준)
 * - @db.Date: UTC 자정 — Prisma가 보낸 타임스탬프를 Postgres가 date로 캐스팅할 때
 *   로컬 자정을 주면 UTC로 환산되며 하루 밀린다(dashboard.service todayAsDbDate와 같은 이유).
 */
interface StatsRange {
  from: Date;
  to: Date;
  endExclusive: Date;
  dateFrom: Date;
  dateEndExclusive: Date;
}

/** 로컬 자정 Date를 같은 달력일의 UTC 자정 Date로 옮긴다 (@db.Date 비교용). */
function toDbDate(local: Date): Date {
  return new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()));
}

@Injectable()
export class StatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codeLabels: CodeLabelsService,
  ) {}

  /** 기간 검증 후 [시작, 종료 다음날) 구간을 컬럼 종류별로 만든다. */
  private resolveRange(
    query: StatsCountsQueryDto | OptionPopularityQueryDto | RentalPopularityQueryDto,
  ): StatsRange {
    const from = parseLocalDate(query.from);
    const to = parseLocalDate(query.to);
    if (!from)
      throw new BusinessException('VALIDATION_ERROR', '시작일이 올바르지 않습니다.', [
        { field: 'from', reason: 'INVALID' },
      ]);
    if (!to)
      throw new BusinessException('VALIDATION_ERROR', '종료일이 올바르지 않습니다.', [
        { field: 'to', reason: 'INVALID' },
      ]);
    if (from > to)
      throw new BusinessException('VALIDATION_ERROR', '시작일이 종료일보다 늦습니다.', [
        { field: 'from', reason: 'RANGE' },
      ]);
    const endExclusive = addDays(to, 1);
    return {
      from,
      to,
      endExclusive,
      dateFrom: toDbDate(from),
      dateEndExclusive: toDbDate(endExclusive),
    };
  }

  /**
   * 건수·금액 통계. 기간 안의 원본 행을 필요한 컬럼만 읽어 서버에서 버킷으로 접는다.
   * date_trunc SQL을 쓰지 않는 이유는 대시보드와 같은 "로컬 달력" 기준을 유지하기 위해서다
   * (DB 세션 타임존에 따라 하루 밀리는 문제를 없앤다).
   */
  async counts(query: StatsCountsQueryDto): Promise<StatsCountsResult> {
    const range = this.resolveRange(query);
    const buckets = buildBuckets(range.from, range.to, query.granularity);
    if (buckets.length >= MAX_BUCKETS)
      throw new BusinessException(
        'VALIDATION_ERROR',
        `기간이 너무 넓습니다. 단위를 넓게 바꾸거나 기간을 줄여 주세요(최대 ${MAX_BUCKETS}구간).`,
        [{ field: 'to', reason: 'RANGE_TOO_WIDE' }],
      );

    const breakdown = query.breakdown ?? false;
    const amount = isAmountMetric(query.metric);
    const { tallies, fixedSeries, basis } = await this.collect(
      query.metric,
      query.granularity,
      range,
      breakdown,
    );

    const series = fixedSeries ?? this.resolveSeries(tallies, breakdown);
    const seriesKeys = new Set(series.map((s) => s.key));
    const byPeriod = new Map(buckets.map((b) => [b.period, b]));
    for (const s of series) for (const b of buckets) b.values[s.key] = 0;

    let total = 0;
    let sourceCount = 0;
    for (const t of tallies) {
      const bucket = byPeriod.get(t.bucket);
      if (!bucket) continue; // 버킷 상한에 잘린 구간 — 합계에서도 제외한다
      const key = seriesKeys.has(t.key) ? t.key : OTHER_KEY;
      bucket.values[key] = (bucket.values[key] ?? 0) + t.count;
      bucket.total += t.count;
      total += t.count;
      sourceCount += 1;
    }

    // 금액은 원 단위 정수로 맞춘다 — Decimal을 number로 더하는 과정에서 생기는
    // 부동소수 잔여값(…999999)이 화면에 새는 것을 막는다.
    if (amount) {
      for (const bucket of buckets) {
        for (const key of Object.keys(bucket.values)) {
          bucket.values[key] = Math.round(bucket.values[key]);
        }
        bucket.total = Math.round(bucket.total);
      }
      total = Math.round(total);
    }

    return {
      metric: query.metric,
      granularity: query.granularity,
      from: query.from,
      to: query.to,
      basis,
      valueKind: amount ? 'AMOUNT' : 'COUNT',
      series,
      buckets,
      total,
      sourceCount,
    };
  }

  /**
   * 계열 목록을 확정한다.
   * - 분해하지 않으면 합계 1계열.
   * - 계열이 MAX_SERIES를 넘으면 건수 상위만 남기고 나머지를 '기타'로 묶는다.
   * - 색 슬롯은 건수 순위가 아니라 마스터 정렬 순서로 배정한다 — 기간을 바꿔 순위가
   *   뒤집혀도 같은 구분이 같은 색을 유지하게 하려는 것이다.
   */
  private resolveSeries(tallies: Tally[], breakdown: boolean): StatsSeries[] {
    if (!breakdown) return [TOTAL_SERIES];

    const agg = new Map<string, { label: string; order: number; count: number }>();
    for (const t of tallies) {
      const prev = agg.get(t.key);
      if (prev) prev.count += t.count;
      else agg.set(t.key, { label: t.label, order: t.order, count: t.count });
    }
    if (agg.size === 0) return [TOTAL_SERIES];

    const ranked = [...agg.entries()].sort(
      (a, b) => b[1].count - a[1].count || a[1].order - b[1].order,
    );
    const kept = ranked.slice(0, MAX_SERIES).sort((a, b) => a[1].order - b[1].order);
    const series: StatsSeries[] = kept.map(([key, v], i) => ({
      key,
      label: v.label,
      colorIndex: i,
    }));
    if (ranked.length > MAX_SERIES) {
      series.push({ key: OTHER_KEY, label: `기타 ${ranked.length - MAX_SERIES}종`, colorIndex: -1 });
    }
    return series;
  }

  /** 지표별 원본 조회 → (버킷, 계열) 집계 후보 목록 */
  private async collect(
    metric: StatsCountsQueryDto['metric'],
    granularity: StatsGranularity,
    range: StatsRange,
    breakdown: boolean,
  ): Promise<{ tallies: Tally[]; fixedSeries?: StatsSeries[]; basis: string }> {
    const bucketOf = (value: Date, kind: 'DATE' | 'TIMESTAMP') =>
      bucketKeyOf(value, kind, granularity);
    const { from, endExclusive } = range;

    switch (metric) {
      case 'APPOINTMENT': {
        const rows = await this.prisma.appointment.findMany({
          where: {
            scheduledStart: { gte: from, lt: endExclusive },
            status: { not: 'CANCELLED' },
          },
          select: {
            scheduledStart: true,
            purpose: { select: { code: true, name: true, sortOrder: true } },
          },
        });
        return {
          basis: '예약일(방문 예정 시각) 기준 · 취소 예약 제외',
          tallies: rows.map((r) => ({
            bucket: bucketOf(r.scheduledStart, 'TIMESTAMP'),
            key: breakdown ? r.purpose.code : TOTAL_SERIES.key,
            label: r.purpose.name,
            order: r.purpose.sortOrder,
            count: 1,
          })),
        };
      }

      case 'CONTRACT': {
        const rows = await this.prisma.contract.findMany({
          where: {
            contractedAt: { gte: from, lt: endExclusive },
            status: { not: 'CANCELLED' },
          },
          select: {
            contractedAt: true,
            contractType: { select: { code: true, name: true, sortOrder: true } },
          },
        });
        return {
          basis: '계약 확정일 기준 · 취소 계약 제외',
          tallies: rows.map((r) => ({
            // where 조건이 null을 걸러내므로 contractedAt은 존재한다.
            bucket: bucketOf(r.contractedAt as Date, 'TIMESTAMP'),
            key: breakdown ? (r.contractType?.code ?? 'UNSPECIFIED') : TOTAL_SERIES.key,
            label: r.contractType?.name ?? '구분 미지정',
            // 구분 미지정은 마스터에 없으니 항상 뒤로 보낸다.
            order: r.contractType?.sortOrder ?? 9999,
            count: 1,
          })),
        };
      }

      case 'CONTRACT_ITEM': {
        const labels = await this.codeLabels.listAll();
        const categoryOrder = new Map(
          labels['product-category'].map((c, i) => [c.code, { label: c.label, order: i }]),
        );
        const rows = await this.prisma.contract.findMany({
          where: {
            contractedAt: { gte: from, lt: endExclusive },
            status: { not: 'CANCELLED' },
            currentVersionId: { not: null },
          },
          select: {
            contractedAt: true,
            currentVersion: {
              select: { lines: { select: { productCategory: true, quantity: true } } },
            },
          },
        });
        const tallies: Tally[] = [];
        for (const row of rows) {
          const bucket = bucketOf(row.contractedAt as Date, 'TIMESTAMP');
          for (const line of row.currentVersion?.lines ?? []) {
            const meta = categoryOrder.get(line.productCategory);
            tallies.push({
              bucket,
              key: breakdown ? line.productCategory : TOTAL_SERIES.key,
              label: meta?.label ?? line.productCategory,
              order: meta?.order ?? 9999,
              count: line.quantity,
            });
          }
        }
        return { basis: '계약 확정일 기준 · 현재 계약 버전의 품목 수량 합 · 취소 계약 제외', tallies };
      }

      case 'PRODUCTION_FLOW': {
        const [inbound, outbound] = await Promise.all([
          this.prisma.orderItemComponent.findMany({
            where: { actualInboundAt: { gte: from, lt: endExclusive }, active: true },
            select: { actualInboundAt: true },
          }),
          this.prisma.orderItemComponent.findMany({
            where: { actualOutboundAt: { gte: from, lt: endExclusive }, active: true },
            select: { actualOutboundAt: true },
          }),
        ]);
        const tallies: Tally[] = [
          ...inbound.map((r) => ({
            bucket: bucketOf(r.actualInboundAt as Date, 'TIMESTAMP'),
            key: 'INBOUND',
            label: '입고',
            order: 0,
            count: 1,
          })),
          ...outbound.map((r) => ({
            bucket: bucketOf(r.actualOutboundAt as Date, 'TIMESTAMP'),
            key: 'OUTBOUND',
            label: '출고',
            order: 1,
            count: 1,
          })),
        ];
        return {
          basis: '제작 구성품의 실제 입고일·출고일 기준',
          tallies,
          fixedSeries: [
            { key: 'INBOUND', label: '입고', colorIndex: 0 },
            { key: 'OUTBOUND', label: '출고', colorIndex: 1 },
          ],
        };
      }

      case 'REPAIR': {
        const labels = await this.codeLabels.listAll();
        const typeOrder = new Map(
          labels['repair-type'].map((c, i) => [c.code, { label: c.label, order: i }]),
        );
        const rows = await this.prisma.repairRequest.findMany({
          where: {
            // @db.Date — UTC 자정 경계를 쓴다.
            requestDate: { gte: range.dateFrom, lt: range.dateEndExclusive },
            status: { not: 'CANCELLED' },
          },
          select: { requestDate: true, repairType: true },
        });
        return {
          basis: '수선 접수일 기준 · 취소 접수 제외',
          tallies: rows.map((r) => {
            const meta = typeOrder.get(r.repairType);
            return {
              // requestDate는 @db.Date — UTC 자정으로 오므로 UTC 게터로 읽는다.
              bucket: bucketOf(r.requestDate, 'DATE'),
              key: breakdown ? r.repairType : TOTAL_SERIES.key,
              label: meta?.label ?? r.repairType,
              order: meta?.order ?? 9999,
              count: 1,
            };
          }),
        };
      }

      case 'RENTAL_FLOW': {
        const [pickup, returned] = await Promise.all([
          this.prisma.rentalAllocation.findMany({
            where: { actualPickupAt: { gte: from, lt: endExclusive }, status: { not: 'CANCELLED' } },
            select: { actualPickupAt: true },
          }),
          this.prisma.rentalAllocation.findMany({
            where: { actualReturnAt: { gte: from, lt: endExclusive }, status: { not: 'CANCELLED' } },
            select: { actualReturnAt: true },
          }),
        ]);
        const tallies: Tally[] = [
          ...pickup.map((r) => ({
            bucket: bucketOf(r.actualPickupAt as Date, 'TIMESTAMP'),
            key: 'PICKUP',
            label: '출고',
            order: 0,
            count: 1,
          })),
          ...returned.map((r) => ({
            bucket: bucketOf(r.actualReturnAt as Date, 'TIMESTAMP'),
            key: 'RETURN',
            label: '반납',
            order: 1,
            count: 1,
          })),
        ];
        return {
          basis: '렌탈 배정의 실제 출고일·반납일 기준 · 취소 배정 제외',
          tallies,
          fixedSeries: [
            { key: 'PICKUP', label: '출고', colorIndex: 0 },
            { key: 'RETURN', label: '반납', colorIndex: 1 },
          ],
        };
      }

      // ---- 매출(금액) 지표 ----

      case 'CONTRACT_AMOUNT': {
        const rows = await this.prisma.contract.findMany({
          where: {
            contractedAt: { gte: from, lt: endExclusive },
            status: { not: 'CANCELLED' },
            currentVersionId: { not: null },
          },
          select: {
            contractedAt: true,
            contractType: { select: { code: true, name: true, sortOrder: true } },
            currentVersion: { select: { totalAmount: true } },
          },
        });
        return {
          basis: '계약 확정일 기준 · 현재 계약 버전의 총 계약금액 · 취소 계약 제외 · 일시불이라 계약금·잔금 구분 없음',
          tallies: rows.map((r) => ({
            bucket: bucketOf(r.contractedAt as Date, 'TIMESTAMP'),
            key: breakdown ? (r.contractType?.code ?? 'UNSPECIFIED') : TOTAL_SERIES.key,
            label: r.contractType?.name ?? '구분 미지정',
            order: r.contractType?.sortOrder ?? 9999,
            count: Number(r.currentVersion?.totalAmount ?? 0),
          })),
        };
      }

      case 'CONTRACT_ITEM_AMOUNT': {
        const labels = await this.codeLabels.listAll();
        const categoryOrder = new Map(
          labels['product-category'].map((c, i) => [c.code, { label: c.label, order: i }]),
        );
        const rows = await this.prisma.contract.findMany({
          where: {
            contractedAt: { gte: from, lt: endExclusive },
            status: { not: 'CANCELLED' },
            currentVersionId: { not: null },
          },
          select: {
            contractedAt: true,
            currentVersion: {
              select: { lines: { select: { productCategory: true, lineAmount: true } } },
            },
            // 옵션 추가금액은 계약 품목(계약 소유)에 붙은 현재 옵션 세션이 들고 있다.
            items: {
              select: {
                optionSelectionSessions: {
                  where: { isCurrent: true },
                  select: { surchargeApplied: true },
                },
              },
            },
          },
        });
        const tallies: Tally[] = [];
        for (const row of rows) {
          const bucket = bucketOf(row.contractedAt as Date, 'TIMESTAMP');
          for (const line of row.currentVersion?.lines ?? []) {
            const meta = categoryOrder.get(line.productCategory);
            tallies.push({
              bucket,
              key: breakdown ? line.productCategory : TOTAL_SERIES.key,
              label: meta?.label ?? line.productCategory,
              order: meta?.order ?? 9999,
              count: Number(line.lineAmount),
            });
          }
          // 옵션 추가금액은 품목줄 금액에 반영되지 않으므로 별도 '옵션' 항목으로 더한다.
          // 반영 시각(surchargeAppliedAt)이 아니라 계약 확정일 버킷에 넣는다 —
          // 한 카드 안의 모든 계열이 같은 기준일을 써야 쌓아 놓은 기둥이 뜻을 갖는다.
          for (const item of row.items) {
            for (const session of item.optionSelectionSessions) {
              const applied = Number(session.surchargeApplied);
              if (applied === 0) continue;
              tallies.push({
                bucket,
                key: breakdown ? OPTION_AMOUNT_KEY : TOTAL_SERIES.key,
                label: '옵션',
                // 품목 계열 뒤, '기타'보다는 앞에 놓는다.
                order: 9000,
                count: applied,
              });
            }
          }
        }
        return {
          basis:
            '계약 확정일 기준 · 계약줄 금액 + 옵션 추가금액 · 취소 계약 제외 · 계약 총액은 수기 입력값이라 이 합계와 다를 수 있다',
          tallies,
        };
      }
    }
  }

  /**
   * 구성품(상의·하의·베스트·셔츠·구두)별 인기 옵션.
   *
   * 선택지 목록은 "지금 고를 수 있는 것 전부"(활성 버전의 활성 선택지)를 기준으로 만들고
   * 거기에 기간 안 선택 건수를 붙인다 — 아무도 안 고른 선택지가 목록에서 사라지면
   * "인기 없는 선택지"를 알 수 없기 때문이다(0건도 한 줄로 남는다).
   *
   * 확정(confirmedAt)된 세션만 센다 — 임시저장 중인 선택은 고객이 계속 바꾸므로
   * 인기 순위로 볼 값이 아니다.
   */
  async optionPopularity(query: OptionPopularityQueryDto): Promise<OptionPopularityResult> {
    const { from, endExclusive } = this.resolveRange(query);
    const scope = OPTION_COMPONENT_SCOPE[query.componentType];
    if (!scope)
      throw new BusinessException(
        'VALIDATION_ERROR',
        `옵션 단계가 정의되지 않은 구성품입니다: ${query.componentType}`,
        [{ field: 'componentType', reason: 'UNSUPPORTED' }],
      );

    // 1) 선택지 목록의 기준 = 해당 품목 옵션 세트의 활성 버전
    const optionSets = await this.prisma.optionSet.findMany({
      where: { productCategory: { in: scope.productCategories }, activeVersionId: { not: null } },
      select: {
        activeVersion: {
          select: {
            stages: {
              where: { active: true },
              orderBy: { sequenceNo: 'asc' },
              select: {
                stageCode: true,
                stageName: true,
                sequenceNo: true,
                componentGroup: true,
                choices: {
                  where: { active: true },
                  orderBy: { choiceCode: 'asc' },
                  select: { choiceCode: true, choiceName: true },
                },
              },
            },
          },
        },
      },
    });

    interface StageAgg {
      stageCode: string;
      stageName: string;
      componentGroup: string | null;
      sequenceNo: number;
      total: number;
      choices: Map<string, { choiceName: string; count: number; retired: boolean }>;
    }
    const stageMap = new Map<string, StageAgg>();

    for (const optionSet of optionSets) {
      for (const stage of optionSet.activeVersion?.stages ?? []) {
        // 정장은 부위가 갈리고, 셔츠·구두는 세트 전체가 그 구성품이라 componentGroup이 비어 있다.
        if (!scope.componentGroups.includes(stage.componentGroup)) continue;
        stageMap.set(stage.stageCode, {
          stageCode: stage.stageCode,
          stageName: stage.stageName,
          componentGroup: stage.componentGroup ?? query.componentType,
          sequenceNo: stage.sequenceNo,
          total: 0,
          choices: new Map(
            stage.choices.map((c) => [
              c.choiceCode,
              { choiceName: c.choiceName, count: 0, retired: false },
            ]),
          ),
        });
      }
    }

    // 2) 기간 안 확정 선택을 (단계코드, 선택지코드)로 붙인다.
    //    id가 아니라 코드로 맞추는 이유는 지난 옵션 버전에서 고른 건도 같은 줄로 모으기 위해서다.
    const values = await this.prisma.optionSelectionValue.findMany({
      where: {
        selectionSession: {
          confirmedAt: { gte: from, lt: endExclusive },
          isCurrent: true,
          optionSetVersion: { optionSet: { productCategory: { in: scope.productCategories } } },
        },
      },
      select: {
        selectionSessionId: true,
        optionStage: {
          select: { stageCode: true, stageName: true, sequenceNo: true, componentGroup: true },
        },
        optionChoice: { select: { choiceCode: true, choiceName: true } },
      },
    });

    const sessionIds = new Set<string>();
    for (const value of values) {
      const stage = value.optionStage;
      if (!scope.componentGroups.includes(stage.componentGroup)) continue;
      sessionIds.add(value.selectionSessionId);

      let agg = stageMap.get(stage.stageCode);
      if (!agg) {
        // 활성 버전에서 빠진 단계인데 기간 안에 선택 이력이 있다 — 조용히 버리지 않고 뒤에 붙인다.
        agg = {
          stageCode: stage.stageCode,
          stageName: stage.stageName,
          componentGroup: stage.componentGroup ?? query.componentType,
          sequenceNo: stage.sequenceNo + 1000,
          total: 0,
          choices: new Map(),
        };
        stageMap.set(stage.stageCode, agg);
      }
      agg.total += 1;
      const choice = agg.choices.get(value.optionChoice.choiceCode);
      if (choice) choice.count += 1;
      else
        agg.choices.set(value.optionChoice.choiceCode, {
          choiceName: value.optionChoice.choiceName,
          count: 1,
          retired: true,
        });
    }

    const stages: OptionPopularityStage[] = [...stageMap.values()]
      .sort((a, b) => a.sequenceNo - b.sequenceNo)
      .map((agg) => ({
        stageCode: agg.stageCode,
        stageName: agg.stageName,
        componentGroup: agg.componentGroup,
        total: agg.total,
        // 많이 선택된 순 → 같은 건수면 선택지 코드 순(A, B, C…)
        choices: [...agg.choices.entries()]
          .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
          .map(([choiceCode, v]) => ({
            choiceCode,
            choiceName: v.choiceName,
            count: v.count,
            share: agg.total > 0 ? Math.round((v.count / agg.total) * 1000) / 10 : 0,
            retired: v.retired,
          })),
      }));

    return {
      componentType: query.componentType,
      from: query.from,
      to: query.to,
      basis: '옵션 확정일 기준 · 현재 옵션 세션의 확정 선택만 집계 · 선택지는 현재 옵션 세트 전체',
      sessionCount: sessionIds.size,
      stages,
    };
  }

  /**
   * 렌탈 출고 인기 품목. 실제 출고(actualPickupAt)된 배정을 실물의 SKU(구분·컬러·사이즈)로
   * 묶어 많이 나간 순으로 돌려준다.
   *
   * 실물(관리코드) 단위가 아니라 SKU 단위로 세는 이유는, 같은 색·사이즈를 여러 벌 보유하기 때문이다.
   * 실물 단위로 세면 "무엇이 잘 나가는가"가 보유 수량에 흩어져 보이지 않는다.
   */
  async rentalPopularity(query: RentalPopularityQueryDto): Promise<RentalPopularityResult> {
    const { from, endExclusive } = this.resolveRange(query);
    const limit = query.limit ?? 5;

    const rows = await this.prisma.rentalAllocation.findMany({
      where: {
        actualPickupAt: { gte: from, lt: endExclusive },
        status: { not: 'CANCELLED' },
        ...(query.componentType
          ? { rentalInventoryItem: { rentalSku: { componentType: query.componentType } } }
          : {}),
      },
      select: {
        rentalInventoryItem: {
          select: {
            rentalSku: { select: { id: true, componentType: true, color: true, size: true } },
          },
        },
      },
    });

    const agg = new Map<
      string,
      { componentType: string; color: string; size: string; count: number }
    >();
    for (const row of rows) {
      const sku = row.rentalInventoryItem.rentalSku;
      const prev = agg.get(sku.id);
      if (prev) prev.count += 1;
      else
        agg.set(sku.id, {
          componentType: sku.componentType,
          color: sku.color,
          size: sku.size,
          count: 1,
        });
    }

    const total = rows.length;
    const ranked = [...agg.entries()].sort(
      (a, b) =>
        b[1].count - a[1].count ||
        a[1].componentType.localeCompare(b[1].componentType) ||
        a[1].color.localeCompare(b[1].color) ||
        a[1].size.localeCompare(b[1].size),
    );

    return {
      from: query.from,
      to: query.to,
      componentType: query.componentType ?? null,
      basis: '렌탈 배정의 실제 출고일 기준 · 취소 배정 제외 · 실물 SKU(구분·컬러·사이즈)별 집계',
      total,
      rows: ranked.slice(0, limit).map(([rentalSkuId, v]) => ({
        rentalSkuId,
        componentType: v.componentType,
        color: v.color,
        size: v.size,
        count: v.count,
        share: total > 0 ? Math.round((v.count / total) * 1000) / 10 : 0,
      })),
      omittedSkus: Math.max(0, ranked.length - limit),
    };
  }
}
