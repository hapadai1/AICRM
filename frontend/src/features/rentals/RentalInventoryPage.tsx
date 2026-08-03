import { PauseCircleOutlined, PlusOutlined, RollbackOutlined, SearchOutlined, StopOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Tooltip,
  Typography,
} from 'antd';
import type { RadioChangeEvent } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  RENTAL_COMPONENT_TYPE_LABELS,
  changeRentalStatusQuantity,
  createRentalItem,
  fetchRentalColors,
  fetchRentalSizes,
  fetchRentalSkuSummary,
  retireRentalQuantity,
  type RentalComponentType,
  type RentalSkuSummaryRow,
} from '../../api/rentals';
import { Can } from '../../shared/Can';
import { DataTable } from '../../shared/DataTable';
import { ListToolbar, PageCard, PageShell } from '../../shared/PageShell';
import { autoWidth } from '../../shared/table-width';
import { componentTypeOptions } from './rental-constants';
import { useRentalCodeNames } from './rental-codes';

/** 품목 대분류 버튼 값 — 'ALL'은 품목 조건 없음. */
type ComponentFilter = RentalComponentType | 'ALL';

interface FilterValues {
  color?: string;
  skuSize?: string;
}

interface RegisterValues {
  componentType: RentalComponentType;
  color: string;
  size: string;
  quantity: number;
  notes?: string;
}

/** 수량 조정 모달이 하는 일. 셋 다 "SKU + 수량 + 사유" 한 벌로 처리된다. */
type AdjustMode = 'RETIRE' | 'HOLD' | 'RESUME';

const ADJUST_META: Record<AdjustMode, { title: string; ok: string; label: string; placeholder: string }> = {
  RETIRE: {
    title: '폐기 처리',
    ok: '폐기 처리',
    label: '폐기 사유',
    placeholder: '예: 우측 소매 훼손, 수선 불가 / 대여 30회 경과 노후',
  },
  HOLD: {
    title: '임시 사용불가',
    ok: '사용불가로 변경',
    label: '사용불가 사유',
    placeholder: '예: 소매 오염 세탁 맡김 / 단추 떨어짐',
  },
  RESUME: {
    title: '사용 재개',
    ok: '대여 가능으로 변경',
    label: '재개 사유',
    placeholder: '예: 세탁 완료 / 단추 교체 완료',
  },
};

/**
 * RENT-001 렌탈 재고 — SKU(구분·컬러·사이즈)별 수량 화면.
 *
 * 현장에서 실물 한 벌과 시스템 개체를 1:1로 맞추는 게 불가능해, 이 화면은 관리코드를
 * 다루지 않는다 (현업 확정 2026-07-31). 사용자는 "블랙 46호 몇 벌"까지만 지정하고
 * 어느 개체를 손댈지는 서버가 고른다. 개체 행은 그대로 남아 이중예약 방지
 * (rental_allocation_no_overlap EXCLUDE 제약)와 이력을 계속 담당한다.
 */
