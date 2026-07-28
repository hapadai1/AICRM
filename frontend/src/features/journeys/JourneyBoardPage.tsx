import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Empty, Segmented, Space, Spin, Tag, Typography, theme } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { SEMANTIC_COLOR } from '../../app/theme';
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
    <Link to={`/customers/${journey.customerId}`} style={{ display: 'block' }}>
      <Card
        size="small"
        style={{
          // 열(column) 안에 쌓이므로 폭은 열에 맞춘다(예전 가로 나열용 고정 200px 제거).
          width: '100%',
          borderColor: stalled ? SEMANTIC_COLOR.warnBorder : undefined,
          background: stalled ? SEMANTIC_COLOR.warnBg : undefined,
        }}
        styles={{ body: { padding: 10 } }}
      >
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Typography.Text strong>{journey.customerName}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
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
  const { token } = theme.useToken();
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
                { label: '수선', value: 'REPAIR' },
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
        /*
          단계를 세로로 쌓으면 단계마다 카드가 1~2장뿐인데도 행이 전체 폭을 차지해
          오른쪽이 통째로 비고 페이지가 1,400px까지 늘어났다. 진행 현황은 파이프라인을
          한눈에 보는 화면이므로 단계를 열(column)로 세우고 건은 그 안에 세로로 쌓는다.
          열은 남는 폭을 나눠 갖고(flex), 단계가 많아 좁아지면 보드만 가로 스크롤한다.
        */
        /* alignItems: flex-start — 드래그가 없는 보드라 열 높이를 맞출 이유가 없다.
           stretch 로 두면 비어 있는 단계의 회색 블록이 가장 긴 열만큼 늘어나 화면이 무거워진다. */
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', alignItems: 'flex-start' }}>
          {stages.map((stage, idx) => {
            const rows = byStage(stage.code);
            return (
              <div
                key={stage.code}
                style={{
                  flex: '1 1 0',
                  // 8단계(맞춤 트랙)가 가로 스크롤 없이 한 화면에 들어가는 폭
                  minWidth: 132,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                {/* 단계 머리 — 순서·이름·건수 */}
                <Space size={4} style={{ padding: '0 4px 8px' }}>
                  <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                    {idx + 1}
                  </Tag>
                  <Typography.Text strong style={{ fontSize: 12 }}>
                    {stage.name}
                  </Typography.Text>
                  <Tag style={{ marginInlineEnd: 0 }}>{rows.length}</Tag>
                </Space>
                {/* 이 단계에 머문 건들 — 열 안에서 세로로 쌓인다 */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    flex: 1,
                    padding: 8,
                    borderRadius: 8,
                    background: token.colorFillQuaternary,
                    minHeight: 72,
                  }}
                >
                  {rows.length === 0 ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      없음
                    </Typography.Text>
                  ) : (
                    rows.map((j) => (
                      <JourneyChip key={j.id} journey={j} stalledDays={stalledDays} />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Space>
  );
}
