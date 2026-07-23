import { ArrowLeftOutlined, EditOutlined, FileAddOutlined, StopOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Result,
  Row,
  Space,
  Spin,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Appointment, Consultation } from '../../api/appointments';
import { ApiError } from '../../api/client';
import { COMPONENT_TYPE_LABELS } from '../../api/code-labels';
import {
  deactivateCustomer,
  fetchCustomer,
  updateCustomer,
  type CustomerComponentRow,
  type CustomerContractRow,
  type CustomerMeasurementRow,
  type CustomerOrderRow,
  type CustomerPaymentRow,
  type CustomerRepairRow,
  type CustomerSaveBody,
} from '../../api/customers';
import { PAYMENT_TYPE_LABEL, type PaymentType } from '../../api/payments';
import { useAuthStore } from '../../app/auth-store';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { APPT_STATUS_META, SOURCE_META } from '../appointments/appointment-constants';
import { JourneyCard } from '../journeys/JourneyCard';
import { CUSTOMER_STATUS_META, TRANSACTION_TYPE_LABEL, formatAmount } from './customer-constants';
import { metaOf } from '../../shared/status-meta';

/** 업무 상태 코드의 한국어 표시명 (없는 코드는 원문 표기) */
const STATUS_LABEL: Record<string, string> = {
  DRAFT: '초안',
  CONFIRMED: '확정',
  CHANGED: '변경',
  CANCELLED: '취소',
  COMPLETED: '완료',
  IN_PROGRESS: '진행중',
  CREATED: '생성',
  RESERVED: '배정',
  OPTION_PENDING: '옵션 대기',
  MEASUREMENT_PENDING: '채촌 대기',
  READY_TO_ORDER: '주문 준비완료',
  PRODUCTION_REQUESTED: '제작 요청',
  PRODUCTION_IN_PROGRESS: '제작중',
  PARTIALLY_RECEIVED: '부분 입고',
  RECEIVED: '입고',
  RELEASED: '출고완료',
  CHECKED_OUT: '대여중',
  RETURNED_HOLD: '반납 검수중',
  RETURNED: '반납완료',
};

/** 수선 상태는 RECEIVED가 "접수"라 공통 라벨과 다르게 표기한다. */
const REPAIR_STATUS_LABEL: Record<string, string> = {
  RECEIVED: '접수',
  IN_PROGRESS: '수선중',
  COMPLETED: '완료',
  CANCELLED: '취소',
};

const OPTION_STATUS_META: Record<string, { label: string; color: string }> = {
  NOT_STARTED: { label: '미시작', color: 'default' },
  IN_PROGRESS: { label: '진행중', color: 'blue' },
  REVIEW: { label: '확인대기', color: 'orange' },
  CONFIRMED: { label: '확정', color: 'green' },
};

// 구성품 표시명은 중앙(api/code-labels) 공유 맵을 쓴다(관리자 편집 전 화면 반영).
const COMPONENT_TYPE_LABEL = COMPONENT_TYPE_LABELS;

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  CARD: '카드',
  TRANSFER: '계좌이체',
  CASH: '현금',
};

const MEASUREMENT_TYPE_LABEL: Record<string, string> = {
  INITIAL: '최초',
  FITTING: '가봉',
  REMEASURE: '재채촌',
};

function statusLabel(code: string): string {
  return STATUS_LABEL[code] ?? code;
}

/** 요약표 탭 상단의 "해당 화면으로 이동" 링크 */
function GoToScreen({ path, label }: { path: string; label: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <Link to={path}>{label} 화면으로 이동 →</Link>
    </div>
  );
}

