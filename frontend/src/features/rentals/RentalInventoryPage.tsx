import { PauseCircleOutlined, PlusOutlined, RollbackOutlined, SearchOutlined, StopOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Typography,
} from 'antd';
import type { RadioChangeEvent } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  RENTAL_COMPONENT_TYPE_LABELS,
  RENTAL_ITEM_STATUS_META,
  createRentalItem,
  fetchRentalColors,
  fetchRentalInventorySummary,
  fetchRentalItemDetail,
  fetchRentalItems,
  fetchRentalSizes,
  postRentalItemStatusEvent,
  retireRentalItem,
  type RentalComponentType,
  type RentalItem,
  type RentalItemDetail,
  type RentalItemStatus,
} from '../../api/rentals';
import { Can } from '../../shared/Can';
import { DataTable, DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from '../../shared/DataTable';
import { ListToolbar, PageCard, PageShell } from '../../shared/PageShell';
import { StatusBadge } from '../../shared/StatusBadge';
import { autoWidth } from '../../shared/table-width';
import { componentTypeOptions, liveStatusOptions } from './rental-constants';
import { useRentalCodeNames } from './rental-codes';

/** 품목 대분류 버튼 값 — 'ALL'은 품목 조건 없음. */
type ComponentFilter = RentalComponentType | 'ALL';

interface FilterValues {
  componentType?: RentalComponentType;
  /** 폐기만 보기 — 기본(false)은 폐기를 뺀 살아 있는 재고만 */
  retired?: boolean;
  color?: string;
  skuSize?: string;
  status?: RentalItemStatus;
  availableOn?: Dayjs;
}

interface RegisterValues {
  componentType: RentalComponentType;
  color: string;
  size: string;
  quantity: number;
  managementCode: string;
  notes?: string;
}

/** RENT-001 렌탈 실물 재고 목록 */
export function RentalInventoryPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [filterForm] = Form.useForm<FilterValues>();
  const [registerForm] = Form.useForm<RegisterValues>();
  const [filters, setFilters] = useState<FilterValues>({});
  const [registerOpen, setRegisterOpen] = useState(false);
  // 폐기 사유를 받는 모달 대상. null이면 닫힘.
  const [retireTarget, setRetireTarget] = useState<RentalItem | null>(null);
  const [retireForm] = Form.useForm<{ reason: string }>();
  // 사용불가/재개 사유를 받는 모달 대상. 어느 방향인지 next에 담는다.
  const [statusTarget, setStatusTarget] = useState<{ item: RentalItem; next: RentalItemStatus } | null>(null);
  const [statusForm] = Form.useForm<{ reason: string }>();
  // 표에서 고른 행 — 하단 패널에 등록 비고·폐기 사유를 펼친다.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /*
   * E10: 컬러·사이즈는 기준정보(rental_colors/rental_sizes) 활성 코드에서 고른다.
   * 품목마다 쓰는 코드가 달라(상의 46~60·구두 250~280, 셔츠는 흰색뿐) 등록 모달에서 고른
   * 구분을 그대로 넘겨 그 품목 것만 받아온다. 구분을 아직 안 골랐으면 조회하지 않는다.
   */
  const registerComponentType = Form.useWatch('componentType', registerForm);
  const colorsQuery = useQuery({
    queryKey: ['rentals', 'colors', registerComponentType],
    queryFn: () => fetchRentalColors(registerComponentType),
    enabled: !!registerComponentType,
  });
  const sizesQuery = useQuery({
    queryKey: ['rentals', 'sizes', registerComponentType],
    queryFn: () => fetchRentalSizes(registerComponentType),
    enabled: !!registerComponentType,
  });
  const colorSelectOptions = useMemo(
    () => (colorsQuery.data ?? []).map((c) => ({ value: c.code, label: `${c.name} (${c.code})` })),
    [colorsQuery.data],
  );
  const sizeSelectOptions = useMemo(
    () => (sizesQuery.data ?? []).map((s) => ({ value: s.code, label: `${s.name} (${s.code})` })),
    [sizesQuery.data],
  );

  /*
   * 검색바의 컬러·사이즈 선택지 + 표 표시명 — 위에서 고른 품목의 코드만 내려온다.
   * 품목 미선택(전체)이면 componentType 없이 불러 전 품목 코드가 온다.
   */
  const codes = useRentalCodeNames(filters.componentType);

  /**
   * 품목 대분류 전환. 앞 품목에서 고른 컬러·사이즈는 새 품목에 없는 코드라
   * (구두 260 → 정장상의) 남겨 두면 결과가 0건이 된다. 함께 비운다.
   */
  const onComponentChange = (next: ComponentFilter) => {
    const componentType = next === 'ALL' ? undefined : next;
    filterForm.setFieldsValue({ color: undefined, skuSize: undefined });
    setFilters((prev) => ({ ...prev, componentType, color: undefined, skuSize: undefined }));
  };

  // 버튼에 붙일 품목별 건수 — 품목 외 조건이 바뀌면 같이 갱신된다.
  const summaryQuery = useQuery({
    queryKey: [
      'rentals', 'inventory', 'summary',
      filters.color, filters.skuSize, filters.status, filters.retired, filters.availableOn,
    ],
    queryFn: () =>
      fetchRentalInventorySummary({
        color: filters.color,
        skuSize: filters.skuSize,
        status: filters.status,
        retired: filters.retired,
        availableOn: filters.availableOn?.format('YYYY-MM-DD'),
      }),
  });

  const listQuery = useQuery({
    queryKey: ['rentals', 'inventory', filters],
    queryFn: () =>
      fetchRentalItems({
        componentType: filters.componentType,
        color: filters.color,
        skuSize: filters.skuSize,
        status: filters.status,
        retired: filters.retired,
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

  // 선택 행의 비고·폐기 사유는 상세 응답에만 있다(목록 응답에는 상태 이력이 없다).
  const selectedQuery = useQuery({
    queryKey: ['rentals', 'inventory', 'detail', selectedId],
    queryFn: () => fetchRentalItemDetail(selectedId as string),
    enabled: !!selectedId,
  });

  const retireMutation = useMutation({
    mutationFn: (v: { id: string; reason: string }) => retireRentalItem(v.id, { reason: v.reason }),
    onSuccess: (_data, v) => {
      message.success('폐기 처리되었습니다.');
      setRetireTarget(null);
      retireForm.resetFields();
      // 방금 적은 사유가 하단에 바로 보이도록 그 행을 선택 상태로 둔다.
      setSelectedId(v.id);
      void queryClient.invalidateQueries({ queryKey: ['rentals'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '폐기 처리에 실패했습니다.'),
  });

  /**
   * 임시 사용불가 ↔ 대여 가능 토글.
   * 상세 화면을 없앴으므로 되돌릴 길이 여기밖에 없다 — 한 버튼이 양방향을 맡는다.
   */
  const availabilityMutation = useMutation({
    mutationFn: (v: { item: RentalItem; next: RentalItemStatus; reason: string }) =>
      postRentalItemStatusEvent(v.item.id, {
        newStatus: v.next,
        reason: v.reason,
        version: v.item.version,
      }),
    onSuccess: (_d, v) => {
      message.success(v.next === 'UNAVAILABLE' ? '임시 사용불가로 바꿨습니다.' : '대여 가능으로 되돌렸습니다.');
      setStatusTarget(null);
      statusForm.resetFields();
      // 방금 적은 사유를 하단에서 바로 확인할 수 있게 그 행을 선택해 둔다.
      setSelectedId(v.item.id);
      void queryClient.invalidateQueries({ queryKey: ['rentals'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '상태 변경에 실패했습니다.'),
  });

  const quantity = Form.useWatch('quantity', registerForm) ?? 1;

  const columns: ColumnsType<RentalItem> = [
    // 관리코드가 실물 한 벌을 가리키는 식별자다 — 현장에서 옷에 붙은 코드를 보고 찾으므로 맨 앞에 둔다.
    // (품목은 이미 위 버튼으로 걸러 놓고 들어오는 자리라 표 안에서 앞자리를 차지할 이유가 없다)
    {
      title: '관리코드',
      dataIndex: 'managementCode',
      ...autoWidth(),
    },
    {
      title: '구분',
      dataIndex: 'componentType',
      render: (c: RentalComponentType) => RENTAL_COMPONENT_TYPE_LABELS[c] ?? c,
      ...autoWidth(),
    },
    // 실물이 들고 다니는 값은 코드(BLACK/46)다 — 검색 드롭다운과 같은 말이 되게 이름으로 바꿔 보여 준다.
    { title: '컬러', dataIndex: 'color', render: (v: string) => codes.colorName(v), ...autoWidth() },
    { title: '사이즈', dataIndex: 'size', render: (v: string) => codes.sizeName(v), ...autoWidth() },
    {
      title: '상태',
      dataIndex: 'status',
      render: (s: RentalItemStatus) => (
        <StatusBadge label={RENTAL_ITEM_STATUS_META[s]?.label ?? s} color={RENTAL_ITEM_STATUS_META[s]?.color} />
      ),
      ...autoWidth(),
    },
    // '대여 가능 예정일'·'현재 배정 / 고객' 열은 뺐다 — 이 화면은 품목 등록·폐기를 하는 곳이고,
    // 예약 상황은 렌탈 예약·출고·반납 화면에서 본다. currentAllocation 자체는 폐기 가능 여부
    // 판정에 계속 쓰이므로 응답에서 받아 두되 표에는 그리지 않는다.
    {
      title: '액션',
      key: 'actions',
      ...autoWidth(),
      // 폐기는 사유를 필수로 받아야 해서 Popconfirm 대신 모달을 연다.
      // 대여 중·예약된 실물은 둘 다 막는다 — 고객에게 나갈 옷을 빼면 안 된다.
      render: (_, r) => {
        const locked = r.status === 'RETIRED' || !!r.currentAllocation;
        const unavailable = r.status === 'UNAVAILABLE';
        return (
          <Can permission="RENTAL_EDIT">
            <Space size="small">
              <Button
                size="small"
                icon={unavailable ? <RollbackOutlined /> : <PauseCircleOutlined />}
                disabled={locked}
                onClick={() => {
                  setStatusTarget({ item: r, next: unavailable ? 'AVAILABLE' : 'UNAVAILABLE' });
                  statusForm.resetFields();
                }}
              >
                {unavailable ? '사용 재개' : '임시 사용불가'}
              </Button>
              <Button
                size="small"
                danger
                icon={<StopOutlined />}
                disabled={locked}
                onClick={() => {
                  setRetireTarget(r);
                  retireForm.resetFields();
                }}
              >
                폐기 처리
              </Button>
            </Space>
          </Can>
        );
      },
    },
  ];

  return (
    <PageShell>
      <PageCard>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {/*
          품목 대분류는 매번 쓰는 축이라 [검색]을 거치지 않고 누르는 즉시 목록이 바뀐다.
          Segmented는 배경만 옅게 깔려 눌리는 버튼으로 보이지 않았다 — 테두리가 있고
          선택 시 꽉 찬 색으로 바뀌는 Radio 버튼 그룹으로 바꾼다.
          나머지 조건(컬러·사이즈·상태·가능일)은 조합해서 쓰는 값이라 기존대로 [검색]으로 묶는다.
        */}
        <Radio.Group
          value={filters.componentType ?? 'ALL'}
          optionType="button"
          buttonStyle="solid"
          onChange={(e: RadioChangeEvent) => onComponentChange(e.target.value as ComponentFilter)}
        >
          {/* 건수는 눌러 보기 전에 어디에 재고가 있는지 알려 준다. 집계 전에는 자리만 비워 둔다. */}
          <Radio.Button value="ALL">전체 {summaryQuery.data?.total ?? ''}</Radio.Button>
          {componentTypeOptions.map((o) => (
            <Radio.Button key={o.value} value={o.value}>
              {o.label} {summaryQuery.data?.byComponentType[o.value] ?? ''}
            </Radio.Button>
          ))}
        </Radio.Group>

        <ListToolbar
          filters={
            /*
              필터에 "구분 :", "컬러 :" 처럼 라벨을 달아 두면 렌탈 화면만 다른 시스템처럼 보였다.
              다른 목록과 같이 라벨 없이 placeholder 로 뜻을 전달한다.
              Form 은 값 관리·초기화 때문에 그대로 두고 라벨만 걷어낸다.
              품목(componentType)은 위 버튼 그룹이 맡으므로 이 Form에는 두지 않는다.
            */
            <Form<FilterValues>
              form={filterForm}
              layout="inline"
              // 품목은 Form 밖에 있어 values에 없다 — 덮어쓰지 않도록 이전 값을 남긴다.
              onFinish={(values) => setFilters((prev) => ({ ...values, componentType: prev.componentType }))}
              style={{ rowGap: 8, columnGap: 0 }}
            >
              {/* 컬러·사이즈는 코드값이라 손으로 칠 수 없다 — 위에서 고른 품목의 코드만 목록으로 준다. */}
              <Form.Item name="color">
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  placeholder="컬러 전체"
                  style={{ width: 190 }}
                  loading={codes.isLoading}
                  options={codes.colorOptions}
                />
              </Form.Item>
              <Form.Item name="skuSize">
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  placeholder="사이즈 전체"
                  style={{ width: 140 }}
                  loading={codes.isLoading}
                  options={codes.sizeOptions}
                />
              </Form.Item>
              <Form.Item name="status">
                <Select allowClear placeholder="상태 전체" style={{ width: 130 }} options={liveStatusOptions} />
              </Form.Item>
              <Form.Item name="availableOn">
                <DatePicker placeholder="대여 가능일" />
              </Form.Item>
              <Form.Item>
                <Button type="primary" htmlType="submit" icon={<SearchOutlined />}>
                  검색
                </Button>
              </Form.Item>
              {/*
                폐기는 '삭제'로 쓰이므로 평소엔 목록에서 빠진다. 이 체크박스로만 들여다본다.
                평상시 쓰는 조건이 아니라 검색 버튼 뒤에 따로 둔다.
              */}
              <Form.Item name="retired" valuePropName="checked" style={{ marginLeft: 12 }}>
                <Checkbox>폐기만 보기</Checkbox>
              </Form.Item>
            </Form>
          }
          actions={
            /*
              화면끼리 서로를 잇던 [가용 검색·배정]·[출고·반납] 버튼은 뺐다.
              좌측 메뉴 "렌탈 관리" 아래 같은 이동이 이미 있고, 세 화면이 그 버튼을
              저마다 다른 자리(좌상단·우상단)에 두는 바람에 배치가 어긋나 있었다.
            */
            <Can permission="RENTAL_EDIT">
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setRegisterOpen(true)}>
                실물 등록
              </Button>
            </Can>
          }
        />

        <DataTable<RentalItem>
          rowKey="id"
          loading={listQuery.isLoading}
          dataSource={listQuery.data?.data ?? []}
          columns={columns}
          pagination={{ pageSize: DEFAULT_PAGE_SIZE, showSizeChanger: true, pageSizeOptions: PAGE_SIZE_OPTIONS }}
          // 한 번 누르면 아래에서 비고를 보고, 두 번 누르면 상세 화면으로 간다.
          // 같은 행을 다시 누르면 선택을 풀어 패널을 접는다.
          // 상세 화면을 없앴으므로 행을 누르면 아래 패널에서 비고·폐기 사유만 본다.
          // 같은 행을 다시 누르면 접힌다.
          onRow={(r) => ({
            onClick: () => setSelectedId((prev) => (prev === r.id ? null : r.id)),
            style: { cursor: 'pointer' },
          })}
          rowClassName={(r) => (r.id === selectedId ? 'ant-table-row-selected' : '')}
        />

        {selectedId && <SelectedItemPanel query={selectedQuery} codes={codes} onClose={() => setSelectedId(null)} />}
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
          initialValues={{ quantity: 1 }}
          onFinish={(values) => registerMutation.mutate(values)}
        >
          <Form.Item name="componentType" label="구분" rules={[{ required: true, message: '구분을 선택해 주세요.' }]}>
            <Select
              placeholder="구분 선택"
              options={componentTypeOptions}
              // 구분이 바뀌면 앞 품목에서 고른 컬러·사이즈는 새 품목에 없는 코드다 — 비운다.
              onChange={() => registerForm.setFieldsValue({ color: undefined, size: undefined })}
            />
          </Form.Item>
          <Form.Item name="color" label="컬러" rules={[{ required: true, message: '컬러를 선택해 주세요.' }]}>
            <Select
              placeholder={registerComponentType ? '컬러 선택' : '구분을 먼저 선택하세요'}
              disabled={!registerComponentType}
              loading={colorsQuery.isLoading}
              options={colorSelectOptions}
            />
          </Form.Item>
          <Form.Item name="size" label="사이즈" rules={[{ required: true, message: '사이즈를 선택해 주세요.' }]}>
            <Select
              placeholder={registerComponentType ? '사이즈 선택' : '구분을 먼저 선택하세요'}
              disabled={!registerComponentType}
              loading={sizesQuery.isLoading}
              options={sizeSelectOptions}
            />
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

      {/*
        사용불가/재개 모달: 폐기와 같은 기준으로 사유를 필수로 받는다.
        왜 뺐는지·왜 되돌렸는지가 남지 않으면 상태 이력을 봐도 아무것도 알 수 없다.
      */}
      <Modal
        title={statusTarget?.next === 'UNAVAILABLE' ? '임시 사용불가' : '사용 재개'}
        open={!!statusTarget}
        onCancel={() => setStatusTarget(null)}
        onOk={() => statusForm.submit()}
        okText={statusTarget?.next === 'UNAVAILABLE' ? '사용불가로 변경' : '대여 가능으로 변경'}
        cancelText="취소"
        confirmLoading={availabilityMutation.isPending}
        destroyOnClose
      >
        {statusTarget && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message={`${statusTarget.item.managementCode} · ${
                RENTAL_COMPONENT_TYPE_LABELS[statusTarget.item.componentType] ?? statusTarget.item.componentType
              } ${statusTarget.item.color} / ${statusTarget.item.size}`}
              description={
                statusTarget.next === 'UNAVAILABLE'
                  ? '대여 목록에서 잠시 빠집니다. 손질이 끝나면 [사용 재개]로 되돌립니다.'
                  : '다시 대여 가능 상태가 되어 예약을 받을 수 있습니다.'
              }
            />
            <Form<{ reason: string }>
              form={statusForm}
              layout="vertical"
              onFinish={(v) =>
                availabilityMutation.mutate({
                  item: statusTarget.item,
                  next: statusTarget.next,
                  reason: v.reason.trim(),
                })
              }
            >
              <Form.Item
                name="reason"
                label={statusTarget.next === 'UNAVAILABLE' ? '사용불가 사유' : '재개 사유'}
                rules={[
                  { required: true, message: '사유를 입력해 주세요.' },
                  { whitespace: true, message: '사유를 입력해 주세요.' },
                  { max: 500, message: '500자 이내로 입력해 주세요.' },
                ]}
              >
                <Input.TextArea
                  rows={3}
                  placeholder={
                    statusTarget.next === 'UNAVAILABLE'
                      ? '예: 소매 오염 세탁 맡김 / 단추 떨어짐'
                      : '예: 세탁 완료 / 단추 교체 완료'
                  }
                />
              </Form.Item>
            </Form>
          </Space>
        )}
      </Modal>

      {/*
        폐기 모달: 사유를 필수로 받는다. 되돌릴 수 없는 처리라 나중에 "이건 왜 뺐지"를
        답할 근거가 남아야 하고, 파손으로 잠시 빼두려는 오조작도 여기서 한 번 걸러진다.
      */}
      <Modal
        title="폐기 처리"
        open={!!retireTarget}
        onCancel={() => setRetireTarget(null)}
        onOk={() => retireForm.submit()}
        okText="폐기 처리"
        okButtonProps={{ danger: true }}
        cancelText="취소"
        confirmLoading={retireMutation.isPending}
        destroyOnClose
      >
        {retireTarget && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Alert
              type="warning"
              showIcon
              message={`${retireTarget.managementCode} · ${
                RENTAL_COMPONENT_TYPE_LABELS[retireTarget.componentType] ?? retireTarget.componentType
              } ${retireTarget.color} / ${retireTarget.size}`}
              description={
                <>
                  재고에서 영구 제외되며 되돌릴 수 없습니다. (이력은 보존됩니다)
                  <br />
                  파손 등으로 잠시 빼두려면 상세 화면에서 &lsquo;사용 불가&rsquo;로 바꾸세요.
                </>
              }
            />
            <Form<{ reason: string }>
              form={retireForm}
              layout="vertical"
              onFinish={(v) => retireMutation.mutate({ id: retireTarget.id, reason: v.reason.trim() })}
            >
              <Form.Item
                name="reason"
                label="폐기 사유"
                rules={[
                  { required: true, message: '폐기 사유를 입력해 주세요.' },
                  { whitespace: true, message: '폐기 사유를 입력해 주세요.' },
                  { max: 500, message: '500자 이내로 입력해 주세요.' },
                ]}
              >
                <Input.TextArea rows={3} placeholder="예: 우측 소매 훼손, 수선 불가 / 대여 30회 경과 노후" />
              </Form.Item>
            </Form>
          </Space>
        )}
      </Modal>
      </PageCard>
    </PageShell>
  );
}

/**
 * 선택한 실물의 비고를 표 아래에 펼친다.
 * 예약 상황 열을 걷어낸 대신, 폐기 판단에 필요한 등록 메모와 지난 폐기 사유를
 * 화면 이동 없이 이 자리에서 확인한다. 전체 이력은 상세 화면에서 본다.
 */
function SelectedItemPanel({
  query,
  codes,
  onClose,
}: {
  query: UseQueryResult<RentalItemDetail>;
  codes: ReturnType<typeof useRentalCodeNames>;
  onClose: () => void;
}) {
  if (query.isLoading) {
    return (
      <Card size="small">
        <Spin size="small" /> <Typography.Text type="secondary">불러오는 중…</Typography.Text>
      </Card>
    );
  }
  // 조회에 실패했는데 아무것도 안 그리면 "눌렀는데 반응이 없다"로 보인다.
  if (!query.data) {
    return (
      <Card size="small">
        <Space>
          <Typography.Text type="danger">비고를 불러오지 못했습니다.</Typography.Text>
          <Button size="small" onClick={() => void query.refetch()}>
            다시 시도
          </Button>
          <Button size="small" type="text" onClick={onClose}>
            닫기
          </Button>
        </Space>
      </Card>
    );
  }

  const { item, allocations, events } = query.data;
  // 예약·대여 중이면 렌탈 예약에서 입력한 배정 내용을 보여 준다(고객·주문·기간).
  const activeAllocation = allocations.find((a) => a.status === 'RESERVED' || a.status === 'CHECKED_OUT');
  const retireEvent = events.find((e) => e.newStatus === 'RETIRED');
  // 사용불가일 때만 그 사유를 꺼낸다. 배정·출고처럼 시스템이 남긴 상태 변경은 보여 주지 않는다
  // (사유에 내부 배정 ID가 섞여 있어 읽을 값이 못 된다).
  const unavailableEvent =
    item.status === 'UNAVAILABLE' ? events.find((e) => e.newStatus === 'UNAVAILABLE') : undefined;

  return (
    <Card
      size="small"
      title={
        <Space size="small">
          <Typography.Text strong>{item.managementCode}</Typography.Text>
          <Typography.Text type="secondary">
            {RENTAL_COMPONENT_TYPE_LABELS[item.componentType] ?? item.componentType} {codes.colorName(item.color)} /{' '}
            {codes.sizeName(item.size)}
          </Typography.Text>
          <StatusBadge
            label={RENTAL_ITEM_STATUS_META[item.status]?.label ?? item.status}
            color={RENTAL_ITEM_STATUS_META[item.status]?.color}
          />
        </Space>
      }
      extra={
        <Button size="small" type="text" onClick={onClose}>
          닫기
        </Button>
      }
    >
      <Descriptions size="small" column={2} colon={false}>
        {activeAllocation && (
          <>
            <Descriptions.Item label="고객">{activeAllocation.customerName}</Descriptions.Item>
            <Descriptions.Item label="주문번호">{activeAllocation.orderNo}</Descriptions.Item>
            <Descriptions.Item label="대여 기간">
              {activeAllocation.pickupDate} ~ {activeAllocation.returnDueDate}
            </Descriptions.Item>
          </>
        )}
        {unavailableEvent && (
          <Descriptions.Item label="사용불가 사유" span={2}>
            {unavailableEvent.reason || '-'}{' '}
            <Typography.Text type="secondary">
              ({unavailableEvent.at.slice(0, 10)} · {unavailableEvent.by})
            </Typography.Text>
          </Descriptions.Item>
        )}
        {retireEvent && (
          <Descriptions.Item label="폐기 사유" span={2}>
            {retireEvent.reason || '-'}{' '}
            <Typography.Text type="secondary">
              ({retireEvent.at.slice(0, 10)} · {retireEvent.by})
            </Typography.Text>
          </Descriptions.Item>
        )}
        <Descriptions.Item label="등록 메모" span={2}>
          {item.notes || '-'}
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}
