/**
 * 고객이 지금까지 저장한 채촌 목록 (현업 확정 2026-08-01).
 * 채촌 화면 맨 위에 깔아 두고, 누르면 그 기록을 그대로 열어 본다.
 * 버전이 아니라 "구분 + 채촌일"로 고르는 것이 핵심이다.
 */
import { LockOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Card, Empty, Space, Spin, Tag, Typography } from 'antd';
import type { MeasurementSummary } from '../../api/measurements';
import { buildRecordTitles } from './record-label';

interface MeasurementRecordStripProps {
  records: MeasurementSummary[];
  loading?: boolean;
  /** 지금 보고 있는 기록 (신규 작성 중이면 없음) */
  currentId?: string;
  onSelect: (id: string) => void;
  /** 없으면 [새 채촌] 버튼을 감춘다 (이미 신규 작성 화면일 때) */
  onCreate?: () => void;
}

export function MeasurementRecordStrip({
  records,
  loading,
  currentId,
  onSelect,
  onCreate,
}: MeasurementRecordStripProps) {
  const titles = buildRecordTitles(records);
  // 최근 것을 왼쪽에 둔다 — 회차 번호는 오래된 순으로 매긴 값을 그대로 쓴다.
  const chips = records
    .map((r, index) => ({ record: r, title: titles[index] ?? '' }))
    .sort((a, b) =>
      a.record.measurementDate === b.record.measurementDate
        ? b.record.versionNo - a.record.versionNo
        : a.record.measurementDate < b.record.measurementDate
          ? 1
          : -1,
    );

  return (
    <Card
      size="small"
      title={`저장한 채촌 ${records.length}건`}
      style={{ marginBottom: 16 }}
      extra={
        onCreate && (
          <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
            새 채촌
          </Button>
        )
      }
    >
      {loading ? (
        <Spin />
      ) : chips.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="저장된 채촌이 없습니다. 아래에서 첫 채촌을 입력하세요."
        />
      ) : (
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
          {chips.map(({ record, title }) => {
            const active = record.id === currentId;
            return (
              <Button
                key={record.id}
                type={active ? 'primary' : 'default'}
                onClick={() => onSelect(record.id)}
                style={{
                  height: 'auto',
                  minWidth: 150,
                  padding: '8px 12px',
                  textAlign: 'left',
                  whiteSpace: 'normal',
                }}
              >
                <Space direction="vertical" size={0} style={{ width: '100%' }}>
                  <Typography.Text strong style={{ color: 'inherit', fontSize: 15 }}>
                    {title}
                  </Typography.Text>
                  <Space size={4}>
                    <Typography.Text style={{ color: 'inherit', fontSize: 12, opacity: 0.75 }}>
                      {record.measurementDate}
                    </Typography.Text>
                    {record.locked ? (
                      <Tag color="default" icon={<LockOutlined />} style={{ marginInlineEnd: 0 }}>
                        출력됨
                      </Tag>
                    ) : (
                      <Tag
                        color={record.completed ? 'green' : 'orange'}
                        style={{ marginInlineEnd: 0 }}
                      >
                        {record.completed ? '완료' : '작성중'}
                      </Tag>
                    )}
                  </Space>
                </Space>
              </Button>
            );
          })}
        </div>
      )}
    </Card>
  );
}
