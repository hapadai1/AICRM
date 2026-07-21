import { PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Flex, Input, Select, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CONTRACT_FILTER_STATUSES,
  fetchContracts,
  type ContractListItem,
  type ContractStatus,
} from '../../api/contracts';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { CONTRACT_STATUS_META, formatKrw, metaOf } from './labels';

/** 계약 목록 — 계약·주문 메뉴 진입점 (문서에 없는 내비게이션용 간단 목록) */

/**
 * 필터 옵션은 백엔드가 허용하는 상태만 사용한다.
 * 라벨 맵 전체(COMPLETED 포함)를 옵션으로 쓰면 400을 받는다.
 */
const STATUS_OPTIONS = CONTRACT_FILTER_STATUSES.map((value) => ({
  value,
  label: metaOf(CONTRACT_STATUS_META, value).label,
}));

export function ContractListPage() {
  const navigate = useNavigate();
  const [keyword, setKeyword] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<ContractStatus | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(30);

  const { data, isLoading } = useQuery({
    queryKey: ['contracts', { q, status, page, size }],
    queryFn: () => fetchContracts({ q: q || undefined, status, page, size }),
  });

  const columns: ColumnsType<ContractListItem> = [
    {
      title: '계약번호',
      dataIndex: 'contractNo',
      width: 160,
      render: (v: string) => <Typography.Text strong>{v}</Typography.Text>,
    },
    { title: '고객', dataIndex: 'customerName', width: 110 },
    { title: '계약 구분', dataIndex: 'contractTypeName', width: 170 },
    {
      title: '상태',
      dataIndex: 'status',
      width: 110,
      render: (v: string) => {
        const meta = metaOf(CONTRACT_STATUS_META, v);
        return <StatusBadge label={meta.label} color={meta.color} />;
      },
    },
    // 목록 응답의 currentVersion 에는 합계 금액만 있다. 계약금·잔금은 계약 상세에서 확인한다.
    { title: '합계 금액', dataIndex: 'totalAmount', width: 130, align: 'right', render: formatKrw },
    { title: '계약일', dataIndex: 'contractedAt', width: 110, render: (v?: string) => v ?? '-' },
    { title: '완료 예정일', dataIndex: 'completionDueDate', width: 110, render: (v?: string) => v ?? '-' },
  ];

  return (
    <Card>
      <Flex justify="space-between" align="center" wrap gap={12} style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          계약 목록
        </Typography.Title>
        <Space wrap>
          <Can permission="CONTRACT_TYPE_EDIT">
            <Button icon={<SettingOutlined />} onClick={() => navigate('/admin/contract-types')}>
              계약 구분 관리
            </Button>
          </Can>
          <Can permission="CONTRACT_CREATE">
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/contracts/new')}>
              신규 계약
            </Button>
          </Can>
        </Space>
      </Flex>

      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search
          allowClear
          placeholder="계약번호·고객명·계약 구분 검색"
          style={{ width: 280 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onSearch={(value) => {
            setQ(value.trim());
            setPage(1);
          }}
        />
        <Select
          allowClear
          placeholder="상태 전체"
          style={{ width: 140 }}
          options={STATUS_OPTIONS}
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
        />
      </Space>

      <Table
        rowKey="id"
        loading={isLoading}
        columns={columns}
        dataSource={data?.data ?? []}
        scroll={{ x: 900 }}
        onRow={(record) => ({
          onClick: () => navigate(`/contracts/${record.id}`),
          style: { cursor: 'pointer' },
        })}
        pagination={{
          current: page,
          pageSize: size,
          total: data?.page.totalElements ?? 0,
          showSizeChanger: true,
          pageSizeOptions: ['30', '50', '100'],
          showTotal: (total) => `총 ${total}건`,
          onChange: (nextPage, nextSize) => {
            setPage(nextSize !== size ? 1 : nextPage);
            setSize(nextSize);
          },
        }}
      />
    </Card>
  );
}
