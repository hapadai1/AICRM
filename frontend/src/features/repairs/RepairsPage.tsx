import { MinusCircleOutlined, NotificationOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Steps,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { LAYOUT } from '../../app/theme';
import { DataTable } from '../../shared/DataTable';
import { COL } from '../../shared/table-width';
import { ListToolbar, PageCard, PageShell } from '../../shared/PageShell';
import { fetchCustomers } from '../../api/customers';
import {
  REPAIR_COMPONENT_TYPE_LABELS,
  REPAIR_STATUS_FLOW,
  REPAIR_TARGET_PRODUCTS,
  REPAIR_TYPES,
  createRepair,
  fetchRepair,
  fetchRepairs,
  notifyRepair,
  markRepairNotified,
  repairStatusMeta,
  repairTypeLabel,
  REPAIR_METHOD_LABELS,
  REPAIR_PHASES,
  REPAIR_PHASE_LABELS,
  REPAIR_PHASE_STATUSES,
  REPAIR_RECEIPT_METHODS,
  REPAIR_RELEASE_METHODS,
  type Repair,
  type RepairEvent,
  type RepairNotificationSuggestion,
  type RepairPhase,
  type RepairReceiptMethod,
  type RepairReleaseMethod,
  type RepairStatus,
} from '../../api/repairs';
import { Can } from '../../shared/Can';
import {
  RepairItemProgress,
  repairStageSummary,
  type RepairProgressStage,
} from './RepairItemProgress';
import { NotificationConfirmModal } from '../../shared/NotificationConfirmModal';
import { StatusBadge } from '../../shared/StatusBadge';

interface ReceiptValues {
  customerId: string;
  repairType: string;
  /** 대상 품목·개수 (상의·하의·베스트·셔츠·구두) — 계약 등록 품목과 무관하게 고른다 */
  items?: { targetProduct?: string; quantity?: number }[];
  requestDate: Dayjs;
  dueDate?: Dayjs;
  description: string;
  notes?: string;
  /** 접수·출고 방식 (개발설계서 05 G-07) */
  receiptMethod?: RepairReceiptMethod;
  releaseMethod?: RepairReleaseMethod;
  pickupAddress?: string;
  deliveryAddress?: string;
}

/** 두 상태 셀렉트 모두 맨 앞이 '전체'다 — 지우기(X) 대신 고를 수 있는 항목으로 둔다. */
const FILTER_ALL = 'ALL';

const PHASE_FILTER_OPTIONS = [
  { value: FILTER_ALL, label: '전체' },
  ...REPAIR_PHASES.map((p) => ({ value: p, label: REPAIR_PHASE_LABELS[p] })),
];

const statusOptionsOf = (statuses: RepairStatus[]) => [
  { value: FILTER_ALL, label: '전체' },
  ...statuses.map((s) => ({ value: s, label: repairStatusMeta(s).label })),
];

/** 세부 상태 선택지 — 전체 상태를 고르면 그 묶음 안으로 좁힌다. */
const ALL_STATUS_OPTIONS = statusOptionsOf([...REPAIR_STATUS_FLOW, 'CANCELLED']);

/** 단계(건 상태)와 품목 진행 단계의 대응 — 접수·고객 연락은 품목 단위가 아니라 비어 있다. */
const STAGE_BY_STATUS: Partial<Record<RepairStatus, RepairProgressStage>> = {
  REQUESTED: 'REQUEST',
  RETURNED_TO_SHOP: 'RETURN',
  RELEASED: 'RELEASE',
};

/**
 * 대상 열 폭. 품목은 다섯 가지(상의·하의·베스트·셔츠·구두)가 전부라 최대 길이가 정해져 있고,
 * `상의(자켓) 1 · 하의(바지) 1 · 베스트 1 · 셔츠 1 · 구두 1`이 한 줄에 들어가야 한다.
 * COL.wide(품목 구성)로는 모자라 이 화면에서만 넓게 잡는다.
 */
const TARGET_WIDTH = 350;

/**
 * 행 펼침 단계 줄의 이름 칸 폭. 가장 긴 이름이 네 자(수선 요청·수선 입고·고객 연락·출고 완료)라
 * 그 폭에 칸 사이 간격을 더한 값이다 — 다섯 단계의 내용이 같은 자리에서 시작한다.
 */
const STEP_LABEL_WIDTH = 88;

/**
 * 단계 밑 품목 표를 들여쓰는 폭. 표를 이름 칸 폭만큼 밀면 표 테두리는 맞지만 글자는
 * 셀 여백(8px)만큼 오른쪽으로 밀린다 — 눈이 맞추는 건 테두리가 아니라 글자라 그만큼 뺀다.
 */
const STEP_BODY_INDENT = STEP_LABEL_WIDTH - 8;

/** 접수·출고 방식 칸 — 방문 수거·배송이면 주소까지 같이 보여 준다(우리가 갈 곳이다). */
function methodCell(method: string | undefined, address: string | undefined) {
  if (!method) return '-';
  return (
    <Space direction="vertical" size={0}>
      <Typography.Text>{REPAIR_METHOD_LABELS[method] ?? method}</Typography.Text>
      {address && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {address}
        </Typography.Text>
      )}
    </Space>
  );
}

