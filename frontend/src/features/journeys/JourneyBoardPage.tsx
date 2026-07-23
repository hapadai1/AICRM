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

/** 정체로 볼 기준 일수 — 사용자가 상단에서 고른다. */
const STALLED_DAY_OPTIONS = [2, 3, 4, 5, 7];
const DEFAULT_STALLED_DAYS = 7;

function JourneyChip({ journey, stalledDays }: { journey: Journey; stalledDays: number }) {
  const stalled = (journey.daysInStage ?? 0) >= stalledDays;
  return (
    <Link to={`/customers/${journey.customerId}`}>
      <Card
        size="small"
        style={{
          width: 200,
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
  const [stalledDays, setStalledDays] = useState<number>(DEFAULT_STALLED_DAYS);

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
  const stalledCount = journeys.filter((j) => (j.daysInStage ?? 0) >= stalledDays).length;

  const byStage = (code: string) => journeys.filter((j) => j.currentStageCode === code);

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card>
        <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
          <Typography.Text type="secondary">진행 중 {journeys.length}건</Typography.Text>
          <Space wrap size="middle">
            <Space size={4}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                정체 기준
              </Typography.Text>
              <Segmented
                value={stalledDays}
                onChange={(v) => setStalledDays(v as number)}
                options={STALLED_DAY_OPTIONS.map((d) => ({ label: `${d}일`, value: d }))}
              />
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
        </Space>
        {stalledCount > 0 && (
          <Alert
            style={{ marginTop: 12 }}
            type="warning"
            showIcon
            message={`${stalledDays}일 이상 같은 단계에 머문 건이 ${stalledCount}건 있습니다.`}
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
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {stages.map((stage, idx) => {
            const rows = byStage(stage.code);
            return (
              <Card
                key={stage.code}
                size="small"
                styles={{ body: { padding: 12 } }}
              >
                <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                  {/* 단계 라벨 — 세로로 쌓인 각 행의 머리 */}
                  <Space
                    size={6}
                    style={{ width: 150, flexShrink: 0, paddingTop: 4 }}
                  >
                    <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                      {idx + 1}
                    </Tag>
                    <Typography.Text strong style={{ fontSize: 13 }}>
                      {stage.name}
                    </Typography.Text>
                    <Tag>{rows.length}</Tag>
                  </Space>
                  {/* 이 단계에 머문 건들 — 가로로 흐르고, 넘치면 줄바꿈 */}
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 8,
                      flex: 1,
                      minHeight: 44,
                      alignContent: 'flex-start',
                    }}
                  >
                    {rows.length === 0 ? (
                      <Typography.Text type="secondary" style={{ fontSize: 12, paddingTop: 6 }}>
                        해당 단계 없음
                      </Typography.Text>
                    ) : (
                      rows.map((j) => (
                        <JourneyChip key={j.id} journey={j} stalledDays={stalledDays} />
                      ))
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </Space>
      )}
    </Space>
  );
}