/** CUST-002 고객 상세: aggregate 단일 조회 + 탭 */
export function CustomerDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const canViewPayment = useAuthStore((s) => s.user?.permissions.includes('PAYMENT_VIEW') ?? false);

  const [editOpen, setEditOpen] = useState(false);
  const [editForm] = Form.useForm<CustomerSaveBody>();
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [deactivateReason, setDeactivateReason] = useState('');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['customers', id],
    queryFn: () => fetchCustomer(id),
    enabled: !!id,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['customers'] });
    void queryClient.invalidateQueries({ queryKey: ['appointments'] });
  };

  const updateMutation = useMutation({
    mutationFn: (body: CustomerSaveBody) => updateCustomer(id, body),
    onSuccess: () => {
      message.success('고객 정보를 수정했습니다.');
      setEditOpen(false);
      invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '고객 정보 수정에 실패했습니다.'),
  });

  const deactivateMutation = useMutation({
    mutationFn: (reason: string) => deactivateCustomer(id, reason),
    onSuccess: () => {
      message.success('고객을 비활성화했습니다.');
      setDeactivateOpen(false);
      setDeactivateReason('');
      invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '비활성화에 실패했습니다.'),
  });

  if (isLoading) {
    return (
      <Card style={{ textAlign: 'center', padding: 48 }}>
        <Spin />
      </Card>
    );
  }
  if (isError || !data || !data.customer) {
    return (
      <Card>
        <Result
          status="warning"
          title="고객을 찾을 수 없습니다"
          subTitle={error instanceof ApiError ? error.message : undefined}
          extra={<Button onClick={() => navigate('/customers')}>고객 목록으로</Button>}
        />
      </Card>
    );
  }

  const { customer, summary } = data;
  const statusMeta = metaOf(CUSTOMER_STATUS_META, customer.customerStatus);
  const money = (v: number) => (canViewPayment ? formatAmount(v) : '***');

  const appointmentColumns: ColumnsType<Appointment> = [
    {
      title: '예약 일시',
      dataIndex: 'startAt',
      width: 160,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD (dd) HH:mm'),
    },
    { title: '목적', dataIndex: 'purposeName', width: 110 },
    {
      title: '출처',
      dataIndex: 'source',
      width: 90,
      render: (v: Appointment['source']) => <Tag color={metaOf(SOURCE_META, v).color}>{metaOf(SOURCE_META, v).label}</Tag>,
    },
    {
      title: '상태',
      dataIndex: 'status',
      width: 100,
      render: (v: Appointment['status']) => (
        <StatusBadge label={metaOf(APPT_STATUS_META, v).label} color={metaOf(APPT_STATUS_META, v).color} />
      ),
    },
    { title: '메모', dataIndex: 'memo', ellipsis: true },
  ];

  const contractColumns: ColumnsType<CustomerContractRow> = [
    {
      title: '계약번호',
      dataIndex: 'contractNo',
      width: 150,
      render: (v: string, r) => <Link to={`/contracts/${r.id}`}>{v}</Link>,
    },
    { title: '계약 구분', dataIndex: 'contractTypeName', width: 150 },
    {
      title: '상태',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => statusLabel(v),
    },
    { title: '버전', dataIndex: 'currentVersionNo', width: 70, render: (v: number) => `v${v}` },
    { title: '계약일', dataIndex: 'contractedAt', width: 110, render: (v?: string) => v ?? '-' },
    { title: '완료예정일', dataIndex: 'completionDueDate', width: 110, render: (v?: string) => v ?? '-' },
    { title: '합계', dataIndex: 'totalAmount', align: 'right', width: 120, render: money },
    { title: '계약금', dataIndex: 'depositAmount', align: 'right', width: 120, render: money },
    { title: '잔금', dataIndex: 'balanceAmount', align: 'right', width: 120, render: money },
  ];

  const orderColumns: ColumnsType<CustomerOrderRow> = [
    {
      title: '주문번호',
      dataIndex: 'orderNo',
      width: 160,
      render: (v: string, r) => <Link to={`/orders/${r.id}`}>{v}</Link>,
    },
    { title: '계약번호', dataIndex: 'contractNo', width: 150 },
    {
      title: '거래 방식',
      dataIndex: 'transactionType',
      width: 90,
      render: (v: 'CUSTOM' | 'RENTAL') => TRANSACTION_TYPE_LABEL[v],
    },
    { title: '상태', dataIndex: 'status', width: 100, render: (v: string) => statusLabel(v) },
    { title: '완료예정일', dataIndex: 'completionDueDate', width: 110, render: (v?: string) => v ?? '-' },
    {
      title: '품목',
      dataIndex: 'items',
      render: (_, r) => (
        <Space wrap size={4}>
          {(r.items ?? []).map((i) => (
            <Tag key={i.id}>
              {i.displayName} · {statusLabel(i.status)}
            </Tag>
          ))}
        </Space>
      ),
    },
  ];

  const optionRows = data.orders
    .filter((o) => o.transactionType === 'CUSTOM')
    .flatMap((o) => (o.items ?? []).map((i) => ({ ...i, orderNo: o.orderNo })));

  const optionColumns: ColumnsType<(typeof optionRows)[number]> = [
    { title: '주문번호', dataIndex: 'orderNo', width: 160 },
    { title: '품목', dataIndex: 'displayName', width: 120 },
    {
      title: '옵션 진행',
      dataIndex: 'optionStatus',
      width: 110,
      render: (v: string) => {
        const meta = metaOf(OPTION_STATUS_META, v);
        return <StatusBadge label={meta.label} color={meta.color} />;
      },
    },
    {
      title: '채촌 연결',
      dataIndex: 'measurementLinked',
      width: 100,
      render: (v: boolean) => (v ? <Tag color="green">연결됨</Tag> : <Tag>미연결</Tag>),
    },
    {
      title: '작업지시서 출력',
      dataIndex: 'workOrderVersionCount',
      width: 130,
      render: (v: number) => (v > 0 ? `${v}회 (v${v})` : '미주문'),
    },
  ];

  const measurementColumns: ColumnsType<CustomerMeasurementRow> = [
    { title: '채촌일', dataIndex: 'date', width: 120 },
    {
      title: '구분',
      dataIndex: 'type',
      width: 90,
      render: (v: string) => MEASUREMENT_TYPE_LABEL[v] ?? v,
    },
    { title: '담당자', dataIndex: 'staffName', width: 140 },
    {
      title: '사용 주문 품목',
      dataIndex: 'usedByItems',
      render: (v?: string[]) =>
        v?.length ? (
          <Space wrap size={4}>
            {v.map((n) => (
              <Tag key={n}>{n}</Tag>
            ))}
          </Space>
        ) : (
          '-'
        ),
    },
  ];

  const componentColumns: ColumnsType<CustomerComponentRow> = [
    { title: '주문번호', dataIndex: 'orderNo', width: 160 },
    { title: '품목', dataIndex: 'itemName', width: 120 },
    {
      title: '구성품',
      dataIndex: 'componentType',
      width: 90,
      render: (v: string) => COMPONENT_TYPE_LABEL[v] ?? v,
    },
    { title: '상태', dataIndex: 'status', width: 110, render: (v: string) => statusLabel(v) },
    { title: '입고 예정일', dataIndex: 'expectedInboundDate', width: 110, render: (v?: string) => v ?? '-' },
    { title: '실제 입고일', dataIndex: 'actualInboundAt', width: 110, render: (v?: string) => v ?? '-' },
    { title: '출고일', dataIndex: 'actualOutboundAt', width: 110, render: (v?: string) => v ?? '-' },
  ];

  const rentalColumns: ColumnsType<CustomerComponentRow> = [
    { title: '주문번호', dataIndex: 'orderNo', width: 160 },
    { title: '품목', dataIndex: 'itemName', width: 130 },
    {
      title: '구성품',
      dataIndex: 'componentType',
      width: 90,
      render: (v: string) => COMPONENT_TYPE_LABEL[v] ?? v,
    },
    { title: '실물 관리 ID', dataIndex: 'rentalItemCode', width: 170, render: (v?: string) => v ?? '-' },
    { title: '상태', dataIndex: 'status', width: 110, render: (v: string) => statusLabel(v) },
  ];

  const repairColumns: ColumnsType<CustomerRepairRow> = [
    { title: '접수일', dataIndex: 'receivedDate', width: 120 },
    { title: '대상', dataIndex: 'target', width: 160 },
    { title: '수선 내용', dataIndex: 'content' },
    {
      title: '상태',
      dataIndex: 'status',
      width: 110,
      render: (v: string) => REPAIR_STATUS_LABEL[v] ?? statusLabel(v),
    },
  ];

  const paymentColumns: ColumnsType<CustomerPaymentRow> = [
    { title: '결제일', dataIndex: 'paidAt', width: 120 },
    { title: '계약번호', dataIndex: 'contractNo', width: 150 },
    {
      title: '결제 유형',
      dataIndex: 'type',
      width: 100,
      render: (v: string) => (
        <Tag color={v === 'REFUND' ? 'red' : 'blue'}>{PAYMENT_TYPE_LABEL[v as PaymentType] ?? v}</Tag>
      ),
    },
    {
      title: '결제수단',
      dataIndex: 'method',
      width: 100,
      render: (v?: string) => (v ? (PAYMENT_METHOD_LABEL[v] ?? v) : '-'),
    },
    { title: '금액', dataIndex: 'amount', align: 'right', width: 140, render: money },
  ];

  const tableCommon = {
    size: 'small' as const,
    pagination: false as const,
    // 값은 한 줄로 출력하고, 폭이 넘칠 때만 표 안에서 가로 스크롤한다.
    scroll: { x: 'max-content' as const },
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card>
        <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space wrap>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/customers')}>
              목록
            </Button>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {customer.name}
            </Typography.Title>
            <StatusBadge label={statusMeta.label} color={statusMeta.color} />
            <Typography.Text type="secondary">{customer.phone}</Typography.Text>
          </Space>
          <Space wrap>
            <Can permission="CUSTOMER_EDIT">
              <Button
                icon={<EditOutlined />}
                onClick={() => {
                  editForm.setFieldsValue({
                    name: customer.name,
                    phone: customer.phone,
                    email: customer.email,
                    notes: customer.notes,
                  });
                  setEditOpen(true);
                }}
              >
                정보 수정
              </Button>
            </Can>
            <Can permission="CONTRACT_CREATE">
              <Button
                type="primary"
                ghost
                icon={<FileAddOutlined />}
                onClick={() => navigate(`/contracts/new?customerId=${customer.id}`)}
              >
                신규 계약
              </Button>
            </Can>
            {customer.customerStatus !== 'INACTIVE' && (
              <Can permission="CUSTOMER_DEACTIVATE">
                <Button danger icon={<StopOutlined />} onClick={() => setDeactivateOpen(true)}>
                  비활성화
                </Button>
              </Can>
            )}
          </Space>
        </Space>

        {customer.customerStatus === 'INACTIVE' && (
          <Alert
            style={{ marginTop: 12 }}
            type="warning"
            showIcon
            message={`비활성 고객입니다.${customer.inactiveReason ? ` 사유: ${customer.inactiveReason}` : ''}`}
          />
        )}

        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col xs={12} md={6}>
            <Statistic title="계약 건수" value={summary.contractCount} suffix="건" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="매출(계약 합계)" value={money(summary.totalAmount)} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="수금" value={money(summary.paidAmount)} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="잔금" value={money(summary.balanceAmount)} />
          </Col>
        </Row>
      </Card>

      {/* 진행 단계는 "이 고객이 지금 어디까지 왔는지"라 탭보다 위에 둔다 (개발설계서 05 G-11) */}
      <JourneyCard
        customerId={customer.id}
        customerName={customer.name}
        contracts={data.contracts}
        orders={data.orders}
      />

      <Card>
        <Tabs
          defaultActiveKey="basic"
          items={[
            {
              key: 'basic',
              label: '기본정보',
              children: (
                <Descriptions column={{ xs: 1, md: 2 }} bordered size="small">
                  <Descriptions.Item label="이름">{customer.name}</Descriptions.Item>
                  <Descriptions.Item label="전화번호">{customer.phone}</Descriptions.Item>
                  <Descriptions.Item label="이메일">{customer.email ?? '-'}</Descriptions.Item>
                  <Descriptions.Item label="고객 상태">
                    <StatusBadge label={statusMeta.label} color={statusMeta.color} />
                  </Descriptions.Item>
                  <Descriptions.Item label="최초 예약일">{customer.firstReservedAt ?? '-'}</Descriptions.Item>
                  <Descriptions.Item label="계약 전환일">{customer.contractedAt ?? '-'}</Descriptions.Item>
                  <Descriptions.Item label="특이사항" span={2}>
                    {customer.notes ?? '-'}
                  </Descriptions.Item>
                </Descriptions>
              ),
            },
            {
              key: 'appointments',
              label: `예약·상담 (${data.appointments.length})`,
              children: (
                <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                  <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
                    <Typography.Text strong>예약 이력</Typography.Text>
                    <Link to="/appointments">예약 화면으로 이동 →</Link>
                  </Space>
                  <Table<Appointment>
                    {...tableCommon}
                    rowKey="id"
                    columns={appointmentColumns}
                    dataSource={data.appointments}
                    onRow={(r) => ({ onClick: () => navigate(`/appointments/${r.id}`), style: { cursor: 'pointer' } })}
                    locale={{ emptyText: <Empty description="예약 이력이 없습니다." /> }}
                  />
                  <Typography.Text strong>상담 이력</Typography.Text>
                  <List<Consultation>
                    dataSource={data.consultations}
                    locale={{ emptyText: <Empty description="상담 이력이 없습니다." /> }}
                    renderItem={(c) => (
                      <List.Item key={c.id}>
                        <List.Item.Meta
                          title={
                            <Space wrap>
                              <span>{dayjs(c.createdAt).format('YYYY-MM-DD HH:mm')}</span>
                              <Typography.Text type="secondary">{c.createdBy}</Typography.Text>
                              {c.interests.map((i) => (
                                <Tag key={i}>{i}</Tag>
                              ))}
                            </Space>
                          }
                          description={c.content}
                        />
                      </List.Item>
                    )}
                  />
                </Space>
              ),
            },
            {
              key: 'contracts',
              label: `계약 (${data.contracts.length})`,
              children: (
                <>
                  <GoToScreen path="/contracts" label="계약·주문" />
                  <Table<CustomerContractRow>
                    {...tableCommon}
                    rowKey="id"
                    columns={contractColumns}
                    dataSource={data.contracts}
                    scroll={{ x: 1000 }}
                    locale={{ emptyText: <Empty description="계약 이력이 없습니다." /> }}
                  />
                </>
              ),
            },
            {
              key: 'orders',
              label: `주문 (${data.orders.length})`,
              children: (
                <>
                  <GoToScreen path="/contracts" label="계약·주문" />
                  <Table<CustomerOrderRow>
                    {...tableCommon}
                    rowKey="id"
                    columns={orderColumns}
                    dataSource={data.orders}
                    scroll={{ x: 900 }}
                    locale={{ emptyText: <Empty description="주문 이력이 없습니다." /> }}
                  />
                </>
              ),
            },
            {
              key: 'options',
              label: '옵션·채촌',
              children: (
                <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                  <GoToScreen path="/production" label="맞춤 제작(옵션·채촌)" />
                  <Typography.Text strong>품목별 옵션 진행</Typography.Text>
                  <Table
                    {...tableCommon}
                    rowKey="id"
                    columns={optionColumns}
                    dataSource={optionRows}
                    locale={{ emptyText: <Empty description="맞춤 품목이 없습니다." /> }}
                  />
                  <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
                    <Typography.Text strong>채촌 이력</Typography.Text>
                    <Link to={`/measurements?customerId=${customer.id}`}>
                      이 고객의 채촌 화면으로 이동 →
                    </Link>
                  </Space>
                  <Table<CustomerMeasurementRow>
                    {...tableCommon}
                    rowKey="id"
                    columns={measurementColumns}
                    dataSource={data.measurements}
                    locale={{ emptyText: <Empty description="채촌 이력이 없습니다." /> }}
                  />
                </Space>
              ),
            },
            {
              key: 'production',
              label: '제작·입출고',
              children: (
                <>
                  <GoToScreen path="/production" label="맞춤 제작(제작·입출고)" />
                  <Table<CustomerComponentRow>
                    {...tableCommon}
                    rowKey="id"
                    columns={componentColumns}
                    dataSource={data.components}
                    scroll={{ x: 900 }}
                    locale={{ emptyText: <Empty description="제작 구성품이 없습니다." /> }}
                  />
                </>
              ),
            },
            {
              key: 'rentals',
              label: `렌탈 (${data.rentals.length})`,
              children: (
                <>
                  <GoToScreen path="/rentals" label="렌탈" />
                  <Table<CustomerComponentRow>
                    {...tableCommon}
                    rowKey="id"
                    columns={rentalColumns}
                    dataSource={data.rentals}
                    locale={{ emptyText: <Empty description="렌탈 배정 이력이 없습니다." /> }}
                  />
                </>
              ),
            },
            {
              key: 'repairs',
              label: `수선 (${data.repairs.length})`,
              children: (
                <>
                  <GoToScreen path="/repairs" label="수선" />
                  <Table<CustomerRepairRow>
                    {...tableCommon}
                    rowKey="id"
                    columns={repairColumns}
                    dataSource={data.repairs}
                    locale={{ emptyText: <Empty description="수선 이력이 없습니다." /> }}
                  />
                </>
              ),
            },
            {
              key: 'payments',
              label: `결제·연락 (${data.payments.length})`,
              children: (
                <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                  <Typography.Text strong>수기 결제 이력</Typography.Text>
                  <Table<CustomerPaymentRow>
                    {...tableCommon}
                    rowKey="id"
                    columns={paymentColumns}
                    dataSource={data.payments}
                    locale={{ emptyText: <Empty description="결제 이력이 없습니다." /> }}
                  />
                  <Typography.Text type="secondary">
                    메시지 발송 이력은 알림 화면(Phase 5) 구현 후 제공됩니다.
                  </Typography.Text>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title="고객 정보 수정"
        open={editOpen}
        okText="저장"
        cancelText="취소"
        confirmLoading={updateMutation.isPending}
        onOk={() => {
          void editForm
            .validateFields()
            .then((values) => updateMutation.mutate({ ...values, version: customer.version }));
        }}
        onCancel={() => setEditOpen(false)}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical" requiredMark>
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
            <Input maxLength={13} />
          </Form.Item>
          <Form.Item label="이메일" name="email" rules={[{ type: 'email', message: '이메일 형식이 아닙니다.' }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item label="특이사항" name="notes">
            <Input.TextArea rows={3} maxLength={1000} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="고객 비활성화"
        open={deactivateOpen}
        okText="비활성화"
        okButtonProps={{ danger: true }}
        cancelText="닫기"
        confirmLoading={deactivateMutation.isPending}
        onOk={() => {
          if (!deactivateReason.trim()) {
            message.warning('비활성화 사유를 입력해 주세요.');
            return;
          }
          deactivateMutation.mutate(deactivateReason.trim());
        }}
        onCancel={() => setDeactivateOpen(false)}
      >
        <Typography.Paragraph>
          고객을 비활성(INACTIVE) 처리합니다. 이력은 삭제되지 않습니다. 사유를 입력해 주세요. (필수)
        </Typography.Paragraph>
        <Input.TextArea
          rows={3}
          value={deactivateReason}
          onChange={(e) => setDeactivateReason(e.target.value)}
          placeholder="예: 고객 요청으로 정보 사용 중지"
          maxLength={500}
        />
      </Modal>
    </Space>
  );
}
