/** PROD-001 계약별 제작·입출고 목록 — 계약 단위로 묶어 표시, 열기 시 계약 제작·입출고 화면으로 진입 */
import { RightCircleOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Input, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fetchProductionItems, type ProductionItem } from '../../api/production';

interface ContractRow {
  contractId: string;
  contractNo: string;
  customerName: string;
  itemCount: number;
  receivedCount: number;
  releasedCount: number;
}

function groupByContract(items: ProductionItem[]): ContractRow[] {
  const map = new Map<string, ContractRow>();
  for (const it of items) {
    const row = map.get(it.contractId) ?? {
      contractId: it.contractId,
      contractNo: it.contractNo,
      customerName: it.customerName,
      itemCount: 0,
      receivedCount: 0,
      releasedCount: 0,
    };
    row.itemCount += 1;
    if (it.itemStatus === 'RECEIVED' || it.itemStatus === 'RELEASED' || it.itemStatus === 'COMPLETED')
      row.receivedCount += 1;
    if (it.itemStatus === 'RELEASED' || it.itemStatus === 'COMPLETED') row.releasedCount += 1;
    map.set(it.contractId, row);
  }
  return [...map.values()].sort((a, b) => b.contractNo.localeCompare(a.contractNo));
}

export function ProductionPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const keyword = searchParams.get('q') ?? '';

  const itemsQuery = useQuery({ queryKey: ['production', 'items'], queryFn: () => fetchProductionItems() });

  const rows = useMemo(() => {
    const grouped = groupByContract(itemsQuery.data ?? []);
    const q = keyword.trim().toLowerCase();
    if (!q) return grouped;
    return grouped.filter((r) => [r.contractNo, r.customerName].some((v) => v?.toLowerCase().includes(q)));
  }, [itemsQuery.data, keyword]);

  const columns: ColumnsType<ContractRow> = [
    {
      title: '계약',
      key: 'contract',
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong style={{ fontSize: 15 }}>
            {r.contractNo}
          </Typography.Text>
          <Typography.Text type="secondary">{r.customerName}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '품목',
      key: 'items',
      width: 200,
      render: (_, r) => (
        <Space>
          <Typography.Text>{r.itemCount}건</Typography.Text>
          {r.releasedCount === r.itemCount ? (
            <Tag color="green">전체 출고</Tag>
          ) : r.receivedCount === r.itemCount ? (
            <Tag color="gold">전체 입고</Tag>
          ) : (
            <Tag color="blue">입고 {r.receivedCount}/{r.itemCount}</Tag>
          )}
        </Space>
      ),
    },
    {
      title: '액션',
      key: 'actions',
      width: 140,
      render: (_, r) => (
        <Button
          type="primary"
          icon={<RightCircleOutlined />}
          onClick={() => navigate(`/contracts/${r.contractId}/production`)}
        >
          열기
        </Button>
      ),
    },
  ];

  if (itemsQuery.error) {
    return (
      <Alert
        type="error"
        showIcon
        message="제작·입출고 목록을 불러오지 못했습니다."
        description={(itemsQuery.error as Error).message}
      />
    );
  }

  return (
    <Card>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Typography.Title level={4} style={{ marginBottom: 4 }}>
            계약별 제작·입출고
          </Typography.Title>
          <Typography.Text type="secondary">
            계약을 열어 품목별 제작 요청·구성품 입출고·가봉을 관리합니다.
          </Typography.Text>
        </div>
        <Input.Search
          allowClear
          style={{ maxWidth: 320 }}
          placeholder="계약번호 · 고객명 검색"
          defaultValue={keyword}
          onSearch={(v) => {
            const next = new URLSearchParams(searchParams);
            if (v.trim()) next.set('q', v.trim());
            else next.delete('q');
            setSearchParams(next, { replace: true });
          }}
        />
        <Table<ContractRow>
          rowKey="contractId"
          scroll={{ x: 'max-content' }}
          size="large"
          loading={itemsQuery.isLoading}
          dataSource={rows}
          columns={columns}
          pagination={false}
          locale={{ emptyText: '제작 대상 품목이 있는 계약이 없습니다.' }}
        />
      </Space>
    </Card>
  );
}
