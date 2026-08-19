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
  InputNumber,
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
  type CustomerRepairRow,
  type CustomerSaveBody,
} from '../../api/customers';
import { ALLOCATION_STATUS_META } from '../../api/rentals';
import { repairStatusMeta } from '../../api/repairs';
import {
  CONTRACT_STATUS_META,
  COMPONENT_STATUS_META,
  MEASUREMENT_TYPE_META,
  OPTION_STATUS_META,
} from '../../api/status-catalog';
import { BackButton } from '../../shared/BackButton';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { APPT_STATUS_META, SOURCE_META } from '../appointments/appointment-constants';
import { CUSTOMER_STATUS_META, formatAmount } from './customer-constants';
import {
  buildContractTrackRows,
  ProgressSummaryCard,
  type SummaryRow,
} from './contract-progress-summary';
import { metaOf } from '../../shared/status-meta';
import { usePageTitle } from '../../shared/page-title-store';

/*
  상태 표시명은 중앙 사전(api/status-catalog)에서 도메인별로 가져온다 (2026-08-05).
  전에는 계약·주문품목·렌탈·수선 코드를 한 맵에 섞어 두어 코드가 겹치면 뜻이
  충돌했고(수선 RECEIVED=접수 vs 품목 RECEIVED=입고), 수선의 실제 상태 코드
  (REQUESTED·RETURNED_TO_SHOP·CUSTOMER_NOTIFIED)는 맵에 없어 원문으로 노출됐다.
*/

