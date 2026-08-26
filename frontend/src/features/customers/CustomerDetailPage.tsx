import { EditOutlined, FileAddOutlined, StopOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Result,
  Space,
  Spin,
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
import { fetchCustomerJourneys, fetchJourney } from '../../api/journeys';
import { ALLOCATION_STATUS_META } from '../../api/rentals';
import { repairStatusMeta } from '../../api/repairs';
import { progressLabel } from '../production/production-layout';
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
import { CUSTOMER_STATUS_META, formatAmount, formatPhone } from './customer-constants';
import {
  buildContractTrackRows,
  ProgressSummaryCard,
  type SummaryRow,
} from './contract-progress-summary';
import { metaOf } from '../../shared/status-meta';
import { ItemCompositionCell } from '../contracts/ItemCompositionCell';
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

  /*
    제작 관리 요약을 진행(journey)의 현재 단계로 보여주기 위해, 제작관리 페이지와 같은 소스를 쓴다.
    대표 계약(진행중 우선, 없으면 최신 완료)의 맞춤(CUSTOM) 진행을 골라 상세를 받아
    "현재 단계명 + 진행중 완료/대상"(예: "가봉 피팅 진행중 2/4")을 만든다.
    훅은 조건 없이 걸고, 아직 계약·진행 목록이 없으면 enabled=false로 쉰다.
  */
  const journeysQuery = useQuery({
    queryKey: ['journeys', 'customer', id],
    queryFn: () => fetchCustomerJourneys(id),
    enabled: !!id,
  });
  const repContractForJourney =
    data && data.customer.customerStatus !== 'INACTIVE'
      ? (data.contracts.find((c) => c.status === 'DRAFT' || c.status === 'SIGNED') ??
        data.contracts.find((c) => c.status === 'COMPLETED'))
      : undefined;
  const repOrderIds = new Set(
    (data?.orders ?? [])
      .filter((o) => o.contractNo === repContractForJourney?.contractNo)
      .map((o) => o.id),
  );
  const customJourney =
    (journeysQuery.data ?? []).find(
      (j) => j.trackType === 'CUSTOM' && !!j.orderId && repOrderIds.has(j.orderId),
    ) ?? null;
  const journeyDetailQuery = useQuery({
    queryKey: ['journeys', 'detail', customJourney?.id],
    queryFn: () => fetchJourney(customJourney!.id),
    enabled: !!customJourney,
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

  // 헤더는 브레드크럼("고객 ›")만 남긴다 — 고객명·전화번호는 아래 기본정보 카드로 옮겼다.
  // 빈 제목('')은 "경로만 표시하고 제목 자리는 비움" 신호다(AppLayout 참고).
  usePageTitle(data ? '' : undefined);

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

  // 1·2번째 카드의 정보 테이블(Descriptions) 열 폭을 맞추기 위한 공용 설정.
  // column=3 고정 + info-desc 클래스(table-layout: fixed, index.css)로 6칸의 폭을 %로 못박는다.
  // 라벨 칸(구분값)은 모두 같은 폭, 데이터 칸은 모두 같은 폭이며 라벨보다 넓다(3×13% + 3×20.33% = 100%).
  // 긴 라벨(예: '매출(계약 합계)')은 칸 안에서 줄바꿈되게 둬(nowrap 제거) 옆 값과 겹치지 않게 한다.
  const infoTableProps = {
    column: 3,
    bordered: true as const,
    size: 'small' as const,
    className: 'info-desc',
    labelStyle: { width: '13%' },
    contentStyle: { width: '20.33%' },
  };

  // 대표 계약 = 진행중(작성중·서명완료) 우선, 없으면 최신 계약완료. (data.contracts는 최신순)
  // 진행 요약과 그 상단 계약 정보 블록을 이 계약 하나에 스코프한다. 비활성 고객은 대표 없음.
  const repContract =
    customer.customerStatus === 'INACTIVE'
      ? undefined
      : (data.contracts.find((c) => c.status === 'DRAFT' || c.status === 'SIGNED') ??
        data.contracts.find((c) => c.status === 'COMPLETED'));

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

  // 제작 관리 행 — 진행(journey)의 현재 단계로 표시(제작관리 페이지와 동일). 완료 판정도 진행 완료 기준.
  // 아직 완료 품목이 없으면 progressLabel이 "진행중 0/n"으로 낸다. 진행 상세 로딩 전에는 목록의
  // 현재 단계명만으로 "가봉 피팅 진행중"을 먼저 보여 준다.
  const journeyDetail = journeyDetailQuery.data;
  const currentStageView = journeyDetail?.stages.find(
    (s) => s.code === journeyDetail.currentStageCode,
  );
  const productionStage = customJourney
    ? {
        text: currentStageView
          ? `${currentStageView.name} ${progressLabel(currentStageView.completedCount, currentStageView.targetCount)}`
          : `${customJourney.currentStageName} 진행중`,
        done: !!customJourney.completedAt,
      }
    : null;

  const contractRows: SummaryRow[] = [];
  if (contractInProgress && repContract) {
    // 현재 계약 하나에 스코프 — 미연결 '작성중' 채촌 세션도 진행중인 이 계약에 귀속시킨다.
    contractRows.push(
      ...buildContractTrackRows(data, repContract, {
        includeUnlinkedMeasures: true,
        productionStage,
      }),
    );
  }
  // 수선 트랙 — 맞춤·렌탈과 분리해 별개 그룹으로 표시(진행 요약 카드에서 가로줄로 구획).
  // 진행중(RELEASED·CANCELLED 아님) 수선접수를 건별로 세운다.
  const repairRows: SummaryRow[] = data.repairs
    .filter((r) => r.status !== 'RELEASED' && r.status !== 'CANCELLED')
    .map((rp) => ({
      key: `repair-${rp.id}`,
      label: '수선',
      // 진행중 표시는 앞의 단계 동그라미(번호)와 파랑 글자가 하므로 칩은 두지 않고 상세만 적는다.
      status: <span>{`${repairStatusMeta(rp.status).label}${rp.target ? ` (${rp.target})` : ''}`}</span>,
      done: false,
      to: `/repairs?customerId=${customer.id}&customerName=${encodeURIComponent(customer.name)}`,
    }));

  /*
    진행 요약 상단 — "무슨 계약의 요약인지"를 밝히는 정보 블록.
    진행 요약과 같은 대표(진행중) 계약에 스코프한다. 촬영일·예식일은 그 계약의 주문에
    복사된 값을 쓰되, 계약에 주문이 여러 건이면 값이 있는 첫 주문을 대표로 잡는다.
  */
  const repOrdersForInfo = data.orders.filter((o) => o.contractNo === repContract?.contractNo);
  // 품목은 계약관리 목록의 '품목 구성' 열과 같은 규칙으로 낸다(ItemCompositionCell 공용):
  // 거래구분(맞춤/렌탈)별로 카테고리 개수를 합쳐 "[맞춤] 정장 2 · 셔츠 1 / [렌탈] 정장 2".
  const repCustomCounts: Record<string, number> = {};
  const repRentalCounts: Record<string, number> = {};
  for (const o of repOrdersForInfo) {
    const bucket = o.transactionType === 'RENTAL' ? repRentalCounts : repCustomCounts;
    for (const it of o.items ?? []) {
      bucket[it.productCategory] = (bucket[it.productCategory] ?? 0) + 1;
    }
  }
  const repPhotoDate = repOrdersForInfo.find((o) => o.photoDate)?.photoDate ?? null;
  const repWeddingDate = repOrdersForInfo.find((o) => o.weddingDate)?.weddingDate ?? null;
  const contractInfo =
    contractInProgress && repContract ? (
      <Descriptions {...infoTableProps}>
        <Descriptions.Item label="계약 번호">
          <Link to={`/contracts/${repContract.id}`}>{repContract.contractNo}</Link>
        </Descriptions.Item>
        <Descriptions.Item label="계약 구분">{repContract.contractTypeName ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="품목">
          <ItemCompositionCell customCounts={repCustomCounts} rentalCounts={repRentalCounts} />
        </Descriptions.Item>
        <Descriptions.Item label="촬영일">{repPhotoDate ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="예식일">{repWeddingDate ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="완료 예정일">{repContract.completionDueDate ?? '-'}</Descriptions.Item>
      </Descriptions>
    ) : undefined;

  const appointmentColumns: ColumnsType<Appointment> = [
    {
      title: '예약 일시',
      dataIndex: 'startAt',
      width: 200,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD (dd) HH:mm'),
    },
    { title: '목적', dataIndex: 'purposeName', width: 150 },
    {
      title: '출처',
      dataIndex: 'source',
      width: 120,
      render: (v: Appointment['source']) => <Tag color={metaOf(SOURCE_META, v).color}>{metaOf(SOURCE_META, v).label}</Tag>,
    },
    {
      title: '상태',
      dataIndex: 'status',
      width: 130,
      render: (v: Appointment['status']) => (
        <StatusBadge label={metaOf(APPT_STATUS_META, v).label} color={metaOf(APPT_STATUS_META, v).color} />
      ),
    },
    { title: '메모', dataIndex: 'memo', width: 320, ellipsis: true },
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
    // 수선 내용에 고정 폭을 줘 상태가 우측 끝으로 밀리지 않고 바로 옆에 붙게 한다.
    { title: '수선 내용', dataIndex: 'content', width: 400 },
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
          <Typography.Title level={4} style={{ margin: 0 }}>
            {customer.name}
          </Typography.Title>
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

        <Descriptions {...infoTableProps} style={{ marginTop: 16 }}>
          <Descriptions.Item label="전화번호">{formatPhone(customer.phone)}</Descriptions.Item>
          <Descriptions.Item label="이메일">{customer.email ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="최초 예약일">
            {customer.firstReservedAt ? dayjs(customer.firstReservedAt).format('YYYY-MM-DD') : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="키">
            {customer.heightCm != null ? `${customer.heightCm} cm` : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="몸무게">
            {customer.weightKg != null ? `${customer.weightKg} kg` : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="나이">
            {customer.age != null ? `${customer.age} 세` : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="고객 상태">
            <StatusBadge label={statusMeta.label} color={statusMeta.color} />
          </Descriptions.Item>
          <Descriptions.Item label="계약 건수">{summary.contractCount}건</Descriptions.Item>
          <Descriptions.Item label="매출(계약 합계)">{money(summary.totalAmount)}</Descriptions.Item>
          <Descriptions.Item label="특이사항" span={3}>
            {customer.notes ?? '-'}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {/* 진행 요약 — 상단에 무슨 계약의 요약인지 밝히고, 현재 진행중 트랙만 비춘다(읽기 전용). */}
      <ProgressSummaryCard rows={contractRows} repairRows={repairRows} header={contractInfo} />

      <Card>
        <Tabs
          defaultActiveKey="appointments"
          items={[
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
