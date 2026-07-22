/** DASH-001 확인사항 카드 5종 + 목록 패널 */
import { CheckOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Col, Row, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  acknowledgeDashboardTask,
  fetchDashboardTasks,
} from '../../api/dashboard';
import type { DashboardTask, DashboardTaskType } from '../../api/dashboard';
import { metaOf } from '../../shared/status-meta';

const TASK_META: Record<DashboardTaskType, { label: string; color: string }> = {
  LATE_RETURN: { label: '반납 지연', color: '#cf1322' },
  INBOUND_DELAY: { label: '입고 지연', color: '#d46b08' },
  PAYMENT_DELAY: { label: '결제 지연', color: '#c41d7f' },
  UNORDERED: { label: '미주문', color: '#1d39c4' },
  REPRINT_NEEDED: { label: '재출력 필요', color: '#531dab' },
};

const TASK_TYPES: DashboardTaskType[] = [
  'LATE_RETURN',
  'INBOUND_DELAY',
  'PAYMENT_DELAY',
  'UNORDERED',
  'REPRINT_NEEDED',
];

/** 확인사항 행 클릭 시 이동할 업무 화면 경로 */
function taskTargetPath(task: DashboardTask): string {
  switch (task.taskType) {
    case 'PAYMENT_DELAY':
      return task.contractId ? `/payments?contractId=${task.contractId}` : '/payments';
    case 'LATE_RETURN':
      return '/rentals';
    case 'UNORDERED':
    case 'REPRINT_NEEDED':
    case 'INBOUND_DELAY':
      return '/production';
  }
}

interface TaskBoardProps {
  taskCounts: Record<DashboardTaskType, number> | undefined;
}

export function TaskBoard({ taskCounts }: TaskBoardProps) {
  const [selectedType, setSelectedType] = useState<DashboardTaskType | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = App.useApp();

  const tasksQuery = useQuery({
    queryKey: ['dashboard', 'tasks', selectedType],
    queryFn: () => fetchDashboardTasks(selectedType ?? undefined),
    enabled: selectedType !== null,
  });

  const acknowledgeMutation = useMutation({
    mutationFn: acknowledgeDashboardTask,
    onSuccess: () => {
      message.success('확인 처리되었습니다.');
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (e) => {
      message.error(e instanceof ApiError ? e.message : '확인 처리에 실패했습니다.');
    },
  });

  const columns: ColumnsType<DashboardTask> = [
    { title: '고객명', dataIndex: 'customerName', width: 100 },
    {
      title: '주문번호',
      dataIndex: 'orderNo',
      width: 160,
      render: (v: string | undefined) => v ?? '-',
    },
    { title: '품목', dataIndex: 'itemLabel' },
    { title: '사유', dataIndex: 'reason' },
    { title: '기준일', dataIndex: 'dueDate', width: 110 },
    {
      title: '확인',
      key: 'ack',
      width: 150,
      render: (_, task) =>
        task.acknowledged ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {task.acknowledgedBy} 확인
          </Typography.Text>
        ) : (
          <Button
            size="small"
            icon={<CheckOutlined />}
            loading={acknowledgeMutation.isPending && acknowledgeMutation.variables === task.taskId}
            onClick={(e) => {
              e.stopPropagation();
              acknowledgeMutation.mutate(task.taskId);
            }}
          >
            확인
          </Button>
        ),
    },
  ];

  return (
    <Card title="확인사항" size="small">
      <Row gutter={[12, 12]}>
        {TASK_TYPES.map((type) => {
          const meta = metaOf(TASK_META, type);
          const count = taskCounts?.[type] ?? 0;
          const selected = selectedType === type;
          return (
            <Col key={type} xs={12} md={8} lg={4} flex="auto">
              <Card
                size="small"
                hoverable
                onClick={() => setSelectedType(selected ? null : type)}
                style={{
                  textAlign: 'center',
                  borderColor: selected ? meta.color : undefined,
                  borderWidth: selected ? 2 : 1,
                }}
              >
                <Typography.Text type="secondary">{meta.label}</Typography.Text>
                <Typography.Title level={3} style={{ margin: '4px 0 0', color: meta.color }}>
                  {count}
                </Typography.Title>
              </Card>
            </Col>
          );
        })}
      </Row>

      {selectedType && (
        <div style={{ marginTop: 16 }}>
          <Typography.Text strong>
            <Tag color={metaOf(TASK_META, selectedType).color}>{metaOf(TASK_META, selectedType).label}</Tag>
            목록 — 행을 클릭하면 해당 업무 화면으로 이동합니다.
          </Typography.Text>
          <Table<DashboardTask>
            rowKey="taskId"
            scroll={{ x: 'max-content' }}
            size="small"
            style={{ marginTop: 8 }}
            loading={tasksQuery.isLoading}
            dataSource={tasksQuery.data ?? []}
            columns={columns}
            pagination={false}
            locale={{ emptyText: '해당 확인사항이 없습니다.' }}
            onRow={(task) => ({
              onClick: () => navigate(taskTargetPath(task)),
              style: { cursor: 'pointer' },
            })}
          />
        </div>
      )}
    </Card>
  );
}