// 구성품 표시명은 중앙(api/code-labels) 공유 맵을 쓴다(관리자 편집 전 화면 반영).
const COMPONENT_TYPE_LABEL = COMPONENT_TYPE_LABELS;

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
    mutationFn: (body: CustomerSaveBody & { version: number }) => updateCustomer(id, body),
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

  // 헤더 제목을 이 고객으로 바꾼다 — 목록과 상세가 헤더에서 구분되지 않던 문제(UI 정리).
  usePageTitle(data?.customer?.name, data?.customer?.phone);

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
  const money = (v: number) => formatAmount(v);

  // 헤더 배지: 계약서가 있으면 고객상태(미계약/계약) 대신 대표 계약서 상태를 보여준다.
  // 대표 = 진행중(작성중·서명완료) 우선, 없으면 최신 계약완료. (data.contracts는 최신순)
  // 취소만 있거나 계약서가 없으면 고객상태로, 비활성 고객은 항상 비활성으로 둔다.
  const repContract =
    customer.customerStatus === 'INACTIVE'
      ? undefined
      : (data.contracts.find((c) => c.status === 'DRAFT' || c.status === 'SIGNED') ??
        data.contracts.find((c) => c.status === 'COMPLETED'));
  const headerBadge = repContract
    ? { ...metaOf(CONTRACT_STATUS_META, repContract.status), contractNo: repContract.contractNo }
    : { ...statusMeta, contractNo: null };

  /*
    진행 요약 — "현재 진행중인 트랙만" 블록으로 쌓는 읽기 전용 파생 뷰다.
     · 계약 트랙(계약·컨설팅·채촌·제작): 현재(대표) 계약이 진행중일 때만, 그 계약 하나에
       스코프해 노출한다(계약이 여러 건이어도 서로 섞이지 않는다). '완료'는 제작 관리까지
       전량 출고돼야 성립하므로, 계약이 COMPLETED여도 그 계약의 제작이 남았으면 진행중으로 본다.
     · 수선 트랙: 계약과 별개. 진행중 수선접수가 있으면 계약 블록 아래에 표시한다.
     · 이전 계약의 진행 요약은 하단 '계약' 탭 → 계약 상세 안(계약서·버전 사이)에서 확인한다.
  */
  // 제작 관리 목록(하단 탭)은 맞춤(CUSTOM) 구성품만 보여준다 — 렌탈 제외.
  const customComponents = data.components.filter((c) => c.transactionType !== 'RENTAL');
  // 현재 계약의 맞춤 구성품(취소 제외) — 계약 완료(제작 전량 출고) 판정용.
  const repOrderNos = new Set(
    data.orders.filter((o) => o.contractNo === repContract?.contractNo).map((o) => o.orderNo),
  );
  const repActiveComponents = customComponents.filter(
    (c) => repOrderNos.has(c.orderNo) && c.status !== 'CANCELLED',
  );
  const productionAllReleased =
    repActiveComponents.length > 0 && repActiveComponents.every((c) => c.status === 'RELEASED');
  const contractSettled =
    repContract?.status === 'COMPLETED' &&
    (repActiveComponents.length === 0 || productionAllReleased);
  const contractInProgress = !!repContract && !contractSettled;

  const summaryRows: SummaryRow[] = [];
  if (contractInProgress && repContract) {
    // 현재 계약 하나에 스코프 — 미연결 '작성중' 채촌 세션도 진행중인 이 계약에 귀속시킨다.
    summaryRows.push(
      ...buildContractTrackRows(data, repContract, { includeUnlinkedMeasures: true }),
    );
  }
  // 수선 트랙 — 진행중(RELEASED·CANCELLED 아님) 수선접수를 계약 블록 아래에 건별로 표시.
  for (const rp of data.repairs.filter(
    (r) => r.status !== 'RELEASED' && r.status !== 'CANCELLED',
  )) {
    summaryRows.push({
      key: `repair-${rp.id}`,
      label: '수선',
      status: (
        <Space size={6}>
          <Tag color="success">진행중</Tag>
          <span>{`${repairStatusMeta(rp.status).label}${rp.target ? ` (${rp.target})` : ''}`}</span>
        </Space>
      ),
      done: false,
      to: `/repairs?customerId=${customer.id}&customerName=${encodeURIComponent(customer.name)}`,
    });
  }

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
      render: (v: string) => metaOf(CONTRACT_STATUS_META, v).label,
    },
    { title: '버전', dataIndex: 'currentVersionNo', width: 70, render: (v: number) => `v${v}` },
    { title: '계약일', dataIndex: 'contractedAt', width: 110, render: (v?: string) => v ?? '-' },
    { title: '완료예정일', dataIndex: 'completionDueDate', width: 110, render: (v?: string) => v ?? '-' },
    { title: '계약금액', dataIndex: 'totalAmount', align: 'right', width: 120, render: money },
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
      render: (v: string) => metaOf(MEASUREMENT_TYPE_META, v).label,
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
    { title: '상태', dataIndex: 'status', width: 110, render: (v: string) => metaOf(COMPONENT_STATUS_META, v).label },
    { title: '입고 예정일', dataIndex: 'expectedInboundDate', width: 110, render: (v?: string) => v ?? '-' },
    { title: '실제 입고일', dataIndex: 'actualInboundAt', width: 110, render: (v?: string) => v ?? '-' },
    { title: '출고일', dataIndex: 'actualOutboundAt', width: 110, render: (v?: string) => v ?? '-' },
  ];

  // 렌탈 탭: 계약에 포함된 렌탈 구성품에 실물 배정(있으면) 정보를 얹는다.
  // 배정 전이면 실물 관리 ID·배정 상태가 비어 '미배정'으로 표시된다.
  type RentalRow = CustomerComponentRow & { allocationStatus: string | null };
  const rentalComponents = data.components.filter((c) => c.transactionType === 'RENTAL');
  const allocByComponentId = new Map(data.rentals.map((a) => [a.componentId, a]));
  const rentalRows: RentalRow[] = rentalComponents.map((c) => {
    const alloc = allocByComponentId.get(c.id);
    return {
      ...c,
      rentalItemCode: alloc?.rentalItemCode ?? null,
      allocationStatus: alloc?.status ?? null,
    };
  });

  const rentalColumns: ColumnsType<RentalRow> = [
    { title: '주문번호', dataIndex: 'orderNo', width: 160 },
    { title: '품목', dataIndex: 'itemName', width: 130 },
    {
      title: '구성품',
      dataIndex: 'componentType',
      width: 90,
      render: (v: string) => COMPONENT_TYPE_LABEL[v] ?? v,
    },
    { title: '실물 관리 ID', dataIndex: 'rentalItemCode', width: 170, render: (v?: string | null) => v ?? '-' },
    {
      title: '상태',
      dataIndex: 'allocationStatus',
      width: 120,
      render: (v: string | null) =>
        v ? metaOf(ALLOCATION_STATUS_META, v).label : <Tag>미배정</Tag>,
    },
  ];

  const repairColumns: ColumnsType<CustomerRepairRow> = [
    { title: '접수일', dataIndex: 'receivedDate', width: 120 },
    { title: '대상', dataIndex: 'target', width: 160 },
    { title: '수선 내용', dataIndex: 'content' },
    {
      title: '상태',
      dataIndex: 'status',
      width: 110,
      render: (v: string) => repairStatusMeta(v).label,
    },
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
            <Typography.Text type="secondary">{customer.phone}</Typography.Text>
            <StatusBadge label={headerBadge.label} color={headerBadge.color} />
            {headerBadge.contractNo && (
              <Typography.Text type="secondary">({headerBadge.contractNo})</Typography.Text>
            )}
          </Space>
          <Space wrap>
            <Can permission="CUSTOMER_EDIT">
              <Button
                icon={<EditOutlined />}
                onClick={() => {
                  editForm.setFieldsValue({
                    name: customer.name,
                    phone: customer.phone,
                    heightCm: customer.heightCm ?? undefined,
                    weightKg: customer.weightKg ?? undefined,
                    age: customer.age ?? undefined,
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
        </Row>
      </Card>

      {/* 진행 요약 — 현재 진행중 트랙만 비추고 각 작업화면으로 이동시킨다(읽기 전용). */}
      <ProgressSummaryCard rows={summaryRows} />

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
                  <Descriptions.Item label="키">{customer.heightCm != null ? `${customer.heightCm} cm` : '-'}</Descriptions.Item>
                  <Descriptions.Item label="몸무게">{customer.weightKg != null ? `${customer.weightKg} kg` : '-'}</Descriptions.Item>
                  <Descriptions.Item label="나이">{customer.age != null ? `${customer.age} 세` : '-'}</Descriptions.Item>
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
                    scroll={{ x: 'max-content' }}
                    locale={{ emptyText: <Empty description="계약 이력이 없습니다." /> }}
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
                    dataSource={customComponents}
                    scroll={{ x: 'max-content' }}
                    locale={{ emptyText: <Empty description="제작 구성품이 없습니다." /> }}
                  />
                </>
              ),
            },
            {
              key: 'rentals',
              label: `렌탈 (${rentalRows.length})`,
              children: (
                <>
                  <GoToScreen path="/rentals" label="렌탈" />
                  <Table<RentalRow>
                    {...tableCommon}
                    rowKey="id"
                    columns={rentalColumns}
                    dataSource={rentalRows}
                    locale={{ emptyText: <Empty description="렌탈 구성품이 없습니다." /> }}
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
          ]}
        />
      </Card>

      {/* 목록·예약 상세 등 여러 경로로 들어오므로 뒤로가기로 통일 */}
      <Card>
        <BackButton />
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
        destroyOnHidden
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
          <Form.Item label="키 (cm)" name="heightCm">
            <InputNumber style={{ width: '100%' }} min={0} max={300} placeholder="예: 175" />
          </Form.Item>
          <Form.Item label="몸무게 (kg)" name="weightKg">
            <InputNumber style={{ width: '100%' }} min={0} max={500} step={0.1} placeholder="예: 68.5" />
          </Form.Item>
          <Form.Item label="나이" name="age">
            <InputNumber style={{ width: '100%' }} min={0} max={150} placeholder="예: 32" />
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
