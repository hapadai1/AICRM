/**
 * 건수 통계 차트 카드 (STAT-001).
 *
 * 카드 하나가 지표 하나를 그린다. 기간·단위·분해 여부는 화면 상단 필터 한 줄에서
 * 모든 카드에 동시에 적용되므로 카드 안에는 필터를 두지 않는다.
 *
 * 표시 규칙(색 하나로 뜻을 전달하지 않기):
 *  - 계열이 2개 이상이면 범례를 항상 그린다.
 *  - [표] 보기로 같은 값을 숫자로 읽을 수 있다.
 */
import { useQuery } from '@tanstack/react-query';
import { Alert, Empty, Segmented, Space, Spin, Table, Typography } from 'antd';
import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchStatsCounts, type StatsCounts, type StatsMetric } from '../../api/stats';
import { PageCard } from '../../shared/PageShell';
import { CHART_CHROME, seriesColor } from './chart-palette';
import { ChartLegend, ChartTooltip } from './chart-parts';
import { formatAmountShort, formatAxis, formatCount, formatHeadline, formatValue } from './format';
import { formatPeriod } from './period';
import type { StatsRangeState } from './stats-range';

/** 차트 그림 형태 — 누적 기둥(구성 비교)과 선(추이 비교) */
export type ChartForm = 'BAR' | 'LINE';

interface CountChartCardProps {
  title: string;
  /** 카드 제목 아래 한 줄 설명 — 이 지표가 무엇을 세는지 */
  hint?: string;
  metric: StatsMetric;
  range: StatsRangeState;
  form: ChartForm;
  /** true면 구분별로 쪼개 그린다. 입출고·렌탈처럼 계열이 고정된 지표는 서버가 이 값을 무시한다. */
  breakdown: boolean;
}

const CHART_HEIGHT = 240;
/** 점을 하나하나 찍으면 지저분해지는 구간 — 이보다 칸이 많으면 점을 숨기고 호버로만 본다. */
const DOT_LIMIT = 16;

/** recharts가 먹는 행 형태로 변환 — 계열 key를 그대로 필드명으로 쓴다. */
function toChartRows(data: StatsCounts) {
  return data.buckets.map((b) => ({
    period: b.period,
    label: b.label,
    total: b.total,
    ...b.values,
  }));
}

