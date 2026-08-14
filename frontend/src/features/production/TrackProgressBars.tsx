/**
 * 제작 진행률(트랙별) 표시 — 목록과 상세 헤더가 **같은 모양·같은 값**을 쓰도록 한곳에 둔다.
 * 값은 흐름 카드와 같은 단계 기반(contractTrackProgress)이라, 계약·스타일 컨설팅·채촌(준비)은
 * 빼고 제작 단계만 센다. 맞춤·렌탈이 함께 도는 계약은 트랙마다 나눠 두 줄로 그린다.
 */
import { Progress, Space, Typography } from 'antd';
import type { ContractTrackProgress } from './production-stages';

interface TrackProgressBarsProps {
  progress: ContractTrackProgress;
  /** 진행률 바 최소 폭 */
  barWidth?: number;
  /** 맞춤/렌탈 구분 라벨 표시 여부 — 별도 상태 열이 있는 목록에선 끈다 */
  showLabels?: boolean;
}

export function TrackProgressBars({ progress, barWidth = 120, showLabels = true }: TrackProgressBarsProps) {
  const { custom, rental } = progress;
  const bar = (pct: number, prefix?: string) => (
    <Space size={6} style={{ width: '100%' }}>
      {prefix && showLabels && (
        <Typography.Text type="secondary" style={{ fontSize: 12, width: 28, flex: 'none' }}>
          {prefix}
        </Typography.Text>
      )}
      <Progress percent={pct} size="small" style={{ minWidth: barWidth }} />
    </Space>
  );
  if (custom !== null && rental !== null) {
    return (
      <Space direction="vertical" size={2} style={{ width: '100%' }}>
        {bar(custom, '맞춤')}
        {bar(rental, '렌탈')}
      </Space>
    );
  }
  const only = custom ?? rental;
  return only !== null ? bar(only) : <Typography.Text type="secondary">-</Typography.Text>;
}
