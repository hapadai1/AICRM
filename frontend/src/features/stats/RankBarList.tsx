/**
 * 순위 막대 목록 (STAT-001).
 *
 * 인기 순위는 "무엇이 몇 번"이 전부라 축·격자가 있는 차트보다 목록형 막대가 읽기 쉽다.
 * 막대를 줄 배경으로 깔고 글자를 그 위에 얹어, 이름·건수·길이를 한 줄에서 같이 본다.
 *
 * 색은 한 가지만 쓴다 — 순위는 이미 길이가 말하고 있으므로 색까지 순위에 따라 바꾸면
 * 같은 정보를 두 번 칠하는 셈이고, 색 하나하나의 뜻도 사라진다.
 * 강조가 필요한 1위는 색이 아니라 글자 굵기로 표시한다.
 */
import { Typography } from 'antd';
import { CHART_SERIES_COLORS } from './chart-palette';

/** 막대 배경 — 계열색 슬롯 1을 옅게 깐다. 글자는 본문 잉크색을 그대로 쓴다. */
const BAR_FILL = 'rgba(42, 120, 214, 0.16)';
const ROW_HEIGHT = 30;

export interface RankBarRow {
  key: string;
  /** 왼쪽에 굵게 적히는 이름 */
  label: string;
  /** 이름 뒤에 옅게 붙는 부가 표기 (선택지 코드·사이즈 등) */
  sublabel?: string;
  count: number;
  /** 비율(%) — 없으면 건수만 적는다 */
  share?: number;
}

interface RankBarListProps {
  rows: RankBarRow[];
  /**
   * 막대 길이 100%의 기준 건수 — 전체 건수를 넣으면 막대 길이가 곧 옆에 적힌 비율이 된다.
   * 넣지 않으면 목록 최댓값을 기준으로 삼는데, 그러면 1위 막대가 항상 꽉 차서
   * 옆에 적힌 60%와 눈에 보이는 100%가 어긋난다.
   */
  maxCount?: number;
  /** 목록이 길 때 이 높이부터 안에서 스크롤한다 */
  maxHeight?: number;
}

export function RankBarList({ rows, maxCount, maxHeight }: RankBarListProps) {
  const max = maxCount ?? rows.reduce((m, r) => Math.max(m, r.count), 0);

  return (
    <div
      style={
        maxHeight ? { maxHeight, overflowY: 'auto', paddingRight: 4 } : undefined
      }
    >
      {rows.map((row, i) => {
        const empty = row.count === 0;
        const width = max > 0 ? (row.count / max) * 100 : 0;
        return (
          <div
            key={row.key}
            style={{
              position: 'relative',
              height: ROW_HEIGHT,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 8px',
              borderRadius: 4,
              // 줄 사이 2px 틈 — 테두리를 그리지 않고 배경으로 가른다.
              marginBottom: 2,
              overflow: 'hidden',
            }}
          >
            {!empty && (
              <div
                aria-hidden
                style={{
                  position: 'absolute',
                  inset: 0,
                  right: 'auto',
                  width: `${width}%`,
                  background: BAR_FILL,
                  borderRadius: 4,
                  // 1위만 왼쪽에 계열색 선을 세워 눈에 먼저 걸리게 한다.
                  borderLeft: i === 0 ? `3px solid ${CHART_SERIES_COLORS[0]}` : undefined,
                }}
              />
            )}
            <Typography.Text
              type="secondary"
              style={{
                position: 'relative',
                fontSize: 12,
                width: 16,
                flex: '0 0 auto',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {i + 1}
            </Typography.Text>
            <Typography.Text
              ellipsis
              title={row.label}
              type={empty ? 'secondary' : undefined}
              strong={i === 0 && !empty}
              style={{ position: 'relative', flex: 1, fontSize: 13 }}
            >
              {row.label}
              {row.sublabel && (
                <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>
                  {row.sublabel}
                </Typography.Text>
              )}
            </Typography.Text>
            <Typography.Text
              type={empty ? 'secondary' : undefined}
              style={{
                position: 'relative',
                fontSize: 12,
                whiteSpace: 'nowrap',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {row.count}건{row.share !== undefined && ` · ${row.share}%`}
            </Typography.Text>
          </div>
        );
      })}
    </div>
  );
}
