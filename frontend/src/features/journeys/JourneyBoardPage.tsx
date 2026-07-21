import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Empty, Segmented, Space, Spin, Tag, Typography } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchJourneys,
  fetchJourneyStages,
  trackTypeLabel,
  type Journey,
  type TrackType,
} from '../../api/journeys';

/**
 * 진행 현황 보드 (개발설계서 05 G-11).
 * 단계별 칸반으로 "지금 어느 고객이 어디서 멈춰 있는지"를 한 화면에 보여준다.
 */

/** 이 일수 이상 같은 단계에 머물면 정체로 강조한다. */
const STALLED_DAYS = 7;

function JourneyChip({ journey }: { journey: Journey }) {
  const stalled = (journey.daysInStage ?? 0) >= STALLED_DAYS;
  return (
    <Link to={`/customers/${journey.customerId}`}>
      <Card
        size="small"
        style={{
          marginBottom: 8,
          borderColor: stalled ? '#ff7875' : undefined,
          background: stalled ? '#fff2f0' : undefined,
        }}
        styles={{ body: { padding: 10 } }}
      >
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Typography.Text strong>{journey.customerName}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {journey.orderNo ?? trackTypeLabel(journey.trackType)}
          </Typography.Text>
          <Typography.Text type={stalled ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
            {journey.daysInStage ?? 0}일째
          </Typography.Text>
        </Space>
      </Card>
    </Link>
  );
}

export function JourneyBoardPage() {
  const [trackType, setTrackType] = useState<TrackType>('CUSTOM');

  const stagesQuery = useQuery({
    queryKey: ['journey-stages', trackType],
    queryFn: () => fetchJourneyStages(trackType),
  });

  const journeysQuery = useQuery({
    queryKey: ['journeys', trackType],
    queryFn: () => fetchJourneys({ trackType, status: 'ACTIVE', size: 100 }),
  });

  const stages = stagesQuery.data ?? [];
  const journeys = journeysQuery.data?.data ?? [];
  const stalledCount = journeys.filter((j) => (j.daysInStage ?? 0) >= STALLED_DAYS).length;

  const byStage = (code: string) => journeys.filter((j) => j.currentStageCode === code);

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card>
        <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space wrap>
            <Typography.Title level={4} style={{ margin: 0 }}>
              진행 현황
            </Typography.Title>
            <Typography.Text type="secondary">진행 중 {journeys.length}건</Typography.Text>
          </Space>
          <Segmented
            value={trackType}
            onChange={(v) => setTrackType(v as TrackType)}
            options={[
              { label: '비즈니스 맞춤', value: 'CUSTOM' },
              { label: '웨딩패키지 렌탈', value: 'RENTAL' },
            ]}
          />
        </Space>
        {stalledCount > 0 && (
          <Alert
            style={{ marginTop: 12 }}
            type="warning"
            showIcon
            message={`${STALLED_DAYS}일 이상 같은 단계에 머문 건이 ${stalledCount}건 있습니다.`}
          />
        )}
      </Card>

      {stagesQuery.isLoading || journeysQuery.isLoading ? (
        <Card style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </Card>
      ) : journeys.length === 0 ? (
        <Card>
          <Empty description="진행 중인 거래가 없습니다" />
        </Card>
      ) : (
        <div style={{ overflowX: 'auto', paddingBottom: 8 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${stages.length}, minmax(180px, 1fr))`,
              gap: 12,
              minWidth: stages.length * 190,
            }}
          >
            {stages.map((stage) => {
              const rows = byStage(stage.code);
              return (
                <Card
                  key={stage.code}
                  size="small"
                  title={
                    <Space size={4}>
                      <Typography.Text style={{ fontSize: 13 }}>{stage.name}</Typography.Text>
                      <Tag>{rows.length}</Tag>
                    </Space>
                  }
                  styles={{ body: { padding: 8, minHeight: 120, background: '#fafafa' } }}
                >
                  {rows.map((j) => (
                    <JourneyChip key={j.id} journey={j} />
                  ))}
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </Space>
  );
}
