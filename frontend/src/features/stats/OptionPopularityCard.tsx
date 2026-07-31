/**
 * 구성품별 인기 옵션 (STAT-001).
 *
 * 옵션은 단계(원단·라펠·커프스…)마다 선택지 집합이 달라 한 차트에 섞으면 뜻이 없다.
 * 그래서 단계별 소형 목록을 나란히 두고, 각 단계 안에서만 많이 선택된 순으로 줄을 세운다.
 * 목록은 잘라내지 않고 그 단계 선택지 전체를 싣는다 — 0건도 한 줄로 남아야
 * "아무도 안 고르는 선택지"를 알 수 있다.
 */
import { useQuery } from '@tanstack/react-query';
import { Alert, Col, Empty, Row, Segmented, Space, Spin, Table, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { COMPONENT_TYPE_CODES, COMPONENT_TYPE_LABELS } from '../../api/code-labels';
import { fetchOptionPopularity, type OptionPopularityStage } from '../../api/stats';
import { PageCard } from '../../shared/PageShell';
import { RankBarList } from './RankBarList';
import type { StatsRangeState } from './stats-range';

interface OptionPopularityCardProps {
  componentType: string;
  onComponentTypeChange: (componentType: string) => void;
  range: StatsRangeState;
}

/** 선택지가 많은 단계(구두 스타일 29종 등)는 이 높이부터 목록 안에서 스크롤한다. */
const STAGE_LIST_MAX_HEIGHT = 320;

function StageBlock({ stage }: { stage: OptionPopularityStage }) {
  const rows = stage.choices.map((choice) => ({
    key: choice.choiceCode,
    label: choice.choiceName,
    sublabel: choice.retired ? `${choice.choiceCode} · 지난 버전` : choice.choiceCode,
    count: choice.count,
    share: choice.share,
  }));

  return (
    <div>
      <Space size={8} align="center" style={{ marginBottom: 8 }}>
        <Typography.Text strong>{stage.stageName}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          확정 {stage.total}건 · 선택지 {stage.choices.length}종
        </Typography.Text>
      </Space>
      {/* 막대 길이 기준을 단계 확정 건수로 잡아 막대 길이와 옆에 적힌 비율을 일치시킨다. */}
      <RankBarList rows={rows} maxCount={stage.total} maxHeight={STAGE_LIST_MAX_HEIGHT} />
    </div>
  );
}

export function OptionPopularityCard({
  componentType,
  onComponentTypeChange,
  range,
}: OptionPopularityCardProps) {
  const [view, setView] = useState<'CHART' | 'TABLE'>('CHART');
  const componentTypeLabel = COMPONENT_TYPE_LABELS[componentType] ?? componentType;

  const query = useQuery({
    queryKey: ['stats', 'option-popularity', componentType, range.from, range.to],
    queryFn: () => fetchOptionPopularity({ componentType, from: range.from, to: range.to }),
    placeholderData: (prev) => prev,
  });

  const data = query.data;

  /** 표용 — 단계 × 선택지 평면 목록 */
  const tableRows = useMemo(
    () =>
      (data?.stages ?? []).flatMap((stage) =>
        stage.choices.map((choice, i) => ({
          key: `${stage.stageCode}:${choice.choiceCode}`,
          stageName: stage.stageName,
          rank: i + 1,
          choice: `${choice.choiceCode}. ${choice.choiceName}`,
          count: choice.count,
          share: choice.share,
        })),
      ),
    [data],
  );

  return (
    <PageCard
      title="구성품별 인기 옵션"
      extra={
        <Space size={8}>
          <Typography.Text type="secondary">옵션 확정 {data?.sessionCount ?? 0}건</Typography.Text>
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
      {/* 구성품 선택 — 드롭다운에 감추지 않고 선택지를 전부 펼쳐 둔다. */}
      <Segmented
        value={componentType}
        onChange={(v) => onComponentTypeChange(String(v))}
        style={{ marginBottom: 12 }}
        options={COMPONENT_TYPE_CODES.map((code) => ({
          value: code,
          label: COMPONENT_TYPE_LABELS[code] ?? code,
        }))}
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: -4, marginBottom: 16, fontSize: 12 }}>
        단계별 선택지 전체를 많이 선택된 순으로 나열한다. 비율은 그 단계 확정 건수 대비다.
      </Typography.Paragraph>

      {query.isError ? (
        <Alert
          type="error"
          showIcon
          message="인기 옵션을 불러오지 못했습니다."
          description={(query.error as Error)?.message}
        />
      ) : !data ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      ) : data.stages.length === 0 ? (
        <Empty description={`${componentTypeLabel} 옵션 단계가 없습니다.`} />
      ) : (
        <div style={{ opacity: query.isFetching ? 0.55 : 1, transition: 'opacity 120ms' }}>
          {view === 'TABLE' ? (
            <Table
              size="small"
              dataSource={tableRows}
              pagination={false}
              scroll={{ x: 'max-content', y: 480 }}
              columns={[
                { title: '단계', dataIndex: 'stageName', key: 'stageName' },
                { title: '순위', dataIndex: 'rank', key: 'rank', align: 'right', width: 70 },
                { title: '선택지', dataIndex: 'choice', key: 'choice' },
                {
                  title: '건수',
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
            <Row gutter={[32, 28]}>
              {data.stages.map((stage) => (
                <Col key={stage.stageCode} xs={24} lg={12} xxl={8}>
                  <StageBlock stage={stage} />
                </Col>
              ))}
            </Row>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 16 }}>
            {data.basis}
          </Typography.Text>
        </div>
      )}
    </PageCard>
  );
}
