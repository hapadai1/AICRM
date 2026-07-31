/**
 * 렌탈 출고 인기 품목 상위 5개 (STAT-001).
 *
 * 세는 단위는 실물(관리코드)이 아니라 SKU(구분·컬러·사이즈)다 —
 * 같은 색·사이즈를 여러 벌 보유하므로 실물로 세면 "무엇이 잘 나가는가"가
 * 보유 수량에 흩어져 보이지 않는다.
 */
import { useQuery } from '@tanstack/react-query';
import { Alert, Empty, Segmented, Space, Spin, Table, Typography } from 'antd';
import { useState } from 'react';
import { COMPONENT_TYPE_LABELS } from '../../api/code-labels';
import { fetchRentalPopularity } from '../../api/stats';
import { PageCard } from '../../shared/PageShell';
import { RankBarList } from './RankBarList';
import type { StatsRangeState } from './stats-range';

const TOP_N = 5;

export function RentalPopularityCard({ range }: { range: StatsRangeState }) {
  const [view, setView] = useState<'CHART' | 'TABLE'>('CHART');

  const query = useQuery({
    queryKey: ['stats', 'rental-popularity', range.from, range.to],
    queryFn: () => fetchRentalPopularity({ from: range.from, to: range.to, limit: TOP_N }),
    placeholderData: (prev) => prev,
  });

  const data = query.data;
  const rows = (data?.rows ?? []).map((row) => ({
    key: row.rentalSkuId,
    label: `${COMPONENT_TYPE_LABELS[row.componentType] ?? row.componentType} · ${row.color}`,
    sublabel: row.size,
    count: row.count,
    share: row.share,
  }));

  return (
    <PageCard
      title={`렌탈 출고 인기 품목 상위 ${TOP_N}개`}
      extra={
        <Space size={8}>
          <Typography.Text type="secondary">출고 {data?.total ?? 0}건</Typography.Text>
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
      <Typography.Paragraph type="secondary" style={{ marginTop: -4, marginBottom: 16, fontSize: 12 }}>
        실제 출고일 기준. 실물 SKU(구분·컬러·사이즈)별로 묶어 많이 나간 순으로 나열한다.
      </Typography.Paragraph>

      {query.isError ? (
        <Alert
          type="error"
          showIcon
          message="렌탈 인기 품목을 불러오지 못했습니다."
          description={(query.error as Error)?.message}
        />
      ) : !data ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      ) : rows.length === 0 ? (
        <Empty description="이 기간에 출고된 렌탈 건이 없습니다." />
      ) : (
        <div style={{ opacity: query.isFetching ? 0.55 : 1, transition: 'opacity 120ms' }}>
          {view === 'TABLE' ? (
            <Table
              size="small"
              pagination={false}
              dataSource={(data.rows ?? []).map((row, i) => ({ ...row, key: row.rentalSkuId, rank: i + 1 }))}
              columns={[
                { title: '순위', dataIndex: 'rank', key: 'rank', align: 'right', width: 70 },
                {
                  title: '구분',
                  dataIndex: 'componentType',
                  key: 'componentType',
                  render: (code: string) => COMPONENT_TYPE_LABELS[code] ?? code,
                },
                { title: '컬러', dataIndex: 'color', key: 'color' },
                { title: '사이즈', dataIndex: 'size', key: 'size' },
                {
                  title: '출고',
                  dataIndex: 'count',
                  key: 'count',
                  align: 'right',
                  width: 90,
                  render: (count: number) => (
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{count}</span>
                  ),
                },
                {
                  title: '비율',
                  dataIndex: 'share',
                  key: 'share',
                  align: 'right',
                  width: 90,
                  render: (share: number) => (
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{share}%</span>
                  ),
                },
              ]}
            />
          ) : (
            <RankBarList rows={rows} maxCount={data.total} />
          )}
          {data.omittedSkus > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 12 }}>
              상위 {TOP_N}개 밖 {data.omittedSkus}종은 표시하지 않았다.
            </Typography.Text>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 12 }}>
            {data.basis}
          </Typography.Text>
        </div>
      )}
    </PageCard>
  );
}
