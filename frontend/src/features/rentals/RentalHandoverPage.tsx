import { ArrowLeftOutlined, SwapOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Checkbox,
  DatePicker,
  Descriptions,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  ALLOCATION_NOTE_KIND_META,
  ALLOCATION_STATUS_META,
  RENTAL_ITEM_STATUS_META,
  RENTAL_COMPONENT_TYPE_LABELS,
  RETURN_NEXT_STATUSES,
  changeAllocationItem,
  checkoutAllocation,
  fetchAllocations,
  returnAllocation,
  type RentalAllocation,
  type RentalItemStatus,
} from '../../api/rentals';
import { LAYOUT } from '../../app/theme';
import { DataTable } from '../../shared/DataTable';
import { ListToolbar, PageCard, PageShell } from '../../shared/PageShell';
import { StatusBadge } from '../../shared/StatusBadge';
import { metaOf } from '../../shared/status-meta';
import { COL } from '../../shared/table-width';
import { Can } from '../../shared/Can';
import { RentalAllocationNotesModal } from './RentalAllocationNotesModal';
import { useRentalCodeNames } from './rental-codes';

/** 지난 내역 기본 조회 기간 — 최근 3개월 (현업 확정 2026-08-03) */
const defaultHistoryRange = (): [Dayjs, Dayjs] => [dayjs().subtract(3, 'month'), dayjs()];