export function RentalInventoryPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [filterForm] = Form.useForm<FilterValues>();
  const [registerForm] = Form.useForm<RegisterValues>();
  const [adjustForm] = Form.useForm<{ quantity: number; reason: string }>();
  const [componentType, setComponentType] = useState<RentalComponentType | undefined>();
  const [filters, setFilters] = useState<FilterValues>({});
  const [registerOpen, setRegisterOpen] = useState(false);
  // 수량 조정 대상. null이면 닫힘.
  const [adjustTarget, setAdjustTarget] = useState<{ row: RentalSkuSummaryRow; mode: AdjustMode } | null>(null);

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
  const codes = useRentalCodeNames(componentType);

  /**
   * 품목 대분류 전환. 앞 품목에서 고른 컬러·사이즈는 새 품목에 없는 코드라
   * (구두 260 → 정장상의) 남겨 두면 결과가 0건이 된다. 함께 비운다.
   */
  const onComponentChange = (next: ComponentFilter) => {
    setComponentType(next === 'ALL' ? undefined : next);
    filterForm.setFieldsValue({ color: undefined, skuSize: undefined });
    setFilters({});
  };

  /*
   * 품목은 서버에 안 넘긴다 — 전 품목 수량을 한 번에 받아 버튼 건수와 표를 같은 값에서
   * 만든다. 따로 집계하면 둘이 어긋나 "전체 12인데 표는 9줄"처럼 보인다.
   */
  const summaryQuery = useQuery({
    queryKey: ['rentals', 'inventory', 'sku-summary', filters.color, filters.skuSize],
    queryFn: () => fetchRentalSkuSummary({ color: filters.color, skuSize: filters.skuSize }),
  });
  const allRows = useMemo(() => summaryQuery.data ?? [], [summaryQuery.data]);
  const rows = useMemo(
    () => (componentType ? allRows.filter((r) => r.componentType === componentType) : allRows),
    [allRows, componentType],
  );
  /** 품목 버튼에 붙일 보유 수 — 표와 같은 응답에서 센다. */
  const totalsByType = useMemo(() => {
    const out: Partial<Record<RentalComponentType, number>> = {};
    for (const r of allRows) out[r.componentType] = (out[r.componentType] ?? 0) + r.total;
    return out;
  }, [allRows]);
  const grandTotal = useMemo(() => allRows.reduce((sum, r) => sum + r.total, 0), [allRows]);

  const registerMutation = useMutation({
    // managementCode는 넘기지 않는다 — 서버가 `구분-컬러-사이즈-연번`으로 채번한다.
    mutationFn: (v: RegisterValues) =>
      createRentalItem({
        componentType: v.componentType,
        color: v.color,
        size: v.size,
        quantity: v.quantity,
        notes: v.notes,
      }),
    onSuccess: (created) => {
      message.success(`${created.length}벌 등록되었습니다.`);
      setRegisterOpen(false);
      registerForm.resetFields();
      void queryClient.invalidateQueries({ queryKey: ['rentals'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '실물 등록에 실패했습니다.'),
  });

  const adjustMutation = useMutation({
    mutationFn: async ({ row, mode, quantity, reason }: { row: RentalSkuSummaryRow; mode: AdjustMode; quantity: number; reason: string }) => {
      const sku = { componentType: row.componentType, color: row.color, size: row.size };
      if (mode === 'RETIRE') return retireRentalQuantity({ ...sku, quantity, reason });
      await changeRentalStatusQuantity({
        ...sku,
        quantity,
        newStatus: mode === 'HOLD' ? 'UNAVAILABLE' : 'AVAILABLE',
        reason,
      });
    },
    onSuccess: (_res, v) => {
      message.success(`${v.quantity}벌 ${ADJUST_META[v.mode].title} 되었습니다.`);
      setAdjustTarget(null);
      adjustForm.resetFields();
      void queryClient.invalidateQueries({ queryKey: ['rentals'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '처리에 실패했습니다.'),
  });

  /** 그 조작으로 손댈 수 있는 최대 수량 — 예약·출고 중인 옷은 어느 쪽으로도 못 건드린다. */
  const maxQuantity = (row: RentalSkuSummaryRow, mode: AdjustMode) =>
    mode === 'RESUME' ? row.hold : mode === 'HOLD' ? row.available : row.total - row.reserved - row.checkedOut;

  const openAdjust = (row: RentalSkuSummaryRow, mode: AdjustMode) => {
    setAdjustTarget({ row, mode });
    adjustForm.resetFields();
    adjustForm.setFieldsValue({ quantity: 1 });
  };

  const skuLabel = (row: RentalSkuSummaryRow) =>
    `${RENTAL_COMPONENT_TYPE_LABELS[row.componentType] ?? row.componentType} · ${codes.colorName(row.color)} / ${codes.sizeName(row.size)}`;

  /** 수량 칸 — 0은 흐리게 둬서 눈이 0이 아닌 값에만 걸리게 한다. */
  const qtyCell = (v: number, strong = false) =>
    v === 0 ? (
      <Typography.Text type="secondary">0</Typography.Text>
    ) : (
      <Typography.Text strong={strong}>{v}</Typography.Text>
    );

  const columns: ColumnsType<RentalSkuSummaryRow> = [
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
      title: '보유',
      dataIndex: 'total',
      align: 'center',
      ...autoWidth(),
      render: (v: number) => qtyCell(v, true),
    },
    {
      // 이 화면에서 가장 자주 찾는 값이다 — "지금 몇 벌 빌려줄 수 있나".
      title: '가용',
      dataIndex: 'available',
      align: 'center',
      ...autoWidth(),
      render: (v: number) =>
        v === 0 ? <Typography.Text type="secondary">0</Typography.Text> : <Typography.Text strong type="success">{v}</Typography.Text>,
    },
    { title: '예약', dataIndex: 'reserved', align: 'center', ...autoWidth(), render: (v: number) => qtyCell(v) },
    { title: '출고', dataIndex: 'checkedOut', align: 'center', ...autoWidth(), render: (v: number) => qtyCell(v) },
    {
      title: '대기',
      dataIndex: 'hold',
      align: 'center',
      ...autoWidth(),
      // 정비를 기다리는 중이면 언제부터 쓸 수 있는지까지 보여 준다 —
      // 수량만 보면 다른 색을 권하게 되는데 실은 모레면 나온다.
      // 날짜만 적어 두면 그게 무슨 날인지 읽히지 않아 "…부터 가용"까지 쓴다.
      render: (v: number, row) =>
        v > 0 && row.holdUntil ? (
          <Tooltip title={`정비 중인 ${v}벌은 ${dayjs(row.holdUntil).format('M월 D일')}부터 다시 빌려줄 수 있습니다.`}>
            <Space size={6}>
              {qtyCell(v)}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {dayjs(row.holdUntil).format('M/D')}부터 가용
              </Typography.Text>
            </Space>
          </Tooltip>
        ) : (
          qtyCell(v)
        ),
    },
    {
      title: '액션',
      key: 'actions',
      ...autoWidth(),
      render: (_, row) => (
        <Can permission="RENTAL_EDIT">
          <Space size="small">
            <Button
              size="small"
              icon={<PlusOutlined />}
              onClick={() => {
                registerForm.resetFields();
                registerForm.setFieldsValue({
                  componentType: row.componentType,
                  color: row.color,
                  size: row.size,
                  quantity: 1,
                });
                setRegisterOpen(true);
              }}
            >
              추가
            </Button>
            {row.hold > 0 ? (
              <Button size="small" icon={<RollbackOutlined />} onClick={() => openAdjust(row, 'RESUME')}>
                사용 재개
              </Button>
            ) : (
              <Button
                size="small"
                icon={<PauseCircleOutlined />}
                disabled={row.available === 0}
                onClick={() => openAdjust(row, 'HOLD')}
              >
                사용불가
              </Button>
            )}
            <Button
              size="small"
              danger
              icon={<StopOutlined />}
              disabled={maxQuantity(row, 'RETIRE') === 0}
              onClick={() => openAdjust(row, 'RETIRE')}
            >
              폐기
            </Button>
          </Space>
        </Can>
      ),
    },
  ];

  const adjustMeta = adjustTarget ? ADJUST_META[adjustTarget.mode] : null;
  const adjustMax = adjustTarget ? maxQuantity(adjustTarget.row, adjustTarget.mode) : 0;

  return (
    <PageShell>
      <PageCard>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {/*
            품목 대분류는 매번 쓰는 축이라 [검색]을 거치지 않고 누르는 즉시 목록이 바뀐다.
            나머지 조건(컬러·사이즈)은 조합해서 쓰는 값이라 기존대로 [검색]으로 묶는다.
          */}
          <Radio.Group
            value={componentType ?? 'ALL'}
            optionType="button"
            buttonStyle="solid"
            onChange={(e: RadioChangeEvent) => onComponentChange(e.target.value as ComponentFilter)}
          >
            {/* 건수는 눌러 보기 전에 어디에 재고가 있는지 알려 준다. 집계 전에는 자리만 비워 둔다. */}
            <Radio.Button value="ALL">전체 {summaryQuery.isLoading ? '' : grandTotal}</Radio.Button>
            {componentTypeOptions.map((o) => (
              <Radio.Button key={o.value} value={o.value}>
                {o.label} {summaryQuery.isLoading ? '' : (totalsByType[o.value] ?? 0)}
              </Radio.Button>
            ))}
          </Radio.Group>

          <ListToolbar
            filters={
              /*
                필터에 "구분 :", "컬러 :" 처럼 라벨을 달아 두면 렌탈 화면만 다른 시스템처럼 보였다.
                다른 목록과 같이 라벨 없이 placeholder 로 뜻을 전달한다.
                상태·대여가능일·폐기만보기 필터는 뺐다 — 개체 단위 조건이라 수량 집계와 맞지 않는다
                (상태로 좁히면 보유 = 가용+예약+출고+대기 가 어긋난다).
              */
              <Form<FilterValues>
                form={filterForm}
                layout="inline"
                onFinish={(values) => setFilters(values)}
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
                <Form.Item>
                  <Button type="primary" htmlType="submit" icon={<SearchOutlined />}>
                    검색
                  </Button>
                </Form.Item>
              </Form>
            }
            actions={
              <Can permission="RENTAL_EDIT">
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() => {
                    registerForm.resetFields();
                    registerForm.setFieldsValue({ quantity: 1 });
                    setRegisterOpen(true);
                  }}
                >
                  실물 등록
                </Button>
              </Can>
            }
          />

          <DataTable<RentalSkuSummaryRow>
            rowKey={(r) => `${r.componentType}|${r.color}|${r.size}`}
            loading={summaryQuery.isLoading}
            dataSource={rows}
            columns={columns}
            pagination={{}}
            locale={{ emptyText: '등록된 렌탈 재고가 없습니다.' }}
          />
        </Space>

        {/* 실물 등록: 구분·컬러·사이즈와 수량만. 관리코드는 서버가 채번한다. */}
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
              name="quantity"
              label="등록 수량"
              rules={[{ required: true, message: '수량을 입력해 주세요.' }]}
              extra="관리코드는 구분·컬러·사이즈에 연번을 붙여 자동으로 매겨집니다."
            >
              <InputNumber min={1} max={50} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="notes" label="메모">
              <Input.TextArea rows={2} />
            </Form.Item>
          </Form>
        </Modal>

        {/*
          수량 조정(폐기·사용불가·재개): 셋 다 사유를 필수로 받는다.
          왜 뺐는지·왜 되돌렸는지가 남지 않으면 상태 이력을 봐도 아무것도 알 수 없다.
        */}
        <Modal
          title={adjustMeta?.title}
          open={!!adjustTarget}
          onCancel={() => setAdjustTarget(null)}
          onOk={() => adjustForm.submit()}
          okText={adjustMeta?.ok}
          okButtonProps={{ danger: adjustTarget?.mode === 'RETIRE' }}
          cancelText="취소"
          confirmLoading={adjustMutation.isPending}
          destroyOnClose
        >
          {adjustTarget && adjustMeta && (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Alert
                type={adjustTarget.mode === 'RETIRE' ? 'warning' : 'info'}
                showIcon
                message={skuLabel(adjustTarget.row)}
                description={
                  adjustTarget.mode === 'RETIRE' ? (
                    <>
                      재고에서 영구 제외되며 되돌릴 수 없습니다. (이력은 보존됩니다)
                      <br />
                      파손 등으로 잠시 빼두려면 [사용불가]를 쓰세요. 최대 {adjustMax}벌까지 가능합니다.
                    </>
                  ) : adjustTarget.mode === 'HOLD' ? (
                    `대여 목록에서 잠시 빠집니다. 손질이 끝나면 [사용 재개]로 되돌립니다. 최대 ${adjustMax}벌까지 가능합니다.`
                  ) : (
                    `다시 대여 가능 상태가 되어 예약을 받을 수 있습니다. 최대 ${adjustMax}벌까지 가능합니다.`
                  )
                }
              />
              <Form<{ quantity: number; reason: string }>
                form={adjustForm}
                layout="vertical"
                initialValues={{ quantity: 1 }}
                onFinish={(v) =>
                  adjustMutation.mutate({
                    row: adjustTarget.row,
                    mode: adjustTarget.mode,
                    quantity: v.quantity,
                    reason: v.reason.trim(),
                  })
                }
              >
                <Form.Item
                  name="quantity"
                  label="수량"
                  rules={[{ required: true, message: '수량을 입력해 주세요.' }]}
                >
                  <InputNumber min={1} max={Math.max(1, adjustMax)} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item
                  name="reason"
                  label={adjustMeta.label}
                  rules={[
                    { required: true, message: '사유를 입력해 주세요.' },
                    { whitespace: true, message: '사유를 입력해 주세요.' },
                    { max: 500, message: '500자 이내로 입력해 주세요.' },
                  ]}
                >
                  <Input.TextArea rows={3} placeholder={adjustMeta.placeholder} />
                </Form.Item>
              </Form>
            </Space>
          )}
        </Modal>
      </PageCard>
    </PageShell>
  );
}
