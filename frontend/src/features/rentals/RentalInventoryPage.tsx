import { PlusOutlined, SearchOutlined, StopOutlined, SwapOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { Dayjs } from 'dayjs';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  RENTAL_COMPONENT_TYPE_LABELS,
  RENTAL_ITEM_STATUS_META,
  createRentalItem,
  fetchRentalItems,
  retireRentalItem,
  type RentalComponentType,
  type RentalItem,
  type RentalItemStatus,
} from '../../api/rentals';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { DESIGN_OPTIONS, COLOR_OPTIONS, componentTypeOptions, statusOptions } from './rental-constants';

interface FilterValues {
  componentType?: RentalComponentType;
  design?: string;
  color?: string;
  skuSize?: string;
  status?: RentalItemStatus;
  availableOn?: Dayjs;
}

interface RegisterValues {
  componentType: RentalComponentType;
  design: string;
  color: string;
  size: string;
  quantity: number;
  managementCode: string;
  notes?: string;
}

/** RENT-001 렌탈 실물 재고 목록 */
export function RentalInventoryPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [filterForm] = Form.useForm<FilterValues>();
  const [registerForm] = Form.useForm<RegisterValues>();
  const [filters, setFilters] = useState<FilterValues>({});
  const [registerOpen, setRegisterOpen] = useState(false);

  const listQuery = useQuery({
    queryKey: ['rentals', 'inventory', filters],
    queryFn: () =>
      fetchRentalItems({
        componentType: filters.componentType,
        design: filters.design,
        color: filters.color,
        skuSize: filters.skuSize,
        status: filters.status,
        availableOn: filters.availableOn?.format('YYYY-MM-DD'),
        size_: 100,
      }),
  });

  const registerMutation = useMutation({
    // 계약 §5: managementCode 필수, quantity>1이면 연번 일괄 생성
    mutationFn: (v: RegisterValues) =>
      createRentalItem({
        managementCode: v.managementCode.trim(),
        componentType: v.componentType,
        design: v.design,
        color: v.color,
        size: v.size,
        quantity: v.quantity,
        notes: v.notes,
      }),
    onSuccess: (created) => {
      message.success(`렌탈 실물 ${created.length}건이 등록되었습니다.`);
      setRegisterOpen(false);
      registerForm.resetFields();
      void queryClient.invalidateQueries({ queryKey: ['rentals'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '실물 등록에 실패했습니다.'),
  });

  const retireMutation = useMutation({
    mutationFn: (id: string) => retireRentalItem(id, { reason: '재고 화면에서 사용 중지' }),
    onSuccess: () => {
      message.success('사용 중지 처리되었습니다.');
      void queryClient.invalidateQueries({ queryKey: ['rentals'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '사용 중지에 실패했습니다.'),
  });

  const quantity = Form.useWatch('quantity', registerForm) ?? 1;

  const columns: ColumnsType<RentalItem> = [
    // 사람이 아는 정보(구분·디자인·컬러·사이즈)를 앞에, 관리코드는 참고용으로 뒤에 둔다.
    {
      title: '구분',
      dataIndex: 'componentType',
      render: (c: RentalComponentType) => RENTAL_COMPONENT_TYPE_LABELS[c] ?? c,
      width: 120,
    },
    { title: '디자인', dataIndex: 'design', width: 100 },
    { title: '컬러', dataIndex: 'color', width: 90 },
    { title: '사이즈', dataIndex: 'size', width: 80 },
    {
      title: '상태',
      dataIndex: 'status',
      render: (s: RentalItemStatus) => (
        <StatusBadge label={RENTAL_ITEM_STATUS_META[s]?.label ?? s} color={RENTAL_ITEM_STATUS_META[s]?.color} />
      ),
      width: 110,
    },
    { title: '대여 가능 예정일', dataIndex: 'availableFrom', render: (d?: string) => d ?? '-', width: 130 },
    {
      title: '현재 배정 / 고객',
      key: 'allocation',
      render: (_, r) =>
        r.currentAllocation ? (
          <>
            <Typography.Text>{r.currentAllocation.customerName}</Typography.Text>{' '}
            <Typography.Text type="secondary">
              ({r.currentAllocation.orderNo} · {r.currentAllocation.pickupDate} ~ {r.currentAllocation.returnDueDate})
            </Typography.Text>
          </>
        ) : (
          '-'
        ),
    },
    {
      title: '관리코드',
      dataIndex: 'managementCode',
      render: (code: string, r) => (
        <Link to={`/rentals/${r.id}`}>
          <Typography.Text type="secondary">{code}</Typography.Text>
        </Link>
      ),
      width: 170,
    },
    {
      title: '액션',
      key: 'actions',
      width: 110,
      render: (_, r) => (
        <Can permission="RENTAL_EDIT">
          <Popconfirm
            title="사용 중지"
            description={`관리코드 ${r.managementCode}를 사용 중지하시겠습니까?`}
            okText="사용 중지"
            cancelText="취소"
            onConfirm={() => retireMutation.mutate(r.id)}
            disabled={r.status === 'RETIRED' || !!r.currentAllocation}
          >
            <Button
              size="small"
              danger
              icon={<StopOutlined />}
              disabled={r.status === 'RETIRED' || !!r.currentAllocation}
            >
              사용 중지
            </Button>
          </Popconfirm>
        </Can>
      ),
    },
  ];

  return (
    <Card>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Space wrap>
            <Can permission="RENTAL_ALLOCATE">
              <Button icon={<SwapOutlined />} onClick={() => navigate('/rentals/allocate')}>
                가용 검색·배정
              </Button>
              <Button onClick={() => navigate('/rentals/handover')}>출고·반납</Button>
            </Can>
            <Can permission="RENTAL_EDIT">
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setRegisterOpen(true)}>
                실물 등록
              </Button>
            </Can>
          </Space>
        </Space>

        <Form<FilterValues>
          form={filterForm}
          layout="inline"
          onFinish={(values) => setFilters({ ...values })}
          style={{ rowGap: 8 }}
        >
          <Form.Item name="componentType" label="구분">
            <Select allowClear placeholder="전체" style={{ width: 140 }} options={componentTypeOptions} />
          </Form.Item>
          <Form.Item name="design" label="디자인">
            <Select allowClear placeholder="전체" style={{ width: 120 }} options={DESIGN_OPTIONS} />
          </Form.Item>
          <Form.Item name="color" label="컬러">
            <Select allowClear placeholder="전체" style={{ width: 110 }} options={COLOR_OPTIONS} />
          </Form.Item>
          <Form.Item name="skuSize" label="사이즈">
            <Input allowClear placeholder="예: 100" style={{ width: 100 }} />
          </Form.Item>
          <Form.Item name="status" label="상태">
            <Select allowClear placeholder="전체" style={{ width: 130 }} options={statusOptions} />
          </Form.Item>
          <Form.Item name="availableOn" label="대여 가능일">
            <DatePicker placeholder="기준일" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" icon={<SearchOutlined />}>
              검색
            </Button>
          </Form.Item>
        </Form>

        <Table<RentalItem>
          rowKey="id"
          scroll={{ x: 'max-content' }}
          size="middle"
          loading={listQuery.isLoading}
          dataSource={listQuery.data?.data ?? []}
          columns={columns}
          pagination={{ pageSize: 30, showSizeChanger: true, pageSizeOptions: [30, 50, 100] }}
          onRow={(r) => ({ onDoubleClick: () => navigate(`/rentals/${r.id}`) })}
        />
      </Space>

      {/* 실물 등록 모달: 관리코드 필수 + 수량 2 이상이면 연번 일괄 생성 */}
      <Modal
        title="렌탈 실물 등록"
        open={registerOpen}
        onCancel={() => setRegisterOpen(false)}
        onOk={() => registerForm.submit()}
        okText="등록"
        cancelText="취소"
        confirmLoading={registerMutation.isPending}
        destroyOnClose
      >
        <Form<RegisterValues>
          form={registerForm}
          layout="vertical"
          initialValues={{ quantity: 1, design: '클래식A', color: 'BLACK' }}
          onFinish={(values) => registerMutation.mutate(values)}
        >
          <Form.Item name="componentType" label="구분" rules={[{ required: true, message: '구분을 선택해 주세요.' }]}>
            <Select placeholder="구분 선택" options={componentTypeOptions} />
          </Form.Item>
          <Form.Item name="design" label="디자인" rules={[{ required: true, message: '디자인을 선택해 주세요.' }]}>
            <Select options={DESIGN_OPTIONS} />
          </Form.Item>
          <Form.Item name="color" label="컬러" rules={[{ required: true, message: '컬러를 선택해 주세요.' }]}>
            <Select options={COLOR_OPTIONS} />
          </Form.Item>
          <Form.Item name="size" label="사이즈" rules={[{ required: true, message: '사이즈를 입력해 주세요.' }]}>
            <Input placeholder="예: 100, 32, 270" />
          </Form.Item>
          <Form.Item
            name="managementCode"
            label="관리코드"
            rules={[{ required: true, message: '관리코드를 입력해 주세요.' }]}
            extra={
              quantity > 1
                ? '수량이 2 이상이면 입력한 관리코드 뒤에 -001, -002… 연번이 붙습니다.'
                : undefined
            }
          >
            <Input placeholder="예: JKT-BLK-100-004" />
          </Form.Item>
          <Form.Item
            name="quantity"
            label="등록 수량 (2 이상이면 동일 속성으로 일괄 생성)"
            rules={[{ required: true, message: '수량을 입력해 주세요.' }]}
          >
            <InputNumber min={1} max={50} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="notes" label="메모">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
