/**
 * 고객 검색 팝업 (공용)
 * - "업무의 시작은 고객" — 결제·계약 등 목록 화면에서 고객을 먼저 특정할 때 사용한다
 * - 이름 또는 전화번호로 검색하고, 행을 클릭하면 선택된다
 */
import { SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Input, Modal, Space, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useState } from 'react';
import { fetchCustomers } from '../api/customers';
import type { CustomerListItem } from '../api/customers';

/** 호출부가 필요한 최소 정보 */
export interface PickedCustomer {
  id: string;
  name: string;
  phone: string;
}

interface Props {
  open: boolean;
  onCancel: () => void;
  onSelect: (customer: PickedCustomer) => void;
  /** 기본 검색어(예: 목록 화면에 이미 입력된 키워드) */
  initialKeyword?: string;
  title?: string;
}

export function CustomerPickerModal({
  open,
  onCancel,
  onSelect,
  initialKeyword = '',
  title = '고객 검색',
}: Props) {
  const [keyword, setKeyword] = useState(initialKeyword);
  const [q, setQ] = useState(initialKeyword);
  const [page, setPage] = useState(1);

  // 팝업을 다시 열 때는 호출부의 현재 키워드로 초기화한다.
  useEffect(() => {
    if (open) {
      setKeyword(initialKeyword);
      setQ(initialKeyword);
      setPage(1);
    }
  }, [open, initialKeyword]);

  const { data, isFetching } = useQuery({
    // 계약 유무와 무관한 전 고객이 검색 대상이다 — 첫 계약을 쓰려는 고객이 여기서 빠지면 안 된다.
    queryKey: ['customers', 'picker', { q, page }],
    queryFn: () => fetchCustomers({ q, scope: 'ALL', page, size: 10 }),
    enabled: open,
  });

  const runSearch = () => {
    setPage(1);
    setQ(keyword.trim());
  };

  const columns: ColumnsType<CustomerListItem> = [
    { title: '고객명', dataIndex: 'name', width: 110 },
    { title: '전화번호', dataIndex: 'phone', width: 140 },
    // 미계약/계약 상태 열은 제거했다 — 가망/계약 고객 구분 폐기(설계서 07 D8).
    { title: '최근 방문일', dataIndex: 'lastVisitDate', width: 110, render: (v?: string) => v ?? '-' },
    { title: '계약', dataIndex: 'contractCount', width: 70, align: 'right', render: (v: number) => `${v}건` },
  ];

  return (
    <Modal title={title} open={open} onCancel={onCancel} footer={null} width={880} destroyOnClose>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Input
          allowClear
          autoFocus
          style={{ width: 320 }}
          placeholder="고객명 또는 전화번호"
          prefix={<SearchOutlined />}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={runSearch}
        />
        <Table<CustomerListItem>
          rowKey="id"
          scroll={{ x: 'max-content' }}
          size="small"
          loading={isFetching}
          dataSource={data?.data ?? []}
          columns={columns}
          onRow={(row) => ({
            style: { cursor: 'pointer' },
            onClick: () => onSelect({ id: row.id, name: row.name, phone: row.phone }),
          })}
          pagination={{
            current: page,
            pageSize: 10,
            total: data?.page.totalElements ?? 0,
            showSizeChanger: false,
            showTotal: (total) => `총 ${total}명`,
            onChange: setPage,
          }}
          locale={{ emptyText: '검색 결과가 없습니다.' }}
        />
      </Space>
    </Modal>
  );
}