export function CountChartCard({ title, hint, metric, range, form, breakdown }: CountChartCardProps) {
  const [view, setView] = useState<'CHART' | 'TABLE'>('CHART');

  const query = useQuery({
    queryKey: ['stats', 'counts', metric, range.granularity, range.from, range.to, breakdown],
    queryFn: () =>
      fetchStatsCounts({
        metric,
        granularity: range.granularity,
        from: range.from,
        to: range.to,
        breakdown,
      }),
    // 기간을 바꿀 때 스켈레톤이 번쩍이지 않게 이전 결과를 흐리게 유지한다.
    placeholderData: (prev) => prev,
  });

  const data = query.data;
  const rows = useMemo(() => (data ? toChartRows(data) : []), [data]);
  const series = data?.series ?? [];
  const showLegend = series.length >= 2;
  const showDots = rows.length <= DOT_LIMIT;
  const valueKind = data?.valueKind ?? 'COUNT';

  /** 금액 지표는 합계만으로 감이 안 온다 — 기여 건수와 건당 평균을 함께 적는다. */
  const amountSubStat =
    data && data.valueKind === 'AMOUNT' && data.sourceCount > 0
      ? `${formatCount(data.sourceCount)} · 건당 평균 ${formatAmountShort(
          data.total / data.sourceCount,
        )}원`
      : null;

  const tableColumns = useMemo(
    () => [
      {
        title: '기간',
        dataIndex: 'period',
        key: 'period',
        width: 190,
        render: (period: string) => formatPeriod(period, range.granularity),
      },
      // 열을 위아래로 훑어 읽는 숫자라 자릿수 폭을 고정한다.
      ...series.map((s) => ({
        title: s.label,
        dataIndex: s.key,
        key: s.key,
        align: 'right' as const,
        render: (value: number) => (
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatValue(value ?? 0, valueKind)}
          </span>
        ),
      })),
      ...(series.length >= 2
        ? [
            {
              title: '합계',
              dataIndex: 'total',
              key: 'total',
              align: 'right' as const,
              render: (value: number) => (
                <Typography.Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {formatValue(value, valueKind)}
                </Typography.Text>
              ),
            },
          ]
        : []),
    ],
    [series, range.granularity, valueKind],
  );

  const axisProps = {
    stroke: CHART_CHROME.axis,
    tick: { fill: CHART_CHROME.axisLabel, fontSize: 12 },
  };

  const tooltip = (
    <Tooltip
      // 호버 강조는 값과 헷갈리지 않게 아주 옅게만 깐다.
      cursor={{ fill: 'rgba(11,11,11,0.04)', stroke: CHART_CHROME.grid }}
      content={
        <ChartTooltip
          formatLabel={(period) => formatPeriod(period, range.granularity)}
          formatValue={(value) => formatValue(value, valueKind)}
          showTotal={series.length >= 2}
        />
      }
    />
  );

  return (
    <PageCard
      title={title}
      extra={
        <Space size={8}>
          <Typography.Text strong>총 {formatHeadline(data?.total ?? 0, valueKind)}</Typography.Text>
          <Segmented
            size="small"
            value={view}
            onChange={(v) => setView(v as 'CHART' | 'TABLE')}
            options={[
              { label: '차트', value: 'CHART' },
              { label: '표', value: 'TABLE' },
            ]}
          />
        </Space>
      }
    >
      {(hint || amountSubStat) && (
        <Typography.Paragraph type="secondary" style={{ marginTop: -4, marginBottom: 12, fontSize: 12 }}>
          {amountSubStat && (
            <>
              <Typography.Text style={{ fontSize: 12 }}>{amountSubStat}</Typography.Text>
              <br />
            </>
          )}
          {hint}
        </Typography.Paragraph>
      )}

      {query.isError ? (
        <Alert
          type="error"
          showIcon
          message="통계를 불러오지 못했습니다."
          description={(query.error as Error)?.message}
        />
      ) : !data ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      ) : data.total === 0 ? (
        <Empty description="이 기간에 해당하는 건이 없습니다." />
      ) : (
        <div style={{ opacity: query.isFetching ? 0.55 : 1, transition: 'opacity 120ms' }}>
          {view === 'TABLE' ? (
            <Table
              size="small"
              rowKey="period"
              columns={tableColumns}
              dataSource={rows}
              pagination={false}
              scroll={{ x: 'max-content', y: 320 }}
            />
          ) : (
            <>
              <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
                {form === 'BAR' ? (
                  <BarChart data={rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid stroke={CHART_CHROME.grid} vertical={false} />
                    <XAxis dataKey="label" interval="preserveStartEnd" {...axisProps} />
                    <YAxis
                      allowDecimals={false}
                      width={valueKind === 'AMOUNT' ? 64 : 44}
                      tickFormatter={(value: number) => formatAxis(value, valueKind)}
                      {...axisProps}
                    />
                    {tooltip}
                    {series.map((s, i) => (
                      <Bar
                        key={s.key}
                        dataKey={s.key}
                        name={s.label}
                        stackId="a"
                        fill={seriesColor(s.colorIndex)}
                        // 누적 조각 사이를 카드 배경색으로 갈라 테두리 없이 틈을 만든다.
                        stroke="#ffffff"
                        strokeWidth={series.length > 1 ? 2 : 0}
                        maxBarSize={28}
                        // 기둥 맨 위 조각만 끝을 둥글린다.
                        radius={i === series.length - 1 ? [4, 4, 0, 0] : undefined}
                      />
                    ))}
                  </BarChart>
                ) : (
                  <LineChart data={rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid stroke={CHART_CHROME.grid} vertical={false} />
                    <XAxis dataKey="label" interval="preserveStartEnd" {...axisProps} />
                    <YAxis
                      allowDecimals={false}
                      width={valueKind === 'AMOUNT' ? 64 : 44}
                      tickFormatter={(value: number) => formatAxis(value, valueKind)}
                      {...axisProps}
                    />
                    {tooltip}
                    {series.map((s) => (
                      <Line
                        key={s.key}
                        // 건수는 띄어 세는 값이라 곡선으로 이으면 없는 값이 생긴다(0 아래로 휘는 등).
                        type="linear"
                        dataKey={s.key}
                        name={s.label}
                        stroke={seriesColor(s.colorIndex)}
                        strokeWidth={2}
                        dot={showDots ? { r: 4, strokeWidth: 0 } : false}
                        activeDot={{ r: 5, stroke: '#ffffff', strokeWidth: 2 }}
                      />
                    ))}
                  </LineChart>
                )}
              </ResponsiveContainer>
              {showLegend && <ChartLegend series={series} form={form} />}
            </>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {data.basis}
          </Typography.Text>
        </div>
      )}
    </PageCard>
  );
}
