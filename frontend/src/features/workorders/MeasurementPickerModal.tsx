/**
 * 작업지시서에 쓸 채촌 고르기 (현업 확정 2026-08-03).
 * 고객이 이미 정해져 있으므로 그 고객의 채촌만 띄운다 — 구분·채촌일로 고른다.
 * 고른 채촌은 품목 연결로 바로 확정된다(미리보기만 바꾸는 것이 아니다).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Modal, Segmented, Space, Spin, Switch, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import type { MeasurementSummary } from '../../api/measurements';
import { fetchMeasurements, linkOrderItemMeasurement } from '../../api/measurements';
import { buildRecordTitles } from '../measurements/record-label';
import { MEASUREMENT_TYPE_META } from './wo-meta';
import { metaOf } from '../../shared/status-meta';

interface MeasurementPickerModalProps {
  open: boolean;
  onClose: () => void;
  orderItemId: string;
  customerId: string;
  customerName: string;
  /** 지금 쓰고 있는 채촌 — 다시 고를 필요가 없으므로 표시만 한다 */
  currentSessionId?: string;
  onPicked: () => void;
}

interface PickerRow extends MeasurementSummary {
  title: string;
}

const TYPE_FILTERS = [
  { label: '전체', value: 'ALL' },
  { label: '스타일 컨설팅', value: 'INITIAL' },
  { label: '가봉', value: 'FITTING' },
  { label: '수선', value: 'REMEASURE' },
  { label: '기타', value: 'OTHER' },
];

export function MeasurementPickerModal({
  open,
  onClose,
  orderItemId,
  customerId,
  customerName,
  currentSessionId,
  onPicked,
}: MeasurementPickerModalProps) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [typeFilter, setTypeFilter] = useState<string>('ALL');
  // 미완료 채촌은 품목에 연결할 수 없어 기본으로 감춘다.
  const [completedOnly, setCompletedOnly] = useState(true);

  const recordsQuery = useQuery({
    queryKey: ['measurements', 'byCustomer', customerId],
    queryFn: () => fetchMeasurements(customerId),
    enabled: open && !!customerId,
  });

  const pickMutation = useMutation({
    mutationFn: (sessionId: string) => linkOrderItemMeasurement(orderItemId, sessionId),
    onSuccess: () => {
      message.success('작업지시서에 쓸 채촌을 바꿨습니다.');
      void queryClient.invalidateQueries({ queryKey: ['workorders'] });
      void queryClient.invalidateQueries({ queryKey: ['production'] });
      onPicked();
      onClose();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '채촌을 연결하지 못했습니다.'),
  });

  const records = recordsQuery.data ?? [];
  const titles = buildRecordTitles(records);
  const rows: PickerRow[] = records
    .map((r, i) => ({ ...r, title: titles[i] ?? '' }))
    .filter((r) => (typeFilter === 'ALL' ? true : r.measurementType === typeFilter))
    .filter((r) => (completedOnly ? r.completed : true));

  const columns: ColumnsType<PickerRow> = [
    {
      title: '구분',
      key: 'title',
      render: (_, row) => {
        const meta = metaOf(MEASUREMENT_TYPE_META, row.measurementType);
        return (
          <Space size={4}>
            <Tag color={meta.color}>{row.title}</Tag>
            {row.id === currentSessionId && <Tag color="blue">현재 사용</Tag>}
          </Space>
        );
      },
    },
    { title: '채촌일', dataIndex: 'measurementDate', width: 120 },
    {
      title: '상태',
      key: 'status',
      width: 110,
      render: (_, row) =>
        row.completed ? (
          <Tag color="green">완료</Tag>
        ) : (
          <Tag color="orange">작성중</Tag>
        ),
    },
    { title: '담당', dataIndex: 'staffName', width: 110 },
    { title: '항목 수', dataIndex: 'valueCount', width: 90 },
    {
      title: '',
      key: 'pick',
      width: 110,
      render: (_, row) =>
        row.id === currentSessionId ? (
          <Typography.Text type="secondary">사용 중</Typography.Text>
        ) : (
          <Button
            type="primary"
            disabled={!row.completed}
            loading={pickMutation.isPending && pickMutation.variables === row.id}
            onClick={() => pickMutation.mutate(row.id)}
          >
            {row.completed ? '선택' : '완료 필요'}
          </Button>
        ),
    },
  ];

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={800}
      title={`채촌 선택 — ${customerName}`}
      destroyOnHidden
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space wrap align="center" size="middle">
          <Segmented value={typeFilter} options={TYPE_FILTERS} onChange={(v) => setTypeFilter(v as string)} />
          <Space size={6}>
            <Switch checked={completedOnly} onChange={setCompletedOnly} />
            <Typography.Text type="secondary">완료된 채촌만</Typography.Text>
          </Space>
        </Space>
        {recordsQuery.isLoading ? (
          <Spin style={{ display: 'block', margin: '40px auto' }} />
        ) : (
          <Table<PickerRow>
            rowKey="id"
            size="middle"
            dataSource={rows}
            columns={columns}
            pagination={false}
            scroll={{ y: 380 }}
            locale={{ emptyText: '조건에 맞는 채촌이 없습니다.' }}
          />
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          고른 채촌이 이 품목의 기준이 됩니다. 작업요청 뒤에는 바꿀 수 없습니다.
        </Typography.Text>
      </Space>
    </Modal>
  );
}
