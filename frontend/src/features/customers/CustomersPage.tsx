import { FilterOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Empty, Input, Radio, Segmented, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchCustomers, type CustomerListItem } from '../../api/customers';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { autoWidth } from '../../shared/table-width';
import { CustomerRegisterModal } from './CustomerRegisterModal';
import { TRANSACTION_TYPE_LABEL, formatAmount } from './customer-constants';

/** 진행 journey 상태별 세부 단계 배지 색상 (진행상태 재정의 02) */
const JOURNEY_STATUS_COLOR: Record<'ACTIVE' | 'COMPLETED' | 'CANCELLED', string> = {
  ACTIVE: 'processing',
  COMPLETED: 'green',
  CANCELLED: 'default',
};

/**
 * CUST-001 고객 목록 (설계서 07 §2).
 * 기본은 계약을 한 건이라도 보유한 고객(작성중·취소 포함). [전체 고객]으로 계약 전 고객도 본다.
 */
export function CustomersPage() {
  const navigate = useNavigate();

  const [keyword, setKeyword] = useState('');
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'CONTRACT' | 'ALL'>('CONTRACT');
  const [transactionType, setTransactionType] = useState<'CUSTOM' | 'RENTAL' | undefined>(undefined);
  const [progress, setProgress] = useState<'ACTIVE' | 'DONE' | 'ALL'>('ALL');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(30);
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['customers', { q, scope, transactionType: transactionType ?? '', progress, page, size }],
    queryFn: () => fetchCustomers({ q, scope, transactionType, progress, page, size }),
  });

  const runSearch = () => {
    setPage(1);
    setQ(keyword.trim());
  };

  const columns: ColumnsType<CustomerListItem> = [
    { title: '고객명', dataIndex: 'name', ...autoWidth(100) },
    { title: '전화번호', dataIndex: 'phone', ...autoWidth() },
    {
      title: '최근 방문일',
      dataIndex: 'lastVisitDate',
      ...autoWidth(),
      render: (v?: string) => v ?? '-',
    },
    {
      title: '최근 거래 유형',
      dataIndex: 'lastTransactionType',
      ...autoWidth(),
      // 필터 버튼을 제목 글자 바로 옆에 배치 (index.css의 tx-type-filter-col) — 서버(transactionType)로 필터링
      className: 'tx-type-filter-col',
      filteredValue: transactionType ? [transactionType] : null,
      filterIcon: (filtered) => <FilterOutlined style={{ color: filtered ? '#1677ff' : undefined }} />,
      filterDropdown: ({ confirm }) => (
        <div style={{ padding: 8 }}>
          <Radio.Group
            value={transactionType ?? 'ALL'}
            onChange={(e) => {
              const v = e.target.value as 'ALL' | 'CUSTOM' | 'RENTAL';
              setTransactionType(v === 'ALL' ? undefined : v);
              setPage(1);
              confirm({ closeDropdown: true });
            }}
          >
            <Space direction="vertical">
              <Radio value="ALL">전체</Radio>
              <Radio value="RENTAL">렌탈</Radio>
              <Radio value="CUSTOM">맞춤</Radio>
            </Space>
          </Radio.Group>
        </div>
      ),
      render: (v?: 'CUSTOM' | 'RENTAL') => (v ? TRANSACTION_TYPE_LABEL[v] : '-'),
    },
    {
      title: '고객 상태',
      dataIndex: 'customerStatus',
      ...autoWidth(120),
      // 계약상태 배지는 제외하고 진행 journey의 세부 단계(진행상태)만 출력
      render: (_v: CustomerListItem['customerStatus'], row) =>
        row.currentStage ? (
          <StatusBadge
            label={row.currentStage.name}
            color={JOURNEY_STATUS_COLOR[row.currentStage.status] ?? 'default'}
          />
        ) : (
          '-'
        ),
    },
    {
      title: '계약 건수',
      dataIndex: 'contractCount',
      ...autoWidth(),
      align: 'right',
      render: (v: number) => `${v}건`,
    },
    {
      title: '잔금',
      dataIndex: 'balanceAmount',
      ...autoWidth(),
      align: 'right',
      render: (v: number) => formatAmount(v),
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
            {/* 예약 등록이 곧 고객 등록이므로(설계서 07 D2) 별도 [예약 고객 등록] 경로는 없앴다 */}
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
          {/* 조회 범위(설계서 07 D3): 계약 보유 고객 / 전 고객 */}
          <Segmented<'CONTRACT' | 'ALL'>
            value={scope}
            onChange={(v) => {
              setScope(v);
              setPage(1);
            }}
            options={[
              { label: '계약 고객', value: 'CONTRACT' },
              { label: '전체 고객', value: 'ALL' },
            ]}
          />
          {/* 진행상태 검색(설계서 06 §2 / 02): 진행중/완료/전체 */}
          <Segmented<'ACTIVE' | 'DONE' | 'ALL'>
            value={progress}
            onChange={(v) => {
              setProgress(v);
              setPage(1);
            }}
            options={[
              { label: '전체', value: 'ALL' },
              { label: '진행중', value: 'ACTIVE' },
              { label: '완료', value: 'DONE' },
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
          locale={{ emptyText: <Empty description="조건에 해당하는 고객이 없습니다." /> }}
        />
      </Space>

      <CustomerRegisterModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onGoDetail={(id) => navigate(`/customers/${id}`)}
        // 방금 등록한 고객은 계약이 없어 기본 범위(계약 고객)에서 보이지 않는다.
        // 등록 직후 사라지는 것처럼 보이지 않게 범위를 전체로 넓혀 둔다(설계서 07 §2.3).
        onRegistered={() => setScope('ALL')}
      />
    </Card>
  );
}
