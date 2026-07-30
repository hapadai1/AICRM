/**
 * 차트 부속품 — 범례와 툴팁 (STAT-001).
 *
 * recharts 기본 범례를 쓰지 않는 이유가 두 가지 있다.
 *  1) 기본 범례는 항목 글자를 계열색으로 칠한다. 옅은 계열색(아쿠아·옐로)은 흰 배경에서
 *     대비가 3:1도 안 되므로 글자는 본문 잉크색으로 두고 색은 앞의 점만 지고 가야 한다.
 *  2) 기본 범례는 항목을 이름순으로 정렬해 기둥의 쌓임 순서와 어긋난다.
 * 그래서 범례는 차트 밖에 직접 그리고 서버가 준 계열 순서를 그대로 따른다.
 */
import { Typography } from 'antd';
import type { StatsSeries } from '../../api/stats';
import { CHART_CHROME, seriesColor } from './chart-palette';

/** 계열 표식 — 기둥은 점, 선은 짧은 선분으로 그려 차트의 마크와 모양을 맞춘다. */
function SeriesMark({ color, form }: { color: string; form: 'BAR' | 'LINE' }) {
  return form === 'LINE' ? (
    <span
      style={{
        display: 'inline-block',
        width: 14,
        height: 2,
        background: color,
        borderRadius: 1,
        verticalAlign: 'middle',
      }}
    />
  ) : (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        background: color,
        borderRadius: '50%',
        verticalAlign: 'middle',
      }}
    />
  );
}

export function ChartLegend({ series, form }: { series: StatsSeries[]; form: 'BAR' | 'LINE' }) {
  // 계열이 하나면 카드 제목이 곧 계열 이름이라 범례를 두지 않는다.
  if (series.length < 2) return null;
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px 16px',
        justifyContent: 'center',
        marginTop: 8,
      }}
    >
      {series.map((s) => (
        <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <SeriesMark color={seriesColor(s.colorIndex)} form={form} />
          <Typography.Text style={{ fontSize: 12 }}>{s.label}</Typography.Text>
        </span>
      ))}
    </div>
  );
}

interface TooltipPayloadItem {
  dataKey?: string | number;
  name?: string;
  value?: number;
  color?: string;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  /** 버킷 시작일을 사람이 읽는 기간 표기로 바꾸는 함수 */
  formatLabel: (period: string) => string;
  /** 값 표기(단위 포함) — 건수는 '3건', 금액은 '1,200,000원' */
  formatValue: (value: number) => string;
  /** 계열이 2개 이상일 때 합계 줄을 붙인다 */
  showTotal: boolean;
}

/**
 * 0인 계열은 줄에서 뺀다 — 하루 예약 목적이 7종이면 대부분 0이라
 * 기본 툴팁은 "0"만 일곱 줄 나열해 정작 있는 값이 묻힌다.
 */
export function ChartTooltip({
  active,
  payload,
  formatLabel,
  formatValue,
  showTotal,
}: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  const row = payload[0] as TooltipPayloadItem & { payload?: { period?: string } };
  const period = row.payload?.period;
  const shown = payload.filter((p) => (p.value ?? 0) > 0);
  const total = payload.reduce((sum, p) => sum + (p.value ?? 0), 0);

  return (
    <div
      style={{
        background: '#ffffff',
        border: `1px solid ${CHART_CHROME.tooltipBorder}`,
        borderRadius: 8,
        boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
        padding: '8px 12px',
        minWidth: 140,
      }}
    >
      <div style={{ marginBottom: 4 }}>
        <Typography.Text strong style={{ fontSize: 12 }}>
          {period ? formatLabel(period) : ''}
        </Typography.Text>
      </div>
      {shown.length === 0 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {formatValue(0)}
        </Typography.Text>
      ) : (
        shown.map((p) => (
          <div
            key={String(p.dataKey)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: p.color,
                flex: '0 0 auto',
              }}
            />
            <span style={{ flex: 1 }}>{p.name}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatValue(p.value ?? 0)}</span>
          </div>
        ))
      )}
      {showTotal && shown.length > 1 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 8,
            fontSize: 12,
            marginTop: 4,
            paddingTop: 4,
            borderTop: `1px solid ${CHART_CHROME.grid}`,
          }}
        >
          <span>합계</span>
          <Typography.Text strong style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
            {formatValue(total)}
          </Typography.Text>
        </div>
      )}
    </div>
  );
}
