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
import { useState, type ReactNode } from 'react';
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
import { COMPONENT_STATUS_RANK } from '../../api/production';
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

/**
 * 진행 요약 한 줄의 상태 표기.
 * 완료된 단계는 "완료 + 완료일"을, 진행중 단계는 넘겨받은 상태 노드를 그대로 보여준다.
 */
function ProgressStatus({
  done,
  doneDate,
  ongoing,
}: {
  done: boolean;
  doneDate?: string | null;
  ongoing: ReactNode;
}) {
  if (done) {
    return (
      <Space size={6}>
        <Tag color="success">완료</Tag>
        <Typography.Text>완료일 {doneDate ?? '-'}</Typography.Text>
      </Space>
    );
  }
  return <>{ongoing}</>;
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
    진행 요약 — 각 메뉴(예약·계약·컨설팅·채촌·제작·렌탈·수선)의 현재 상태만 읽어
    보여주고 해당 메뉴로 이동만 시킨다. 저장·기능 없는 읽기 전용 파생 뷰다.
    (진행 상태를 별도 테이블로 관리하던 방식을 걷어내고, 각 도메인 상태를 그대로 비춘다.)
  */
  // 각 영역을 그 고객의 전용 화면으로 딥링크한다 — 주문번호/계약번호 → 계약id 매핑.
  const contractIdByNo = new Map(data.contracts.map((c) => [c.contractNo, c.id]));
  const contractIdOfOrderNo = (orderNo: string) => {
    const o = data.orders.find((x) => x.orderNo === orderNo);
    return o?.contractNo ? contractIdByNo.get(o.contractNo) : undefined;
  };

  const summaryRows: { key: string; label: string; status: ReactNode; to: string }[] = [];
  if (data.appointments.length || data.consultations.length) {
    const latestAppt = data.appointments.reduce<Appointment | undefined>(
      (m, a) => (!m || a.startAt > m.startAt ? a : m),
      undefined,
    );
    summaryRows.push({
      key: 'appt',
      label: '예약·상담',
      status: latestAppt ? (
        <ProgressStatus
          // 방문완료(VISITED)면 완료 칩 + 방문일. 예약·확정은 진행중, 취소·노쇼는 상태만.
          done={latestAppt.status === 'VISITED'}
          doneDate={dayjs(latestAppt.startAt).format('YYYY-MM-DD')}
          ongoing={
            <span>
              {latestAppt.status === 'RESERVED' || latestAppt.status === 'CONFIRMED'
                ? `진행중 · ${metaOf(APPT_STATUS_META, latestAppt.status).label}`
                : metaOf(APPT_STATUS_META, latestAppt.status).label}
            </span>
          }
        />
      ) : (
        <span>상담 {data.consultations.length}건</span>
      ),
      to: latestAppt ? `/appointments/${latestAppt.id}` : '/appointments',
    });
  }
  if (data.contracts.length) {
    const c = repContract ?? data.contracts[0];
    summaryRows.push({
      key: 'contract',
      label: '계약',
      // 계약서 코드는 사용자가 모르므로 뺀다.
      // 완료: '완료' 칩 + 완료일 + 완료예정일.
      // 진행중: 상태만 표시 — 서명 전은 모두 '임시저장', 서명 후는 '서명완료'.
      status:
        c.status === 'COMPLETED' ? (
          <Space size={10} wrap>
            <Tag color="success">완료</Tag>
            <Typography.Text>완료일 {c.contractedAt ?? '-'}</Typography.Text>
            <Typography.Text>완료예정일 {c.completionDueDate ?? '-'}</Typography.Text>
          </Space>
        ) : c.status === 'CANCELLED' ? (
          <span>취소</span>
        ) : (
          <span>진행중 · {c.status === 'SIGNED' ? '서명완료' : '임시저장'}</span>
        ),
      to: `/contracts/${c.id}`,
    });
  }
  const customOrder = data.orders.find(
    (o) => o.transactionType === 'CUSTOM' && (o.items?.length ?? 0) > 0,
  );
  const customItems = data.orders
    .filter((o) => o.transactionType === 'CUSTOM')
    .flatMap((o) => o.items ?? []);
  if (customItems.length) {
    const confirmed = customItems.filter((i) => i.optionStatus === 'CONFIRMED').length;
    const allConfirmed = confirmed === customItems.length;
    // 완료일 = 품목별 확정일 중 가장 늦은 날짜(마지막 확정 시점)
    const confirmedDates = customItems
      .map((i) => i.optionConfirmedAt)
      .filter((d): d is string => !!d)
      .sort();
    const confirmedDate = confirmedDates[confirmedDates.length - 1];
    const optionContractId = customOrder?.contractNo
      ? contractIdByNo.get(customOrder.contractNo)
      : undefined;
    summaryRows.push({
      key: 'option',
      label: '스타일 컨설팅',
      status: (
        <ProgressStatus
          done={allConfirmed}
          doneDate={confirmedDate}
          ongoing={<span>{`진행중 · 옵션 확정 ${confirmed}/${customItems.length} 품목`}</span>}
        />
      ),
      to: optionContractId ? `/contracts/${optionContractId}/options` : '/production',
    });
  }
  if (data.measurements.length) {
    // 백엔드가 versionNo 내림차순으로 내려주므로 [0]이 최신 채촌 세션이다.
    const latestMeasure = data.measurements[0];
    // 완료 판정은 제작 관리와 동일하게 "품목에 연결된(사용 중인) 채촌 존재" 기준으로 본다.
    // (measurementSession.completedAt은 런타임에 세팅되지 않아 항상 진행중으로 보이던 문제 해결)
    const linkedMeasure = data.measurements.find((m) => (m.usedByItems?.length ?? 0) > 0);
    const measureDone = !!linkedMeasure;
    const measureDate = linkedMeasure?.completedAt ?? linkedMeasure?.date;
    summaryRows.push({
      key: 'measure',
      label: '채촌',
      status: (
        <Space size={6} wrap>
          <ProgressStatus
            done={measureDone}
            doneDate={measureDate}
            ongoing={<span>진행중 · 작성중</span>}
          />
          <Typography.Text>{`총 ${data.measurements.length}회`}</Typography.Text>
        </Space>
      ),
      // 목록 필터가 아니라 이 고객의 최신 채촌 세션 상세로 바로 이동한다.
      to: `/measurements/${latestMeasure.id}`,
    });
  }
  // 구성품은 거래 유형으로 나눈다: 제작 관리는 맞춤(CUSTOM), 렌탈 탭/요약은 렌탈(RENTAL).
  const customComponents = data.components.filter((c) => c.transactionType !== 'RENTAL');
  const rentalComponents = data.components.filter((c) => c.transactionType === 'RENTAL');
  if (customComponents.length) {
    const prodContractId = contractIdOfOrderNo(customComponents[0].orderNo);
    // 취소 구성품은 진행률·대표 상태 계산에서 제외한다(분모 왜곡·병목 오인 방지).
    const activeComponents = customComponents.filter((c) => c.status !== 'CANCELLED');
    const total = activeComponents.length;
    const released = activeComponents.filter((c) => c.status === 'RELEASED').length;
    // 완료일 = 실제 출고일 중 가장 늦은 날짜(마지막 출고 시점)
    const outboundDates = activeComponents
      .map((c) => c.actualOutboundAt)
      .filter((d): d is string => !!d)
      .sort();
    const outboundDate = outboundDates[outboundDates.length - 1];
    // 진행중 대표 상태 = 가장 덜 진행된 구성품(병목)의 상태
    const leastStatus = [...activeComponents].sort(
      (a, b) => (COMPONENT_STATUS_RANK[a.status] ?? 0) - (COMPONENT_STATUS_RANK[b.status] ?? 0),
    )[0]?.status;
    summaryRows.push({
      key: 'production',
      label: '제작 관리',
      status: leastStatus ? (
        <Space size={6} wrap>
          <ProgressStatus
            done={released === total}
            doneDate={outboundDate}
            // 상태 앞 동그라미(Badge) 없이 컨설팅·채촌과 같은 평문 스타일로 출력한다.
            ongoing={<span>진행중 · {metaOf(COMPONENT_STATUS_META, leastStatus).label}</span>}
          />
          <Typography.Text>{`출고 ${released}/${total}`}</Typography.Text>
        </Space>
      ) : (
        // 전 구성품이 취소된 경우
        <Typography.Text>취소</Typography.Text>
      ),
      to: prodContractId ? `/contracts/${prodContractId}/production` : '/production',
    });
  }
  if (rentalComponents.length) {
    const rentalContractId = contractIdOfOrderNo(rentalComponents[0].orderNo);
    // 스타일 컨설팅(렌탈 파트)에서 확정된 품목의 구성품 수 = 컨설팅 확정 진척.
    const confirmedItemIds = new Set(
      data.orders
        .filter((o) => o.transactionType === 'RENTAL')
        .flatMap((o) => (o.items ?? []).filter((it) => it.rentalConsultingConfirmed).map((it) => it.id)),
    );
    const confirmed = rentalComponents.filter(
      (c) => c.orderItemId && confirmedItemIds.has(c.orderItemId),
    ).length;
    const total = rentalComponents.length;
    // 렌탈 완료 = 모든 구성품이 출고(대여)→반납(RETURNED)까지 끝난 상태. 완료일 = 마지막 반납일.
    const allocByComponentId = new Map(data.rentals.map((a) => [a.componentId, a]));
    const returnedCount = rentalComponents.filter(
      (c) => allocByComponentId.get(c.id)?.status === 'RETURNED',
    ).length;
    const returnDates = rentalComponents
      .map((c) => allocByComponentId.get(c.id))
      .filter((a) => a?.status === 'RETURNED')
      .map((a) => a?.actualReturnAt)
      .filter((d): d is string => !!d)
      .sort();
    summaryRows.push({
      key: 'rental',
      label: '렌탈',
      status: (
        <ProgressStatus
          done={returnedCount === total}
          doneDate={returnDates[returnDates.length - 1]}
          // 진행중이면 다른 진행상황과 동일한 평문 스타일 — 컨설팅 확정 진척을 보여준다.
          ongoing={<span>{`진행중 · 컨설팅 확정 ${confirmed}/${total}`}</span>}
        />
      ),
      to: rentalContractId ? `/contracts/${rentalContractId}/production` : '/rentals',
    });
  }
  if (data.repairs.length) {
    const latestRepair = data.repairs[0];
    // 동그라미(Badge) 없이 컨설팅·채촌·제작과 같은 평문 스타일로 통일.
    const repairLabel = repairStatusMeta(latestRepair.status).label;
    const repairInProgress =
      latestRepair.status !== 'RELEASED' && latestRepair.status !== 'CANCELLED';
    summaryRows.push({
      key: 'repair',
      label: '수선',
      status: <span>{repairInProgress ? `진행중 · ${repairLabel}` : repairLabel}</span>,
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

      {/* 진행 요약 — 각 메뉴의 현재 상태만 비추고 이동시킨다(읽기 전용). */}
      {summaryRows.length > 0 && (
        <Card title="진행 요약" size="small">
          <List
            size="small"
            dataSource={summaryRows}
            renderItem={(r) => (
              <List.Item
                actions={[
                  <Button
                    key="go"
                    type="primary"
                    ghost
                    shape="round"
                    size="small"
                    onClick={() => navigate(r.to)}
                  >
                    작업화면으로 이동하기
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={r.label}
                  // 진행 요약의 상태·날짜 글자를 굵기는 그대로 두고 색만 진하게(어둡게) 출력한다.
                  description={
                    <span style={{ color: 'rgba(0, 0, 0, 0.88)' }}>{r.status}</span>
                  }
                />
              </List.Item>
            )}
          />
        </Card>
      )}

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
