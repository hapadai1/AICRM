/** WO-001 작업지시서 목록·상태 — 전체/미주문/재출력 필요/최신/준비 미완 탭 필터 */
import { FileExcelOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Segmented, Space, Spin, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkOrderListRow } from '../../api/workorders';
import { fetchWorkOrders } from '../../api/workorders';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';
import { WORK_ORDER_STATUS_META } from './wo-meta';

/**
 * 탭에 노출할 상태 순서 (업무 우선순위: 손이 가야 하는 것부터).
 * 필터는 클라이언트에서 건다 — 백엔드 status 필터는 WAITING을 400으로 막지만
 * 목록 응답에는 WAITING 행이 섞여 오므로, 받아온 뒤 거르는 편이 화면과 일치한다.
 */
const FILTER_STATUSES = ['UNORDERED', 'REPRINT_NEEDED', 'CURRENT', 'WAITING'] as const;

/** 탭 라벨: 색 점 + 상태명 + 건수 (구현표준 §2 — 색만으로 구분하지 않는다) */
function FilterTabLabel({ label, color, count }: { label: string; color?: string; count: number }) {
  return (
    <Space size={8} style={{ padding: '4px 6px', fontSize: 15 }}>
      {color ? <Badge color={color} /> : null}
      <span>{label}</span>
      <Typography.Text type="secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {count}
      </Typography.Text>
    </Space>
  );
}

export function WorkOrderListPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<string>('ALL');

  const { data, isLoading, error } = useQuery({
    queryKey: ['workorders', 'list'],
    queryFn: () => fetchWorkOrders(),
  });

  const rows = useMemo(() => data ?? [], [data]);
  const counts = useMemo(
    () =>
      rows.reduce<Record<string, number>>((acc, row) => {
        acc[row.status] = (acc[row.status] ?? 0) + 1;
        return acc;
      }, {}),
    [rows],
  );
  const visibleRows = filter === 'ALL' ? rows : rows.filter((row) => row.status === filter);

  const filterOptions = [
    { value: 'ALL', label: <FilterTabLabel label="전체" count={rows.length} /> },
    ...FILTER_STATUSES.map((status) => {
      const meta = metaOf(WORK_ORDER_STATUS_META, status);
      return {
        value: status,
        label: <FilterTabLabel label={meta.label} color={meta.color} count={counts[status] ?? 0} />,
      };
    }),
  ];

  const columns: ColumnsType<WorkOrderListRow> = [
    {
      title: '고객 / 주문 / 품목',
      key: 'item',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong style={{ fontSize: 16 }}>
            {row.customerName} · {row.itemLabel}
          </Typography.Text>
          <Typography.Text type="secondary">{row.orderNo}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '원단',
      dataIndex: 'fabricName',
      key: 'fabric',
      render: (fabric?: string) => fabric ?? <Typography.Text type="secondary">-</Typography.Text>,
    },
    {
      title: '상태',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (status: string) => {
        const meta = metaOf(WORK_ORDER_STATUS_META, status);
        return <StatusBadge label={meta.label} color={meta.color} />;
      },
    },
    {
      title: '최신 출력 버전 / 일시',
      key: 'latest',
      width: 200,
      render: (_, row) =>
        row.currentVersionNo ? (
          <Space direction="vertical" size={0}>
            <Typography.Text strong>V{row.currentVersionNo}</Typography.Text>
            <Typography.Text type="secondary">{row.lastIssuedAt ?? '-'}</Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: '옵션 최종 변경일',
      dataIndex: 'optionConfirmedAt',
      key: 'optionUpdatedAt',
      width: 170,
      render: (v?: string) => <Typography.Text type="secondary">{v ?? '-'}</Typography.Text>,
    },
    {
      title: '채촌 최종 변경일',
      dataIndex: 'measurementLinkedAt',
      key: 'measurementUpdatedAt',
      width: 170,
      render: (v?: string) => <Typography.Text type="secondary">{v ?? '-'}</Typography.Text>,
    },
    {
      title: '액션',
      key: 'actions',
      width: 170,
      render: (_, row) => (
        <Tooltip title={row.status === 'WAITING' ? '옵션 확정과 채촌 완료 후 출력할 수 있습니다.' : ''}>
          <Button
            type="primary"
            size="large"
            icon={<FileExcelOutlined />}
            disabled={row.status === 'WAITING'}
            onClick={() => navigate(`/work-orders/${row.orderItemId}`)}
          >
            미리보기
          </Button>
        </Tooltip>
      ),
    },
  ];

  if (error) {
    return <Alert type="error" showIcon message="작업지시서 목록을 불러오지 못했습니다." description={(error as Error).message} />;
  }

  return (
    <Card>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Typography.Title level={4} style={{ marginBottom: 4 }}>
            작업지시서
          </Typography.Title>
          <Typography.Text type="secondary">
            작업지시서 버전은 Excel 출력 시점에 생성됩니다. 마지막 출력 이후 옵션·채촌이 변경되면 재출력 필요로
            표시됩니다.
          </Typography.Text>
        </div>
        <Segmented
          size="large"
          value={filter}
          onChange={(value) => setFilter(value as string)}
          options={filterOptions}
        />
        {isLoading ? (
          <Spin style={{ display: 'block', margin: '48px auto' }} />
        ) : (
          <Table<WorkOrderListRow>
            rowKey="orderItemId"
            dataSource={visibleRows}
            locale={{ emptyText: '해당 상태의 작업지시서가 없습니다.' }}
            columns={columns}
            pagination={false}
            size="large"
            scroll={{ x: 1100 }}
          />
        )}
      </Space>
    </Card>
  );
}
