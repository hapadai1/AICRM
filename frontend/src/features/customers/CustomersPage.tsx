import { FilterOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Checkbox, Empty, Input, Radio, Space } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LAYOUT } from '../../app/theme';
import { fetchCustomers, type CustomerListItem } from '../../api/customers';
import { Can } from '../../shared/Can';
import { DataTable } from '../../shared/DataTable';
import { ListToolbar, PageCard, PageShell } from '../../shared/PageShell';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';
import { COL } from '../../shared/table-width';
import { CustomerRegisterModal } from './CustomerRegisterModal';
import { CUSTOMER_STATUS_META, TRANSACTION_TYPE_LABEL } from './customer-constants';

/**
 * CUST-001 고객 목록 (설계서 07 §2).
 * 기본은 계약을 한 건이라도 보유한 고객(작성중·취소 포함). [전체 고객] 체크로 계약 전 고객도 본다.
 */
export function CustomersPage() {
  const navigate = useNavigate();

  const [keyword, setKeyword] = useState('');
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'CONTRACT' | 'ALL'>('CONTRACT');
  const [transactionType, setTransactionType] = useState<'CUSTOM' | 'RENTAL' | undefined>(undefined);
  const [status, setStatus] = useState<'PROSPECT' | 'CONTRACTED' | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(30);
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['customers', { q, scope, transactionType: transactionType ?? '', status: status ?? '', page, size }],
    queryFn: () => fetchCustomers({ q, scope, transactionType, status, page, size }),
  });

  const runSearch = () => {
    setPage(1);
    setQ(keyword.trim());
  };

  const columns: ColumnsType<CustomerListItem> = [
    { title: '고객명', dataIndex: 'name', width: COL.name },
    { title: '전화번호', dataIndex: 'phone', width: COL.code },
    {
      title: '최근 방문일',
      dataIndex: 'lastVisitDate',
      width: COL.name,
      render: (v?: string) => v ?? '-',
    },
    {
      title: '최근 거래 유형',
      dataIndex: 'lastTransactionType',
      width: COL.status,
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
      width: COL.status,
      // 최근 거래 유형과 동일하게 제목 옆 필터로 서버(status) 필터링. 비활성은 목록에서 항상 제외.
      className: 'tx-type-filter-col',
      filteredValue: status ? [status] : null,
      filterIcon: (filtered) => <FilterOutlined style={{ color: filtered ? '#1677ff' : undefined }} />,
      filterDropdown: ({ confirm }) => (
        <div style={{ padding: 8 }}>
          <Radio.Group
            value={status ?? 'ALL'}
            onChange={(e) => {
              const v = e.target.value as 'ALL' | 'PROSPECT' | 'CONTRACTED';
              setStatus(v === 'ALL' ? undefined : v);
              setPage(1);
              confirm({ closeDropdown: true });
            }}
          >
            <Space direction="vertical">
              <Radio value="ALL">전체</Radio>
              <Radio value="CONTRACTED">{CUSTOMER_STATUS_META.CONTRACTED.label}</Radio>
              <Radio value="PROSPECT">{CUSTOMER_STATUS_META.PROSPECT.label}</Radio>
            </Space>
          </Radio.Group>
        </div>
      ),
      render: (v: CustomerListItem['customerStatus']) => {
        const m = metaOf(CUSTOMER_STATUS_META, v);
        return <StatusBadge label={m.label} color={m.color} />;
      },
    },
    {
      title: '계약 건수',
      dataIndex: 'contractCount',
      width: COL.count,
      align: 'right',
      render: (v: number) => `${v}건`,
    },
  ];

  return (
    <PageShell>
      <PageCard>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <ListToolbar
            filters={
              <>
                <Input
                  style={{ width: LAYOUT.searchWidth }}
                  placeholder="고객명 / 전화번호 / 주문번호 검색"
                  prefix={<SearchOutlined />}
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  onPressEnter={runSearch}
                  allowClear
                />
                <Button icon={<SearchOutlined />} onClick={runSearch}>
                  검색
                </Button>
                {/* 조회 범위(설계서 07 D3): 기본은 계약 보유 고객, 체크하면 계약 전 고객까지 */}
                <Checkbox
                  checked={scope === 'ALL'}
                  onChange={(e) => {
                    setScope(e.target.checked ? 'ALL' : 'CONTRACT');
                    setPage(1);
                  }}
                >
                  전체 고객
                </Checkbox>
              </>
            }
            actions={
              <Can permission="CUSTOMER_EDIT">
                {/* 예약 등록이 곧 고객 등록이므로(설계서 07 D2) 별도 [예약 고객 등록] 경로는 없앴다 */}
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                  고객 등록
                </Button>
              </Can>
            }
          />

          <DataTable<CustomerListItem>
            rowKey="id"
            loading={isLoading}
            columns={columns}
            dataSource={data?.data ?? []}
            totalUnit="명"
            pagination={{
              current: page,
              pageSize: size,
              total: data?.page.totalElements ?? 0,
              onChange: (p, s) => {
                setPage(p);
                setSize(s);
              },
            }}
            onRow={(r) => ({ onClick: () => navigate(`/customers/${r.id}`), style: { cursor: 'pointer' } })}
            locale={{ emptyText: <Empty description="조건에 해당하는 고객이 없습니다." /> }}
          />
        </Space>
      </PageCard>

      <CustomerRegisterModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onGoDetail={(id) => navigate(`/customers/${id}`)}
        // 방금 등록한 고객은 계약이 없어 기본 범위(계약 고객)에서 보이지 않는다.
        // 등록 직후 사라지는 것처럼 보이지 않게 범위를 전체로 넓혀 둔다(설계서 07 §2.3).
        onRegistered={() => setScope('ALL')}
      />
    </PageShell>
  );
}
