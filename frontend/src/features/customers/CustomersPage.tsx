import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Empty, Input, Segmented, Space, Switch, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchCustomers, type CustomerListItem } from '../../api/customers';
import { useAuthStore } from '../../app/auth-store';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { CustomerRegisterModal } from './CustomerRegisterModal';
import { CUSTOMER_STATUS_META, TRANSACTION_TYPE_LABEL, formatAmount } from './customer-constants';
import { metaOf } from '../../shared/status-meta';

/** CUST-001 고객 목록: 기본 CONTRACTED만, 미계약 포함 토글, 통합 검색 */
export function CustomersPage() {
  const navigate = useNavigate();
  const canViewPayment = useAuthStore((s) => s.user?.permissions.includes('PAYMENT_VIEW') ?? false);

  const [keyword, setKeyword] = useState('');
  const [q, setQ] = useState('');
  const [includeProspect, setIncludeProspect] = useState(false);
  const [transactionType, setTransactionType] = useState<'CUSTOM' | 'RENTAL' | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(30);
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['customers', { q, includeProspect, transactionType: transactionType ?? '', page, size }],
    queryFn: () => fetchCustomers({ q, includeProspect, transactionType, page, size }),
  });

  const runSearch = () => {
    setPage(1);
    setQ(keyword.trim());
  };

  const columns: ColumnsType<CustomerListItem> = [
    { title: '고객명', dataIndex: 'name', width: 120 },
    { title: '전화번호', dataIndex: 'phone', width: 140 },
    {
      title: '최근 방문일',
      dataIndex: 'lastVisitDate',
      width: 120,
      render: (v?: string) => v ?? '-',
    },
    {
      title: '최근 거래 유형',
      dataIndex: 'lastTransactionType',
      width: 120,
      render: (v?: 'CUSTOM' | 'RENTAL') => (v ? TRANSACTION_TYPE_LABEL[v] : '-'),
    },
    {
      title: '고객 상태',
      dataIndex: 'customerStatus',
      width: 100,
      render: (v: CustomerListItem['customerStatus']) => (
        <StatusBadge label={metaOf(CUSTOMER_STATUS_META, v).label} color={metaOf(CUSTOMER_STATUS_META, v).color} />
      ),
    },
    {
      title: '계약 건수',
      dataIndex: 'contractCount',
      width: 100,
      align: 'right',
      render: (v: number) => `${v}건`,
    },
    {
      title: '잔금',
      dataIndex: 'balanceAmount',
      width: 140,
      align: 'right',
      // 결제 금액은 PAYMENT_VIEW 권한이 없으면 마스킹 (문서 03 §5.1)
      render: (v: number) => (canViewPayment ? formatAmount(v) : '***'),
    },
  ];

  return (
    <Card>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            목록
          </Typography.Title>
          <Can permission="CUSTOMER_EDIT">
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              고객 등록
            </Button>
          </Can>
        </Space>

        <Space wrap>
          <Input
            style={{ width: 280 }}
            placeholder="고객명 / 전화번호 / 주문번호 검색"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onPressEnter={runSearch}
            allowClear
          />
          <Button icon={<SearchOutlined />} onClick={runSearch}>
            검색
          </Button>
          <Space size={6}>
            <Switch
              checked={includeProspect}
              onChange={(v) => {
                setIncludeProspect(v);
                setPage(1);
              }}
            />
            <Typography.Text>미계약 포함</Typography.Text>
          </Space>
          <Segmented
            value={transactionType ?? 'ALL'}
            onChange={(v) => {
              setTransactionType(v === 'ALL' ? undefined : (v as 'CUSTOM' | 'RENTAL'));
              setPage(1);
            }}
            options={[
              { value: 'ALL', label: '전체' },
              { value: 'RENTAL', label: '렌탈' },
              { value: 'CUSTOM', label: '맞춤' },
            ]}
          />
        </Space>

        <Table<CustomerListItem>
          rowKey="id"
          scroll={{ x: 'max-content' }}
          size="middle"
          loading={isLoading}
          columns={columns}
          dataSource={data?.data ?? []}
          pagination={{
            current: page,
            pageSize: size,
            total: data?.page.totalElements ?? 0,
            showSizeChanger: true,
            pageSizeOptions: [30, 50, 100],
            onChange: (p, s) => {
              setPage(p);
              setSize(s);
            },
            showTotal: (total) => `총 ${total}명`,
          }}
          onRow={(r) => ({ onClick: () => navigate(`/customers/${r.id}`), style: { cursor: 'pointer' } })}
          locale={{
            emptyText: (
              <Empty
                description={
                  includeProspect ? '조건에 해당하는 고객이 없습니다.' : '계약 고객이 없습니다. 미계약 포함을 켜면 예약 고객도 조회됩니다.'
                }
              />
            ),
          }}
        />
      </Space>

      <CustomerRegisterModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onGoDetail={(id) => navigate(`/customers/${id}`)}
      />
    </Card>
  );
}
