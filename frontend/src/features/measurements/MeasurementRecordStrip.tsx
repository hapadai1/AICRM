/**
 * 이 고객의 채촌 이력 줄 (현업 확정 2026-08-01, 배치 재확정 2026-08-05).
 * 고객 머리말 카드 안에 붙어서 "이 사람이 지금까지 한 채촌"으로 읽히게 한다.
 * 누르면 그 기록을 그대로 열어 본다 — 저장한 기록이 없으면 줄 자체가 없다.
 * 버전이 아니라 "구분 + 채촌일"로 고르는 것이 핵심이다.
 */
import { LockOutlined } from '@ant-design/icons';
import { Button, Space, Tag, Typography } from 'antd';
import type { MeasurementSummary } from '../../api/measurements';
import { buildRecordTitles } from './record-label';

interface MeasurementRecordStripProps {
  records: MeasurementSummary[];
  /** 지금 보고 있는 기록 (신규 작성 중이면 없음) */
  currentId?: string;
  onSelect: (id: string) => void;
}

export function MeasurementRecordStrip({
  records,
  currentId,
  onSelect,
}: MeasurementRecordStripProps) {
  // 저장한 기록이 하나도 없으면 줄 자체를 내보내지 않는다 (현업 확정 2026-08-01).
  // 빈 칸을 보여 줄 이유가 없고, 첫 채촌은 아래 입력 폼에서 바로 쓴다.
  if (records.length === 0) return null;

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
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}>
      <Typography.Text type="secondary" style={{ flexShrink: 0 }}>
        채촌 이력
      </Typography.Text>
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4, flex: 1 }}>
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
                  {/* 채촌은 '완료' 상태를 두지 않는다 (2026-08-05) — 잠긴 것만 표시한다. */}
                  {record.locked && (
                    <Tag color="default" icon={<LockOutlined />} style={{ marginInlineEnd: 0 }}>
                      진행 시작
                    </Tag>
                  )}
                </Space>
              </Space>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