/** REPAIR-001 수선 접수·진행 */
export function RepairsPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();

  // 고객 상세 '진행 요약'에서 ?customerId=&customerName= 로 넘어오면 그 고객으로 걸러 연다.
  const [searchParams] = useSearchParams();
  const urlCustomerId = searchParams.get('customerId') ?? undefined;
  const urlCustomerName = searchParams.get('customerName') ?? undefined;

  const [statusFilter, setStatusFilter] = useState<RepairStatus | undefined>();
  // 목록을 여는 이유는 대개 "지금 처리할 게 뭐냐"라 진행중으로 시작한다(비우면 전체).
  // 단, 특정 고객으로 들어오면 그 고객의 수선 전체를 봐야 하므로 단계 필터를 풀어 둔다.
  const [phaseFilter, setPhaseFilter] = useState<RepairPhase | undefined>(
    urlCustomerId ? undefined : 'IN_PROGRESS',
  );
  const [customerFilter, setCustomerFilter] = useState<string | undefined>(urlCustomerId);
  const [customerKeyword, setCustomerKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(30);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 고객 연락 확인창 (개발설계서 05 G-06). notifyRepairId = 발송 성공 시 시각을 찍을 수선 건.
  const [suggestion, setSuggestion] = useState<RepairNotificationSuggestion | null>(null);
  const [suggestionTitle, setSuggestionTitle] = useState('');
  const [notifyRepairId, setNotifyRepairId] = useState<string | null>(null);

  const [receiptForm] = Form.useForm<ReceiptValues>();

  const listQuery = useQuery({
    queryKey: ['repairs', 'list', { statusFilter, customerFilter, phaseFilter, page, size }],
    queryFn: () =>
      fetchRepairs({
        status: statusFilter,
        customerId: customerFilter,
        phase: phaseFilter,
        page,
        size,
      }),
  });

  // 고객 검색 — 필터·접수 모달 공용 (전화번호로도 검색된다).
  // 수선은 계약 보유 고객만 대상이다 — 다른 화면(계약·실측)의 scope=ALL 검색과
  // 캐시가 섞이지 않도록 queryKey에 scope를 포함한다.
  const customerQuery = useQuery({
    queryKey: ['customers', 'search', 'CONTRACT', customerKeyword],
    queryFn: () =>
      fetchCustomers({ q: customerKeyword || undefined, scope: 'CONTRACT', size: 20 }),
  });

  const detailQuery = useQuery({
    queryKey: ['repairs', 'detail', expandedId],
    queryFn: () => fetchRepair(expandedId as string),
    enabled: !!expandedId,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['repairs'] });
    void queryClient.invalidateQueries({ queryKey: ['rentals'] });
  };

  const createMutation = useMutation({
    mutationFn: (v: ReceiptValues) =>
      createRepair({
        customerId: v.customerId,
        repairType: v.repairType,
        requestDate: v.requestDate.format('YYYY-MM-DD'),
        dueDate: v.dueDate?.format('YYYY-MM-DD'),
        description: v.description,
        notes: v.notes,
        receiptMethod: v.receiptMethod,
        releaseMethod: v.releaseMethod,
        pickupAddress: v.pickupAddress,
        deliveryAddress: v.deliveryAddress,
        // 빈 줄(품목 미선택)은 보내지 않는다 — 첫 줄은 화면에서 필수로 받는다.
        items: (v.items ?? [])
          .filter((i) => i?.targetProduct)
          .map((i) => ({ targetProduct: i.targetProduct as string, quantity: i.quantity ?? 1 })),
      }),
    onSuccess: (r) => {
      message.success(`${r.customerName} 고객의 수선이 접수되었습니다.`);
      // destroyOnHidden가 닫힐 때 Form을 언마운트하므로 별도 resetFields는 불필요하다
      // (언마운트된 폼에 호출하면 "useForm not connected" 경고가 난다).
      setReceiptOpen(false);
      invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '수선 접수에 실패했습니다.'),
  });

  // 고객 연락 문구 준비 — 버튼을 누르면 상태를 바꾸지 않고 발송 확인창만 띄운다.
  // 실제 발송(확인창의 [발송]) 성공 뒤 markNotified로 마지막 연락 시각을 찍어 [재발송]으로 바꾼다.
  const notifyMutation = useMutation({
    mutationFn: (repair: Repair) => notifyRepair(repair.id),
    onSuccess: (res, repair) => {
      if (res.suggestedNotification) {
        setSuggestionTitle(`${repair.customerName} 고객에게 연락`);
        setNotifyRepairId(repair.id);
        setSuggestion(res.suggestedNotification);
      } else {
        message.info('보낼 연락 문구가 설정되어 있지 않습니다.');
      }
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '고객 연락 준비에 실패했습니다.'),
  });

  // 발송 성공 표시 — 마지막 연락 시각을 찍고 목록·발송 이력을 갱신한다.
  const markNotifiedMutation = useMutation({
    mutationFn: markRepairNotified,
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '연락 기록에 실패했습니다.'),
  });

  // 전체 상태를 고르면 세부 상태 선택지도 그 묶음 안으로 좁힌다 —
  // '진행중'을 보면서 '출고 완료'를 고를 수 있으면 결과가 항상 0건이라 고를 이유가 없다.
  const statusOptions = phaseFilter
    ? statusOptionsOf(REPAIR_PHASE_STATUSES[phaseFilter])
    : ALL_STATUS_OPTIONS;

  const customerOptions = (customerQuery.data?.data ?? []).map((c) => ({
    value: c.id,
    label: `${c.name} (${c.phone})`,
  }));
  // URL로 넘어온 고객이 검색결과에 아직 없으면, 선택칩에 이름이 뜨도록 옵션을 미리 넣는다.
  if (urlCustomerId && !customerOptions.some((o) => o.value === urlCustomerId)) {
    customerOptions.unshift({ value: urlCustomerId, label: urlCustomerName ?? urlCustomerId });
  }

  // 대상 품목: 계약에 등록된 물품이 아니라 품목 목록에서 자유롭게 고른다.
  const targetProductOptions = REPAIR_TARGET_PRODUCTS.map((code) => ({
    value: code,
    label: REPAIR_COMPONENT_TYPE_LABELS[code] ?? code,
  }));

  const columns: ColumnsType<Repair> = [
    {
      title: '고객',
      dataIndex: 'customerName',
      width: COL.name,
      render: (name: string, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.customerPhone}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '유형',
      dataIndex: 'repairType',
      width: COL.status,
      render: (t: string) => repairTypeLabel(t),
    },
    {
      title: '대상',
      dataIndex: 'targetLabel',
      width: TARGET_WIDTH,
      render: (label: string) => <Typography.Text>{label}</Typography.Text>,
    },
    { title: '접수일', dataIndex: 'requestDate', width: COL.name },
    {
      title: '완료 예정일',
      dataIndex: 'dueDate',
      width: COL.name,
      render: (d: string | undefined, r) => (
        <Space size={4}>
          {d ?? '-'}
          {d && d < dayjs().format('YYYY-MM-DD') && !['RELEASED', 'CANCELLED'].includes(r.status) && (
            <Tag color="red">지연</Tag>
          )}
        </Space>
      ),
    },
    {
      title: '상태',
      dataIndex: 'status',
      width: COL.status,
      // 이 표에서 가운데 정렬은 상태 하나뿐이었다. 자기 몫 여백이 좌우로 갈려
      // 배지가 옆 열에 붙어 보이므로 나머지 열과 같은 왼쪽 정렬로 맞춘다.
      render: (s: string) => {
        const meta = repairStatusMeta(s);
        return <StatusBadge label={meta.label} color={meta.color} />;
      },
    },
    {
      // 방문 수거·배송이면 우리가 움직여야 하는 건이지만, 매번 보는 값은 아니라 맨 뒤에 둔다.
      title: '접수 방식',
      dataIndex: 'receiptMethod',
      // 값은 '고객 방문' 같은 짧은 분류값이다. 주소는 방문 수거·배송일 때만 붙는 예외라
      // 그 한 줄에 맞춰 열을 넓히지 않고 셀 안에서 접는다.
      width: COL.status,
      render: (m: string | undefined, r) => methodCell(m, r.pickupAddress),
    },
    {
      title: '출고 방식',
      dataIndex: 'releaseMethod',
      width: COL.status,
      render: (m: string | undefined, r) => methodCell(m, r.deliveryAddress),
    },
  ];

  return (
    <PageShell>
      <PageCard>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <ListToolbar
          filters={
            <>
              <Select
                showSearch
                allowClear
                placeholder="고객 검색 (이름·전화)"
                style={{ width: 220 }}
                filterOption={false}
                onSearch={setCustomerKeyword}
                loading={customerQuery.isLoading}
                options={customerOptions}
                value={customerFilter}
                onChange={(v: string | undefined) => {
                  setCustomerFilter(v);
                  setPage(1);
                }}
              />
              <Select
                style={{ width: LAYOUT.filterWidth }}
                value={phaseFilter ?? FILTER_ALL}
                onChange={(v: string) => {
                  const next = v === FILTER_ALL ? undefined : (v as RepairPhase);
                  setPhaseFilter(next);
                  // 묶음을 바꾸면 그 안에 없는 세부 상태는 남겨 둘 수 없다.
                  if (next && statusFilter && !REPAIR_PHASE_STATUSES[next].includes(statusFilter)) {
                    setStatusFilter(undefined);
                  }
                  setPage(1);
                }}
                options={PHASE_FILTER_OPTIONS}
              />
              <Select
                style={{ width: LAYOUT.filterWidth }}
                value={statusFilter ?? FILTER_ALL}
                onChange={(v: string) => {
                  setStatusFilter(v === FILTER_ALL ? undefined : (v as RepairStatus));
                  setPage(1);
                }}
                options={statusOptions}
              />
            </>
          }
          actions={
            <Can permission="REPAIR_EDIT">
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setReceiptOpen(true)}>
                수선 접수
              </Button>
            </Can>
          }
        />

        <DataTable<Repair>
          rowKey="id"
          loading={listQuery.isLoading}
          dataSource={listQuery.data?.data ?? []}
          columns={columns}
          onRow={(r) => ({
            onClick: () => setExpandedId((cur) => (cur === r.id ? null : r.id)),
            style: { cursor: 'pointer' },
          })}
          // 펼친 행의 부모 줄을, 밑에 열리는 내용과 같은 색으로 칠해 선택한 행을 표시한다.
          rowClassName={(r) => (r.id === expandedId ? 'repair-row-expanded' : '')}
          pagination={{
            current: page,
            pageSize: size,
            total: listQuery.data?.page.totalElements ?? 0,
            onChange: (nextPage, nextSize) => {
              setPage(nextSize !== size ? 1 : nextPage);
              setSize(nextSize);
            },
          }}
          expandable={{
            showExpandColumn: false,
            expandedRowKeys: expandedId ? [expandedId] : [],
            expandedRowRender: (r) => {
              const detail = detailQuery.data?.id === r.id ? detailQuery.data : r;
              const events = detail.events;
              // 단계별 이벤트를 상태 코드로 매핑 — 되돌리기로 같은 단계를 여러 번 거치면
              // 가장 최근 전이를 남긴다(그 단계의 최신 날짜·담당자·사유가 보이도록).
              // events는 백엔드에서 시간순(오름차순)으로 오므로 그냥 덮어쓰면 최신이 남는다.
              // 품목·벌 이벤트는 아래 품목 표가 보여주므로 건 단위 전이만 추린다.
              const eventByStatus = new Map<string, RepairEvent>();
              for (const ev of events) {
                if (!ev.itemId && !ev.unitId) eventByStatus.set(ev.newStatus, ev);
              }
              const cancelled = r.status === 'CANCELLED';
              const cancelEvent = eventByStatus.get('CANCELLED');
              // 현재 상태 = 그 단계를 "끝낸" 상태다(접수 등록 = 접수 완료). 그래서 진행중 표시는
              // 다음 단계로 한 칸 민다 — 출고 완료면 flow 길이가 되어 전 단계가 모두 완료로 찍힌다.
              const statusIdx = REPAIR_STATUS_FLOW.indexOf(r.status as RepairStatus);
              const currentIndex = statusIdx + 1;

              // 고객 연락은 상태가 아니라 발송 액션이다 — 전 벌이 들어온 뒤(수선 입고)에 열리고,
              // 한 번 보냈으면(last_notified_at) [재발송]으로 뜬다. 되돌리기 개념은 없다.
              const notifiable = !cancelled && r.status === 'RETURNED_TO_SHOP';
              const alreadyNotified = !!r.lastNotifiedAt;
              const pending =
                notifyMutation.isPending && notifyMutation.variables?.id === r.id;

              /**
               * 단계 한 줄 — 단계명 옆에 날짜·담당자·그 단계 전체 상태를 이어 붙인다.
               * (`접수    2026-08-01 · 관리자 · 수선내용 : 기장 전체 적을  +5cm`)
               * 밑으로 내리면 단계마다 두 줄이 되어 5단계가 화면을 한참 넘긴다.
               *
               * 접수는 밑에 붙일 게 수선 내용 글자뿐이라 이 줄에 같이 태운다.
               * 나머지 단계의 품목 표·버튼은 글자가 아니라서 밑에 남는다.
               * 담당자가 적은 그대로 보여 준다 — 줄바꿈·띄어쓰기를 접어 버리면
               * "기장 전체  적을 +5cm"처럼 칸을 맞춰 적은 메모가 뭉개진다.
               */
              const stepTitle = (status: RepairStatus) => {
                const label = repairStatusMeta(status).label;
                const ev = eventByStatus.get(status);
                const stage = STAGE_BY_STATUS[status];
                const summary = stage ? repairStageSummary(detail.items, stage) : undefined;
                // 꼬리 공백·개행만 턴다 — 그대로 두면 단계 밑에 빈 줄이 하나 생긴다.
                // 가운데 띄어쓰기는 칸을 맞춰 적은 것이라 건드리지 않는다.
                const notes = r.notes?.trimEnd();
                const memo =
                  status === 'RECEIVED'
                    ? `수선내용 : ${r.description.trimEnd()}${notes ? ` · 비고 : ${notes}` : ''}`
                    : '';
                if (!ev && !summary && !memo) return label;
                const dot = (before: boolean) => (before ? ' · ' : '');
                return (
                  <>
                    {/*
                      단계 이름과 내용은 쌍점이 아니라 빈칸으로 가른다 — 한 줄이지만 읽을 때는
                      왼쪽(어느 단계)과 오른쪽(무슨 일이 있었나)이 다른 칸이다.
                      이름 칸에 폭을 줘 다섯 단계의 내용 시작 위치를 맞춘다 — 이름 길이가
                      2~4자로 제각각이라 그냥 띄우면 시작 위치가 단계마다 어긋난다.
                    */}
                    <span style={{ display: 'inline-block', minWidth: STEP_LABEL_WIDTH }}>
                      {label}
                    </span>
                    {/*
                      글자는 본문 크기·본문 색이다. 줄여 흐리게 두면 정작 읽어야 할
                      수선 내용이 안 보인다.
                    */}
                    <span style={{ whiteSpace: 'pre-wrap', fontWeight: 400 }}>
                      {ev ? `${ev.eventDate} · ${ev.actorName}` : ''}
                      {summary && (
                        <Typography.Text type={summary.done ? 'success' : undefined} strong>
                          {dot(!!ev)}
                          {summary.text}
                        </Typography.Text>
                      )}
                      {memo && `${dot(!!ev || !!summary)}${memo}`}
                    </span>
                  </>
                );
              };

              // 단계마다 그 단계에서 할 일을 붙인다 — 수선요청·입고·출고는 품목별 버튼,
              // 고객 연락은 발송 버튼. 표를 따로 두지 않으니 지금 눌러야 할 칸이
              // 어느 단계인지 한눈에 보인다(2026-08-01 현업 요청).
              // 접수는 글자뿐이라 단계 줄에 실었다 — stepTitle 참고.
              // 고객 연락 버튼 — 전 벌이 들어온 뒤(수선 입고) 입고 표 바로 뒤에 붙인다.
              // 한 번 보냈으면 [재발송]으로 뜬다(상태는 그대로 수선 입고).
              const notifyAction = notifiable && (
                <Can permission="REPAIR_EDIT">
                  {alreadyNotified ? (
                    <Button size="small" loading={pending} onClick={() => notifyMutation.mutate(r)}>
                      재발송
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      type="primary"
                      ghost
                      icon={<NotificationOutlined />}
                      loading={pending}
                      onClick={() => notifyMutation.mutate(r)}
                    >
                      고객 연락
                    </Button>
                  )}
                </Can>
              );

              const stepBody: Partial<Record<RepairStatus, React.ReactNode>> = {
                REQUESTED: <RepairItemProgress repair={detail} stage="REQUEST" showSummary={false} />,
                RETURNED_TO_SHOP: (
                  <RepairItemProgress
                    repair={detail}
                    stage="RETURN"
                    showSummary={false}
                    trailingAction={notifyAction}
                  />
                ),
                RELEASED: <RepairItemProgress repair={detail} stage="RELEASE" showSummary={false} />,
              };

              const stepItems = REPAIR_STATUS_FLOW.map((status) => {
                const body = stepBody[status];
                return {
                  title: stepTitle(status),
                  // 붙일 게 없는 단계는 설명 칸을 아예 비운다 — 빈 칸도 높이를 차지한다.
                  description: body ? (
                    <div
                      className="repair-step-body"
                      style={{ paddingLeft: STEP_BODY_INDENT, paddingBottom: 4 }}
                    >
                      {body}
                    </div>
                  ) : undefined,
                };
              });

              return (
                <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                  <Steps
                    size="small"
                    direction="vertical"
                    current={cancelled ? -1 : currentIndex}
                    status={cancelled ? 'error' : r.status === 'RELEASED' ? 'finish' : 'process'}
                    items={stepItems}
                  />
                  {cancelled && (
                    <Typography.Text type="danger">
                      취소됨{cancelEvent ? ` · ${cancelEvent.eventDate}` : ''}
                      {cancelEvent?.notes ? ` · 사유: ${cancelEvent.notes}` : ''}
                    </Typography.Text>
                  )}
                </Space>
              );
            },
          }}
        />
      </Space>
      </PageCard>

      {/* 수선 접수 모달 — 고객·대상 품목·수선 내용을 받는다. */}
      <Modal
        title="수선 접수"
        open={receiptOpen}
        onCancel={() => setReceiptOpen(false)}
        onOk={() => receiptForm.submit()}
        okText="접수"
        cancelText="취소"
        confirmLoading={createMutation.isPending}
        width={640}
        destroyOnHidden
      >
        <Form<ReceiptValues>
          form={receiptForm}
          layout="vertical"
          // 접수·출고 방식은 고객 방문이 대부분이라 기본값으로 채운다(방문 수거·배송만 바꿔 고른다).
          initialValues={{
            repairType: 'AFTER_SALE',
            requestDate: dayjs(),
            receiptMethod: 'VISIT',
            releaseMethod: 'VISIT',
          }}
          onFinish={(values) => createMutation.mutate(values)}
        >
          <Form.Item
            name="customerId"
            label="고객"
            rules={[{ required: true, message: '고객을 선택해 주세요.' }]}
          >
            <Select
              showSearch
              placeholder="이름·전화번호 검색"
              filterOption={false}
              onSearch={setCustomerKeyword}
              loading={customerQuery.isLoading}
              options={customerOptions}
            />
          </Form.Item>

          <Form.Item name="repairType" label="수선 유형" rules={[{ required: true }]}>
            <Select options={REPAIR_TYPES.map((t) => ({ value: t, label: repairTypeLabel(t) }))} />
          </Form.Item>

          {/*
            계약에 등록된 물품을 찾아 연결하지 않는다 — 품목과 개수를 줄 단위로 적는다.
            진행(수선요청·입고·출고)이 품목 위에서 돌아가므로 유형과 무관하게 필수다.
          */}
          <Form.List name="items" initialValue={[{ quantity: 1 }]}>
            {(fields, { add, remove }) => (
              <Form.Item
                label="대상 품목"
                required
                extra="입고·출고는 벌 단위로 처리합니다 — 개수를 정확히 적어 주세요."
              >
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {fields.map((field, index) => (
                    <Space key={field.key} size={8} align="start">
                      <Form.Item
                        name={[field.name, 'targetProduct']}
                        noStyle
                        rules={
                          // 첫 줄만 필수 — 나머지는 비워 두면 접수 시 버린다.
                          index === 0
                            ? [{ required: true, message: '대상 품목을 선택해 주세요.' }]
                            : []
                        }
                      >
                        <Select
                          allowClear
                          style={{ width: 200 }}
                          placeholder="품목 선택"
                          options={targetProductOptions}
                        />
                      </Form.Item>
                      <Form.Item name={[field.name, 'quantity']} noStyle initialValue={1}>
                        <InputNumber min={1} max={99} style={{ width: 90 }} addonAfter="개" />
                      </Form.Item>
                      {fields.length > 1 && (
                        <Button
                          type="text"
                          icon={<MinusCircleOutlined />}
                          onClick={() => remove(field.name)}
                          aria-label="품목 삭제"
                        />
                      )}
                    </Space>
                  ))}
                  <Button
                    type="dashed"
                    icon={<PlusOutlined />}
                    onClick={() => add({ quantity: 1 })}
                    style={{ width: 300 }}
                  >
                    품목 추가
                  </Button>
                </Space>
              </Form.Item>
            )}
          </Form.List>

          <Space size="middle" style={{ display: 'flex' }} align="start">
            <Form.Item
              name="requestDate"
              label="접수일"
              rules={[{ required: true, message: '접수일을 선택해 주세요.' }]}
            >
              <DatePicker />
            </Form.Item>
            <Form.Item name="dueDate" label="완료 예정일">
              <DatePicker />
            </Form.Item>
          </Space>

          <Form.Item
            name="description"
            label="수선 내용"
            rules={[{ required: true, message: '수선 내용을 입력해 주세요.' }]}
          >
            <Input.TextArea rows={3} placeholder="예: 하의 기장 1.5cm 줄임" />
          </Form.Item>
          {/* 설계 PDF 1페이지 "수선 물품 방문" — 고객 방문인지 우리가 오가는지 구분 */}
          <Space size="large" wrap align="start">
            <Form.Item name="receiptMethod" label="접수 방식">
              <Select
                allowClear
                style={{ width: 150 }}
                placeholder="선택"
                options={REPAIR_RECEIPT_METHODS.map((v) => ({
                  value: v,
                  label: REPAIR_METHOD_LABELS[v],
                }))}
              />
            </Form.Item>
            <Form.Item name="releaseMethod" label="출고 방식">
              <Select
                allowClear
                style={{ width: 150 }}
                placeholder="선택"
                options={REPAIR_RELEASE_METHODS.map((v) => ({
                  value: v,
                  label: REPAIR_METHOD_LABELS[v],
                }))}
              />
            </Form.Item>
          </Space>
          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) =>
              prev.receiptMethod !== cur.receiptMethod || prev.releaseMethod !== cur.releaseMethod
            }
          >
            {({ getFieldValue }) => (
              <>
                {getFieldValue('receiptMethod') === 'PICKUP' && (
                  <Form.Item
                    name="pickupAddress"
                    label="수거 주소"
                    rules={[{ required: true, message: '수거 주소를 입력해 주세요.' }]}
                  >
                    <Input placeholder="고객 물품을 받으러 갈 주소" maxLength={300} />
                  </Form.Item>
                )}
                {getFieldValue('releaseMethod') === 'DELIVERY' && (
                  <Form.Item
                    name="deliveryAddress"
                    label="배송 주소"
                    rules={[{ required: true, message: '배송 주소를 입력해 주세요.' }]}
                  >
                    <Input placeholder="완료된 물품을 가져다줄 주소" maxLength={300} />
                  </Form.Item>
                )}
              </>
            )}
          </Form.Item>

          <Form.Item name="notes" label="비고">
            <Input placeholder="예: 반납 검수 중 발견" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 수선은 진행 단계와 같은 확인창을 공유한다. 자동 발송은 하지 않는다. */}
      <NotificationConfirmModal
        open={suggestion != null}
        title={suggestionTitle}
        suggestion={suggestion}
        onDone={(outcome) => {
          setSuggestion(null);
          // 실제로 보냈을 때만 마지막 연락 시각을 찍는다(버튼이 [재발송]으로 바뀐다).
          // markNotified가 목록·발송 이력 캐시까지 갱신한다.
          if (outcome === 'SENT' && notifyRepairId) markNotifiedMutation.mutate(notifyRepairId);
          setNotifyRepairId(null);
        }}
        onCancel={() => {
          setSuggestion(null);
          setNotifyRepairId(null);
        }}
      />
    </PageShell>
  );
}
