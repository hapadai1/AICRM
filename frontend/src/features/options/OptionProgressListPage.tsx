/** OPT-001 계약별 제품 옵션 진행 목록 — 계약 단위로 묶어 표시, 열기 시 계약 제품옵션 화면으로 진입 */
import { RightCircleOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Progress, Space, Spin, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router-dom';
import type { OptionProgressItem } from '../../api/options';
import { fetchOptionProgress } from '../../api/options';

interface ContractRow {
  contractId: string;
  contractNo: string;
  customerName: string;
  itemCount: number;
  confirmedCount: number;
  completedStages: number;
  totalStages: number;
}

function groupByContract(items: OptionProgressItem[]): ContractRow[] {
  const map = new Map<string, ContractRow>();
  for (const it of items) {
    const row = map.get(it.contractId) ?? {
      contractId: it.contractId,
      contractNo: it.contractNo,
      customerName: it.customerName,
      itemCount: 0,
      confirmedCount: 0,
      completedStages: 0,
      totalStages: 0,
    };
    row.itemCount += 1;
    if (it.status === 'CONFIRMED') row.confirmedCount += 1;
    row.completedStages += it.completedStages;
    row.totalStages += it.totalStages;
    map.set(it.contractId, row);
  }
  return [...map.values()].sort((a, b) => b.contractNo.localeCompare(a.contractNo));
}

export function OptionProgressListPage() {
  const navigate = useNavigate();

  const { data, isLoading, error } = useQuery({
    queryKey: ['options', 'progress'],
    queryFn: () => fetchOptionProgress(),
  });

  const rows = groupByContract(data ?? []);

  const columns: ColumnsType<ContractRow> = [
    {
      title: '계약',
      key: 'contract',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong style={{ fontSize: 15 }}>
            {row.contractNo}
          </Typography.Text>
          <Typography.Text type="secondary">{row.customerName}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '맞춤 품목',
      key: 'items',
      width: 160,
      render: (_, row) => (
        <Space>
          <Typography.Text>{row.itemCount}건</Typography.Text>
          {row.confirmedCount === row.itemCount ? (
            <Tag color="green">전체 확정</Tag>
          ) : (
            <Tag color="blue">확정 {row.confirmedCount}/{row.itemCount}</Tag>
          )}
        </Space>
      ),
    },
    {
      title: '진행률',
      key: 'progress',
      width: 220,
      render: (_, row) => (
        <Space>
          <Progress
            percent={row.totalStages ? Math.round((row.completedStages / row.totalStages) * 100) : 0}
            size="small"
            style={{ width: 120 }}
            showInfo={false}
          />
          <Typography.Text>
            {row.completedStages}/{row.totalStages} 단계
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '액션',
      key: 'actions',
      width: 140,
      render: (_, row) => (
        <Button
          type="primary"
          icon={<RightCircleOutlined />}
          onClick={() => navigate(`/contracts/${row.contractId}/options`)}
        >
          열기
        </Button>
      ),
    },
  ];

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message="옵션 진행 목록을 불러오지 못했습니다."
        description={(error as Error).message}
      />
    );
  }

  return (
    <Card>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Typography.Title level={4} style={{ marginBottom: 4 }}>
            계약별 제품 옵션
          </Typography.Title>
          <Typography.Text type="secondary">
            계약을 열어 맞춤 품목별로 원단·옵션을 선택합니다. 렌탈 품목은 옵션 대상이 아닙니다.
          </Typography.Text>
        </div>
        {isLoading ? (
          <Spin style={{ display: 'block', margin: '48px auto' }} />
        ) : (
          <Table<ContractRow>
            rowKey="contractId"
            scroll={{ x: 'max-content' }}
            dataSource={rows}
            columns={columns}
            pagination={false}
            size="large"
            locale={{ emptyText: '옵션 대상 맞춤 품목이 있는 계약이 없습니다.' }}
          />
        )}
      </Space>
    </Card>
  );
}