/** RENT-004 렌탈 출고·반납 */
export function RentalHandoverPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [checkoutTarget, setCheckoutTarget] = useState<RentalAllocation | null>(null);
  const [returnTarget, setReturnTarget] = useState<RentalAllocation | null>(null);
  const [changeOpen, setChangeOpen] = useState(false);
  /** 연락·비고 창 대상 */
  const [notesTarget, setNotesTarget] = useState<RentalAllocation | null>(null);
  /** 아침에 "밀린 것부터" 볼 때 쓰는 조회. 기간·검색어와 함께 걸린다. */
  const [overdueOnly, setOverdueOnly] = useState(false);

  const [checkoutForm] = Form.useForm<{ checkoutDate: Dayjs; notes?: string }>();
  const [returnForm] = Form.useForm<{ returnDate: Dayjs; availableFrom: Dayjs; nextStatus: RentalItemStatus }>();
  const [changeForm] = Form.useForm<{ reason: string }>();

  // 진행 단계 카드 등에서 특정 주문으로 걸러 들어올 수 있게 한다 (?q=ORD-...).
  // q가 있으면 서버가 날짜 제한을 풀어 미래 픽업 예약·이미 출고된 건까지 함께 반환한다.
  const [searchParams, setSearchParams] = useSearchParams();
  const keyword = searchParams.get('q') ?? '';
  const q = keyword.trim();

  /*
   * 처리 탭(출고·반납)의 조회 기간. 비우면 지금까지처럼 오늘 기준 일일운영 목록이고,
   * 기간을 잡으면 대여 기간이 거기 걸치는 건을 전부 본다("8월에 나가는 옷" 식 조회).
   */
  const [period, setPeriod] = useState<[Dayjs, Dayjs] | null>(null);
  const periodParams = period
    ? { from: period[0].format('YYYY-MM-DD'), to: period[1].format('YYYY-MM-DD') }
    : {};
  const periodKey = period ? `${periodParams.from}~${periodParams.to}` : '';

  const pickupsQuery = useQuery({
    queryKey: ['rentals', 'allocations', 'pickup', q, periodKey, overdueOnly],
    queryFn: () => fetchAllocations('pickup', { q, ...periodParams, overdueOnly }),
  });
  const returnsQuery = useQuery({
    queryKey: ['rentals', 'allocations', 'return', q, periodKey, overdueOnly],
    queryFn: () => fetchAllocations('return', { q, ...periodParams, overdueOnly }),
  });

  // 지난 내역은 기간으로 찾는다 — 기본 최근 3개월, 버튼·달력으로 더 이전까지 늘릴 수 있다.
  const [historyRange, setHistoryRange] = useState<[Dayjs, Dayjs]>(defaultHistoryRange);
  const historyQuery = useQuery({
    queryKey: ['rentals', 'allocations', 'history', q, historyRange[0].format('YYYY-MM-DD'), historyRange[1].format('YYYY-MM-DD')],
    queryFn: () =>
      fetchAllocations('history', {
        q,
        from: historyRange[0].format('YYYY-MM-DD'),
        to: historyRange[1].format('YYYY-MM-DD'),
      }),
  });

  const pickups = pickupsQuery.data ?? [];
  const returns = returnsQuery.data ?? [];
  const history = historyQuery.data ?? [];

  // q로 진입했을 때는 실제 매칭 행이 있는 탭을 자동 선택한다.
  // (이미 출고된 건은 '반납 대상'에만 있고, 픽업 탭만 열려 "데이터 없음"으로 보이던 문제 해결)
  const [tabOverride, setTabOverride] = useState<string | null>(null);
  const autoTab = q && pickups.length === 0 && returns.length > 0 ? 'return' : 'pickup';
  const activeTab = tabOverride ?? autoTab;

  // 교체 후보 조회는 없앴다 — 개체를 고르지 않고 서버가 같은 규격에서 하나를 집는다.

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['rentals'] });

  const checkoutMutation = useMutation({
    mutationFn: (v: { checkoutDate: Dayjs; notes?: string }) =>
      checkoutAllocation(checkoutTarget!.id, {
        checkoutDate: v.checkoutDate.format('YYYY-MM-DD'),
        notes: v.notes?.trim() || undefined,
        version: checkoutTarget!.version,
      }),
    onSuccess: () => {
      // 응답은 평탄화 뷰가 아니라 customerName이 없다 — 목록에서 온 대상 행으로 라벨을 만든다.
      message.success(`${allocLabel(checkoutTarget!)} 출고 처리되었습니다.`);
      setCheckoutTarget(null);
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '출고 처리에 실패했습니다.'),
  });

  const changeMutation = useMutation({
    // 개체는 지정하지 않는다 — 같은 규격에서 비어 있는 다른 실물을 서버가 고른다.
    // 규격이 같은 옷이 여러 벌이면 코드 목록을 보여 줘도 고를 근거가 없다.
    mutationFn: (v: { reason: string }) =>
      changeAllocationItem(checkoutTarget!.id, {
        reason: v.reason,
        version: checkoutTarget!.version,
      }),
    onSuccess: (alloc) => {
      message.success('같은 규격의 다른 실물로 교체했습니다. 이어서 출고하세요.');
      setChangeOpen(false);
      setCheckoutTarget(alloc); // 변경된 배정으로 이어서 출고
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '실물 교체에 실패했습니다.'),
  });

  const returnMutation = useMutation({
    mutationFn: (v: { returnDate: Dayjs; availableFrom: Dayjs; nextStatus: RentalItemStatus }) =>
      returnAllocation(returnTarget!.id, {
        returnDate: v.returnDate.format('YYYY-MM-DD'),
        availableFrom: v.availableFrom.format('YYYY-MM-DD'),
        nextStatus: v.nextStatus,
        version: returnTarget!.version,
      }),
    onSuccess: () => {
      // 응답은 평탄화 뷰가 아니라 customerName이 없다 — 목록에서 온 대상 행으로 라벨을 만든다.
      message.success(`${allocLabel(returnTarget!)} 반납 처리되었습니다.`);
      setReturnTarget(null);
      void invalidate();
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '반납 처리에 실패했습니다.'),
  });

  // 출고·반납 대상은 품목을 가리지 않으므로 전 품목 코드를 받아 이름으로 바꾼다.
  const codes = useRentalCodeNames();

  const todayStr = dayjs().format('YYYY-MM-DD');

  /**
   * 출고·반납 공통 열.
   * 현장에서 필요한 건 "누가 / 무엇을 / 어떤 옷을"이다 —
   * 고객은 연락처까지, 실물은 관리코드만이 아니라 구분·컬러·사이즈까지 보여 준다.
   */
  const commonColumns: ColumnsType<RentalAllocation> = [
    {
      title: '고객',
      dataIndex: 'customerName',
      width: COL.name,
      render: (name: string, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{name}</Typography.Text>
          {r.customerPhone && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.customerPhone}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    { title: '주문번호', dataIndex: 'orderNo', width: COL.code },
    {
      title: '주문 품목',
      dataIndex: 'displayName',
      width: COL.wide,
      render: (v: string | undefined, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{v ?? '-'}</Typography.Text>
          {r.componentType && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {RENTAL_COMPONENT_TYPE_LABELS[r.componentType] ?? r.componentType}
              {r.componentSequenceNo ? ` #${r.componentSequenceNo}` : ''}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      // 관리코드는 걷어냈다 — 현장에서 실물과 코드가 1:1로 맞지 않아 쓸 수 없는 값이다
      // (현업 확정 2026-07-31). 옷은 규격(컬러·사이즈)으로 가린다.
      title: '규격',
      dataIndex: 'color',
      width: COL.color,
      render: (color: string, r) => (
        <Typography.Text>
          {codes.colorName(color)} / {codes.sizeName(r.size)}
        </Typography.Text>
      ),
    },
  ];

  /** "홍길동 · 상의(자켓)" — 관리코드 대신 이 표기로 처리 결과를 알린다. */
  const allocLabel = (r: RentalAllocation) => {
    const type = r.componentType ? (RENTAL_COMPONENT_TYPE_LABELS[r.componentType] ?? r.componentType) : null;
    return type ? `${r.customerName} · ${type}` : r.customerName;
  };

  /**
   * 반납 모달 안내문. 세탁 확인 때문에 반납 즉시 다시 빌려줄 수 없고, 며칠 잡는지는
   * 색 계열마다 다르다 — 몇 일인지 말해 주지 않으면 날짜가 왜 그렇게 찍혔는지 알 수 없다.
   */
  const cleaningNotice = (r: RentalAllocation | null) => {
    const days = r?.cleaningDays;
    const color = r?.color ? codes.colorName(r.color) : null;
    if (!days) return '반납 후에는 정비 기간이 지나야 다시 대여할 수 있습니다.';
    return `${color ? `${color} — ` : ''}세탁 확인에 ${days}일이 걸립니다. 그날이 되면 자동으로 대여 가능으로 바뀝니다.`;
  };

  /**
   * 진행 상태 — 날짜에서 계산되는 값이라 저장하지 않는다(배정 상태는 예약·출고·반납·취소 넷).
   * 며칠 밀렸는지까지 쓴다. 하루 늦은 건과 열흘 늦은 건은 대응이 다르다.
   */
  const progressCell = (r: RentalAllocation) => {
    const days = r.overdueDays ?? 0;
    // 점(배지)은 지연에만 붙인다 — 정상 진행까지 색을 달면 눈이 어디에도 안 멈춘다.
    const overdue = (label: string) => <StatusBadge label={label} color="red" />;
    const plain = (label: string) => <Typography.Text>{label}</Typography.Text>;
    if (r.status === 'RESERVED')
      return days > 0
        ? overdue(`미픽업 ${days}일`)
        : plain(r.pickupDate === todayStr ? '오늘 픽업' : `픽업 예정 D-${dayjs(r.pickupDate).diff(todayStr, 'day')}`);
    if (r.status === 'CHECKED_OUT')
      return days > 0
        ? overdue(`반납 지연 ${days}일`)
        : plain(r.returnDueDate === todayStr ? '오늘 반납' : '대여 중');
    if (r.status === 'RETURNED') return days > 0 ? overdue(`지연 반납 ${days}일`) : plain('반납 완료');
    return plain(metaOf(ALLOCATION_STATUS_META, r.status).label);
  };

  /** 연락 횟수·비고 — 누르면 연락·비고 창이 열린다. 세 탭이 같은 두 열을 쓴다. */
  const noteColumns: ColumnsType<RentalAllocation> = [
    {
      title: '연락',
      key: 'contact',
      width: COL.count,
      align: 'center',
      // 몇 번 연락했는지가 이 칸의 답이다 — 0회도 숫자로 쓴다(빈 칸이면 안 세어 본 것과 구분이 안 된다).
      render: (_, r) => (
        <Button size="small" type="link" onClick={() => setNotesTarget(r)}>
          {r.contactCount ?? 0}회
        </Button>
      ),
    },
    {
      title: '비고',
      key: 'note',
      width: COL.text,
      // 가장 최근 한 줄만. 전체는 연락·비고 창에서 본다.
      render: (_, r) =>
        r.lastNote ? (
          <Space direction="vertical" size={0} style={{ cursor: 'pointer' }} onClick={() => setNotesTarget(r)}>
            <Space size={4}>
              <Tag color={metaOf(ALLOCATION_NOTE_KIND_META, r.lastNote.kind).color}>
                {metaOf(ALLOCATION_NOTE_KIND_META, r.lastNote.kind).label}
              </Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {dayjs(r.lastNote.createdAt).format('M/D')} {r.lastNote.actorName}
              </Typography.Text>
            </Space>
            <Typography.Text ellipsis={{ tooltip: r.lastNote.body }}>{r.lastNote.body}</Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
  ];

  /**
   * 연락 버튼은 지연 건에만 둔다 — 제때 가는 건까지 버튼을 달면 액션 칸이 두 개로 늘어
   * 정작 눌러야 할 [출고]·[반납]이 묻힌다. 지연이 아닌 건도 연락 칸의 횟수를 누르면
   * 같은 창이 열리므로 길이 막히지는 않는다.
   */
  const contactButton = (r: RentalAllocation) =>
    (r.overdueDays ?? 0) > 0 ? (
      <Can permission="NOTIFICATION_SEND">
        <Button size="small" danger onClick={() => setNotesTarget(r)}>
          연락
        </Button>
      </Can>
    ) : null;

  const pickupColumns: ColumnsType<RentalAllocation> = [
    ...commonColumns,
    { title: '픽업일', dataIndex: 'pickupDate', width: COL.name },
    { title: '반납 예정일', dataIndex: 'returnDueDate', width: COL.name },
    { title: '진행 상태', key: 'progress', width: COL.name, render: (_, r) => progressCell(r) },
    ...noteColumns,
    {
      title: '액션',
      key: 'actions',
      width: COL.action2,
      render: (_, r) => (
        <Space size={4}>
          <Button
            size="small"
            type="primary"
            onClick={() => {
              setCheckoutTarget(r);
              checkoutForm.setFieldsValue({ checkoutDate: dayjs(), notes: undefined });
            }}
          >
            출고
          </Button>
          {contactButton(r)}
        </Space>
      ),
    },
  ];

  /** 지난 내역 — 끝난 건이라 처리 버튼이 없다. "언제 나갔다 언제 들어왔나"가 전부다. */
  const historyColumns: ColumnsType<RentalAllocation> = [
    ...commonColumns,
    {
      title: '출고일',
      dataIndex: 'actualPickupAt',
      width: COL.name,
      render: (v: string | null | undefined, r) => v?.slice(0, 10) ?? r.pickupDate ?? '-',
    },
    {
      title: '반납일',
      dataIndex: 'actualReturnAt',
      width: COL.name,
      // 취소 건은 나간 적이 없어 반납일도 없다.
      render: (v: string | null | undefined) => v?.slice(0, 10) ?? '-',
    },
    { title: '반납 예정일', dataIndex: 'returnDueDate', width: COL.name },
    // 예정일보다 늦게 들어온 건은 끝난 뒤에도 표가 나야 한다 — 진행 상태가 일수까지 말해 준다.
    { title: '진행 상태', key: 'progress', width: COL.name, render: (_, r) => progressCell(r) },
    ...noteColumns,
  ];

  const returnColumns: ColumnsType<RentalAllocation> = [
    ...commonColumns,
    {
      title: '출고일',
      dataIndex: 'checkoutDate',
      width: COL.name,
      // 예정일이 아니라 실제로 나간 날. 백엔드 뷰는 actualPickupAt으로 내려 준다.
      render: (d: string | undefined, r) => d ?? r.actualPickupAt?.slice(0, 10) ?? '-',
    },
    { title: '반납 예정일', dataIndex: 'returnDueDate', width: COL.name },
    { title: '진행 상태', key: 'progress', width: COL.name, render: (_, r) => progressCell(r) },
    ...noteColumns,
    {
      title: '액션',
      key: 'actions',
      width: COL.action2,
      render: (_, r) => (
        <Space size={4}>
        <Button
          size="small"
          onClick={() => {
            setReturnTarget(r);
            returnForm.setFieldsValue({
              returnDate: dayjs(),
              // 정비 소요일은 색 계열마다 다르다 — 서버가 계산한 값을 그대로 쓴다.
              availableFrom: r.suggestedAvailableFrom
                ? dayjs(r.suggestedAvailableFrom)
                : dayjs().add(r.cleaningDays ?? 1, 'day'),
              nextStatus: 'RETURNED_HOLD',
            });
          }}
        >
          반납
        </Button>
          {contactButton(r)}
        </Space>
      ),
    },
  ];

  return (
    <PageShell>
      <PageCard>
        {/* 화면끼리 잇던 [재고 목록]·[가용 검색·배정으로] 버튼은 뺐다 —
            좌측 메뉴 "렌탈 관리" 아래 같은 이동이 있고, 렌탈 세 화면이 그 버튼을
            저마다 다른 자리에 두는 바람에 배치가 어긋나 있었다. */}
        {/*
          검색과 기간은 탭 밖에 둔다 — 같은 조건으로 세 탭을 오가며 보게 된다.
          기간의 뜻만 탭마다 다르다: 처리 탭은 대여 기간(걸치면 나온다), 지난 내역은 처리일.
        */}
        <ListToolbar
          filters={
            <Space size={8} wrap>
              <Input.Search
                allowClear
                style={{ width: LAYOUT.searchWidth }}
                placeholder="고객명 · 주문번호 · 실물 ID 검색"
                defaultValue={keyword}
                onSearch={(v) => {
                  const next = new URLSearchParams(searchParams);
                  if (v.trim()) next.set('q', v.trim());
                  else next.delete('q');
                  setSearchParams(next, { replace: true });
                }}
              />
              {activeTab === 'history' ? (
                <>
                  <Typography.Text type="secondary">반납·취소일</Typography.Text>
                  <DatePicker.RangePicker
                    allowClear={false}
                    value={historyRange}
                    onChange={(v) => v && setHistoryRange([v[0]!, v[1]!])}
                  />
                  {/* 기본은 최근 3개월. 더 이전 건은 기간을 늘려 찾는다. */}
                  <Button onClick={() => setHistoryRange(defaultHistoryRange())}>최근 3개월</Button>
                  <Button onClick={() => setHistoryRange([dayjs().subtract(1, 'year'), dayjs()])}>최근 1년</Button>
                  <Button onClick={() => setHistoryRange([dayjs('2020-01-01'), dayjs()])}>전체 기간</Button>
                </>
              ) : (
                <>
                  <Typography.Text type="secondary">대여 기간</Typography.Text>
                  <DatePicker.RangePicker
                    value={period}
                    onChange={(v) => setPeriod(v && v[0] && v[1] ? [v[0], v[1]] : null)}
                  />
                  <Typography.Text type="secondary">
                    {period ? '기간에 걸치는 건 모두' : '비우면 오늘 기준'}
                  </Typography.Text>
                  {/* 밀린 것부터 훑을 때 쓴다 — 지연일수는 서버가 계산한다. */}
                  <Checkbox checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)}>
                    지연만 보기
                  </Checkbox>
                </>
              )}
            </Space>
          }
        />

        <Tabs
          style={{ marginTop: 8 }}
          activeKey={activeTab}
          onChange={setTabOverride}
          items={[
            {
              key: 'pickup',
              label: `오늘 픽업(출고) 예정 (${pickups.length})`,
              children: (
                <DataTable<RentalAllocation>
                  rowKey="id"
                  loading={pickupsQuery.isLoading}
                  dataSource={pickups}
                  columns={pickupColumns}
                  pagination={false}
                />
              ),
            },
            {
              key: 'return',
              label: `반납 대상 (대여 중 ${returns.length})`,
              children: (
                <DataTable<RentalAllocation>
                  rowKey="id"
                  loading={returnsQuery.isLoading}
                  dataSource={returns}
                  columns={returnColumns}
                  pagination={false}
                />
              ),
            },
            {
              /*
               * 끝난 건(반납 완료·취소). 앞의 두 탭은 처리하러 오는 화면이라 지금 상태인 것만
               * 떠야 하고, 지난 기록은 여기서 기간으로 찾는다. 처리 버튼은 두지 않는다.
               */
              key: 'history',
              label: `지난 내역 (${history.length})`,
              children: (
                <DataTable<RentalAllocation>
                  rowKey="id"
                  loading={historyQuery.isLoading}
                  dataSource={history}
                  columns={historyColumns}
                  pagination={false}
                />
              ),
            },
          ]}
        />
      </PageCard>

      {/* 출고 모달: 확인 ID 검증 → 불일치 시 RENTAL_ID_MISMATCH → ID 변경 */}
      <Modal
        title={checkoutTarget ? `출고 — ${checkoutTarget.customerName} · ${checkoutTarget.displayName ?? allocLabel(checkoutTarget)}` : '출고'}
        open={!!checkoutTarget}
        onCancel={() => setCheckoutTarget(null)}
        onOk={() => checkoutForm.submit()}
        okText="출고"
        cancelText="취소"
        confirmLoading={checkoutMutation.isPending}
        destroyOnHidden
      >
        {checkoutTarget && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" bordered column={1}>
              <Descriptions.Item label="예약 규격">
                <Space>
                  <Typography.Text strong>
                    {codes.colorName(checkoutTarget.color)} / {codes.sizeName(checkoutTarget.size)}
                  </Typography.Text>
                  {/*
                    확인 ID 대조를 없애면서 실물 교체로 들어가는 유일한 입구였던
                    불일치 알림도 함께 사라졌다 — 상시 버튼으로 되살린다.
                    비고는 기록용이고, 배정 자체를 바꾸려면 이쪽을 쓴다.
                  */}
                  <Button
                    size="small"
                    icon={<SwapOutlined />}
                    onClick={() => {
                      changeForm.resetFields();
                      setChangeOpen(true);
                    }}
                  >
                    실물 교체
                  </Button>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="대여 기간">
                {checkoutTarget.pickupDate} ~ {checkoutTarget.returnDueDate}
              </Descriptions.Item>
            </Descriptions>

            <Form
              form={checkoutForm}
              layout="vertical"
              onFinish={(values) => checkoutMutation.mutate(values)}
            >
              <Form.Item
                name="checkoutDate"
                label="실제 출고일"
                rules={[{ required: true, message: '출고일을 선택해 주세요.' }]}
              >
                <DatePicker style={{ width: '100%' }} autoFocus />
              </Form.Item>
              {/*
                예약된 옷과 다른 걸 내보낸 경우 등 현장 상황을 적어 둔다.
                배정 자체를 바꾸려면 아래 [배정 실물 변경]을 쓴다 — 이 비고는 기록용이다.
              */}
              <Form.Item name="notes" label="비고 (선택)">
                <Input.TextArea
                  rows={3}
                  placeholder="예: 예약된 48호 대신 50호로 출고 (사이즈 교환 요청)"
                />
              </Form.Item>
            </Form>
          </Space>
        )}
      </Modal>

      {/* 실물 교체: 사유만 받고 같은 규격의 다른 실물로 서버가 바꿔 준다 */}
      <Modal
        title="실물 교체"
        open={changeOpen}
        onCancel={() => setChangeOpen(false)}
        onOk={() => changeForm.submit()}
        okText="교체"
        cancelText="취소"
        confirmLoading={changeMutation.isPending}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={
            checkoutTarget
              ? `${codes.colorName(checkoutTarget.color)} / ${codes.sizeName(checkoutTarget.size)} — 같은 규격에서 그 기간에 비어 있는 다른 실물로 바꿉니다.`
              : '같은 규격에서 그 기간에 비어 있는 다른 실물로 바꿉니다.'
          }
          description="다른 규격으로 바꾸려면 예약을 다시 잡아야 합니다."
        />
        <Form
          form={changeForm}
          layout="vertical"
          onFinish={(values) => changeMutation.mutate(values)}
        >
          <Form.Item
            name="reason"
            label="교체 사유"
            rules={[{ required: true, message: '교체 사유를 입력해 주세요.' }]}
          >
            <Input.TextArea rows={2} placeholder="예: 오염 확인으로 동일 규격 실물 교체" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 반납 모달: 실반납일 + 대여 가능 예정일 + 다음 상태 */}
      <Modal
        title={returnTarget ? `반납 — ${allocLabel(returnTarget)}` : '반납'}
        open={!!returnTarget}
        onCancel={() => setReturnTarget(null)}
        onOk={() => returnForm.submit()}
        okText="반납 처리"
        cancelText="취소"
        confirmLoading={returnMutation.isPending}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={cleaningNotice(returnTarget)}
        />
        <Form
          form={returnForm}
          layout="vertical"
          onFinish={(values) => returnMutation.mutate(values)}
          // 반납일을 바꾸면 대여 가능 예정일도 같은 정비일만큼 따라 움직인다 —
          // 어제 들어온 옷을 오늘 입력할 때 날짜를 두 번 고쳐야 했다.
          onValuesChange={(changed: { returnDate?: Dayjs }) => {
            if (!changed.returnDate || !returnTarget?.cleaningDays) return;
            returnForm.setFieldValue(
              'availableFrom',
              changed.returnDate.add(returnTarget.cleaningDays, 'day'),
            );
          }}
        >
          <Form.Item
            name="returnDate"
            label="실제 반납일"
            rules={[{ required: true, message: '실제 반납일을 선택해 주세요.' }]}
          >
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="availableFrom"
            label="대여 가능 예정일"
            rules={[{ required: true, message: '대여 가능 예정일을 선택해 주세요.' }]}
            extra="정비 기준으로 채워집니다. 세탁이 빨리 끝났거나 더 걸리면 직접 고치세요."
          >
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="nextStatus"
            label="다음 상태"
            rules={[{ required: true, message: '다음 상태를 선택해 주세요.' }]}
          >
            <Select
              options={RETURN_NEXT_STATUSES.map((s) => ({
                value: s,
                label: metaOf(RENTAL_ITEM_STATUS_META, s).label,
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      <RentalAllocationNotesModal allocation={notesTarget} onClose={() => setNotesTarget(null)} />

      <PageCard>
        <Space size="large" wrap>
          {/* 확인사항 등 다른 화면에서 특정 주문으로 걸러 들어온다. 온 곳으로 되돌린다. */}
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)}>
            이전화면
          </Button>
          <StatusBadge label="지연: 픽업일 또는 반납 예정일이 오늘 이전" color="red" />
        </Space>
      </PageCard>
    </PageShell>
  );
}
