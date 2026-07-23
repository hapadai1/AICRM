import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Empty, Form, Input, Modal, Segmented, Space, Switch, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  createCustomer,
  fetchCustomers,
  type CustomerListItem,
  type CustomerSaveBody,
} from '../../api/customers';
import { useAuthStore } from '../../app/auth-store';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { CUSTOMER_STATUS_META, TRANSACTION_TYPE_LABEL, formatAmount } from './customer-constants';
import { metaOf } from '../../shared/status-meta';

/** CUST-001 고객 목록: 기본 CONTRACTED만, 미계약 포함 토글, 통합 검색 */
export function CustomersPage() {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const canViewPayment = useAuthStore((s) => s.user?.permissions.includes('PAYMENT_VIEW') ?? false);

  const [keyword, setKeyword] = useState('');
  const [q, setQ] = useState('');
  const [includeProspect, setIncludeProspect] = useState(false);
  const [transactionType, setTransactionType] = useState<'CUSTOM' | 'RENTAL' | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(30);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm<CustomerSaveBody>();

  const { data, isLoading } = useQuery({
    queryKey: ['customers', { q, includeProspect, transactionType: transactionType ?? '', page, size }],
    queryFn: () => fetchCustomers({ q, includeProspect, transactionType, page, size }),
  });

  const createMutation = useMutation({
    mutationFn: (body: CustomerSaveBody) => createCustomer(body),
    onSuccess: (created) => {
      message.success(`고객 "${created.name}"을(를) 등록했습니다.`);
      setCreateOpen(false);
      createForm.resetFields();
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
    onError: (e) => {
      // 동일 전화번호 활성 고객은 차단하고 기존 고객을 제시한다 (문서 03 §5.1)
      message.error(e instanceof ApiError ? e.message : '고객 등록에 실패했습니다.');
    },
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

      <Modal
        title="고객 등록"
        open={createOpen}
        okText="등록"
        cancelText="취소"
        confirmLoading={createMutation.isPending}
        onOk={() => {
          void createForm.validateFields().then((values) => createMutation.mutate(values));
        }}
        onCancel={() => setCreateOpen(false)}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" requiredMark>
          <Form.Item label="이름" name="name" rules={[{ required: true, message: '이름을 입력해 주세요.' }]}>
            <Input maxLength={30} />
          </Form.Item>
          <Form.Item
            label="전화번호"
            name="phone"
            rules={[
              { required: true, message: '전화번호를 입력해 주세요.' },
              { pattern: /^[\d-]{9,13}$/, message: '숫자와 하이픈만 입력해 주세요.' },
            ]}
          >
            <Input placeholder="010-0000-0000" maxLength={13} />
          </Form.Item>
          <Form.Item label="이메일" name="email" rules={[{ type: 'email', message: '이메일 형식이 아닙니다.' }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item label="메모" name="notes">
            <Input.TextArea rows={3} maxLength={1000} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
