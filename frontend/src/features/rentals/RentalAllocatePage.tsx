import { SearchOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Badge,
  Button,
  Calendar,
  DatePicker,
  Descriptions,
  Empty,
  Form,
  Modal,
  Radio,
  Select,
  Space,
  Typography,
} from 'antd';
import { DataTable } from '../../shared/DataTable';
import { ListToolbar, PageCard, PageShell } from '../../shared/PageShell';
import type { RadioChangeEvent } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  RENTAL_COMPONENT_TYPE_LABELS,
  allocateRentalItem,
  fetchAvailabilityCalendar,
  fetchRentalComponentTargets,
  type RentalAllocatePrefill,
  type RentalCalendarFilters,
  type RentalCalendarItem,
  type RentalComponentType,
} from '../../api/rentals';
import { componentTypeOptions } from './rental-constants';
import { useRentalCodeNames } from './rental-codes';

interface FilterValues {
  componentType?: RentalComponentType;
  color?: string;
  size?: string;
}

/** 화면을 열었을 때의 기본 조회 조건 (현업에서 가장 많이 찾는 조합) */
const DEFAULT_FILTERS: FilterValues = { componentType: 'JACKET', color: 'BLACK', size: '46' };

/** 가용 수에 따른 배지 색 — 0건은 회색, 소량은 주황, 여유는 초록. */
function countColor(count: number): string {
  if (count <= 0) return 'default';
  if (count <= 2) return 'orange';
  return 'green';
}

/**
 * 렌탈예약 달력 (설계서 06 §4, A7).
 * 월 캘린더에 일자별 가용 렌탈용품 수를 배지로 표기하고, 검색어·SKU·구분 등으로 필터한다.
 * 날짜 셀을 누르면 그 날짜에 가용한 실물 목록을 하단에 펼친다. (표시용 — 정합성은 배정 시 DB 제약이 보장)
 */
interface AllocateFormValues {
  componentId: string;
  pickupDate: Dayjs;
  returnDueDate: Dayjs;
}

/**
 * 그 날짜에 빌려줄 수 있는 SKU 한 줄. 개체 목록을 이 단위로 접어 보여 준다 —
 * 관리코드는 현장에서 실물과 맞지 않아 쓰지 않는다 (현업 확정 2026-07-31).
 */
interface SkuGroup {
  componentType: RentalComponentType;
  color: string;
  size: string;
  /** 그 날짜 가용 수 */
  count: number;
}

/** 개체 목록을 SKU별로 접는다. */
function groupBySku(items: RentalCalendarItem[]): SkuGroup[] {
  const map = new Map<string, SkuGroup>();
  for (const it of items) {
    const key = `${it.componentType}|${it.color}|${it.size}`;
    const row = map.get(key) ?? {
      componentType: it.componentType,
      color: it.color,
      size: it.size,
      count: 0,
    };
    row.count += 1;
    map.set(key, row);
  }
  return [...map.values()].sort(
    (a, b) => a.color.localeCompare(b.color) || a.size.localeCompare(b.size),
  );
}

export function RentalAllocatePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<FilterValues>();
  const [allocForm] = Form.useForm<AllocateFormValues>();

  const [month, setMonth] = useState<Dayjs>(dayjs());
  /*
   * 예약은 언제나 한 품목을 놓고 잡는 일이라 '전체'가 필요 없다.
   * 가장 많이 찾는 조합(상의·블랙·46호)으로 열어 두어, 들어오자마자 그 달력을 보게 한다.
   */
  const [filters, setFilters] = useState<FilterValues>(DEFAULT_FILTERS);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  // 배정 실행 대상 SKU (달력 아래 표에서 [배정] 클릭 시 설정) — 모달을 연다.
  // 개체가 아니라 SKU다: 어느 실물을 쓸지는 서버가 고른다 (현업 확정 2026-07-31).
  const [allocateSku, setAllocateSku] = useState<SkuGroup | null>(null);

  const from = month.startOf('month').format('YYYY-MM-DD');
  const to = month.endOf('month').format('YYYY-MM-DD');

  const queryFilters: RentalCalendarFilters = { from, to, ...filters };
  const calendarQuery = useQuery({
    queryKey: ['rentals', 'availability-calendar', queryFilters],
    queryFn: () => fetchAvailabilityCalendar(queryFilters),
  });

  // 날짜별 사전 버킷팅 — 셀마다 전체 배열을 훑지 않게 한다 (MonthCalendar 패턴).
  const byDate = useMemo(() => {
    const map = new Map<string, { availableCount: number; items: RentalCalendarItem[] }>();
    for (const day of calendarQuery.data ?? []) {
      map.set(day.date, { availableCount: day.availableCount, items: day.items });
    }
    return map;
  }, [calendarQuery.data]);

  // 품목은 Form 밖에 있으므로 조회 시 덮어쓰지 않도록 이전 값을 남긴다(렌탈 재고와 동일).
  const onSearch = (values: FilterValues) => {
    setFilters((prev) => ({ ...values, componentType: prev.componentType }));
    setSelectedDate(null);
  };

  /**
   * 품목 대분류 전환 — 즉시 재조회.
   * 앞 품목에서 고른 컬러·사이즈는 새 품목에 없는 코드라(구두 260 → 상의) 함께 비운다.
   */
  const onComponentChange = (componentType: RentalComponentType) => {
    form.setFieldsValue({ color: undefined, size: undefined });
    setFilters((prev) => ({ ...prev, componentType, color: undefined, size: undefined }));
    setSelectedDate(null);
  };

  // 컬러·사이즈 선택지와 표시명 — 고른 품목의 코드만 내려온다.
  const codes = useRentalCodeNames(filters.componentType);

  // 배정 대상 렌탈 주문 구성품 — 선택한 SKU와 같은 구분(componentType)의 미배정 구성품만 노출.
  const targetsQuery = useQuery({
    queryKey: ['rentals', 'order-components', allocateSku?.componentType],
    queryFn: () => fetchRentalComponentTargets(),
    enabled: !!allocateSku,
  });
  const allocatableTargets = useMemo(
    () =>
      (targetsQuery.data ?? []).filter(
        (t) => t.componentType === allocateSku?.componentType && t.currentAllocation === null,
      ),
    [targetsQuery.data, allocateSku],
  );

  const allocateMutation = useMutation({
    mutationFn: (v: AllocateFormValues) => {
      const target = allocatableTargets.find((t) => t.componentId === v.componentId);
      if (!target) throw new Error('배정 대상 구성품을 찾을 수 없습니다.');
      // 개체(inventoryItemId)를 넘기지 않는다 — 컬러·사이즈만 주면 서버가 그 기간에
      // 비어 있는 실물 하나를 고른다. 이중예약은 DB EXCLUDE 제약이 계속 막는다.
      return allocateRentalItem(target.orderId, {
        componentId: v.componentId,
        color: allocateSku!.color,
        size: allocateSku!.size,
        pickupDate: v.pickupDate.format('YYYY-MM-DD'),
        returnDueDate: v.returnDueDate.format('YYYY-MM-DD'),
      });
    },
    onSuccess: (_alloc, v) => {
      const target = allocatableTargets.find((t) => t.componentId === v.componentId);
      message.success(`${target?.customerName ?? '고객'} · ${skuLabel(allocateSku!)} 예약되었습니다.`);
      setAllocateSku(null);
      void queryClient.invalidateQueries({ queryKey: ['rentals'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '배정에 실패했습니다.'),
  });

  const openAllocate = (sku: SkuGroup, preselectComponentId?: string) => {
    setAllocateSku(sku);
    const pickup = selectedDate ? dayjs(selectedDate) : dayjs();
    allocForm.setFieldsValue({
      componentId: (preselectComponentId ?? undefined) as unknown as string,
      pickupDate: pickup,
      returnDueDate: pickup.add(1, 'day'),
    });
  };

  // C5: 렌탈 선택 확정 화면에서 [배정으로]로 넘어온 경우, 첫 선택 실물로 배정 모달을 프리필해 연다.
  // (자동 생성 아님 — 직원이 기간을 입력하고 배정 버튼을 눌러야 확정된다)
  useEffect(() => {
    const prefill = (location.state as { rentalAllocatePrefill?: RentalAllocatePrefill } | null)
      ?.rentalAllocatePrefill;
    const first = prefill?.items?.[0];
    if (first) {
      // 프리필은 실물 하나를 담아 오지만, 여기서는 그 실물의 SKU만 쓴다(개체는 서버가 고른다).
      const { componentType, color, size } = first.item;
      openAllocate({ componentType, color, size, count: 1 }, first.componentId);
      // 새로고침·뒤로가기 시 모달이 다시 열리지 않도록 state를 비운다.
      navigate('.', { replace: true, state: null });
    }
    // 마운트 시 1회만 실행
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedItems = selectedDate ? (byDate.get(selectedDate)?.items ?? []) : [];
  // 관리코드로 한 줄씩 늘어놓지 않고 SKU로 접는다 — 사용자가 고르는 단위가 "블랙 46호"다.
  const selectedSkus = useMemo(() => groupBySku(selectedItems), [selectedItems]);

  /** "상의(자켓) · 블랙 / 46호" — 개체 대신 이 표기로 대상을 가리킨다. */
  const skuLabel = (sku: SkuGroup) =>
    `${RENTAL_COMPONENT_TYPE_LABELS[sku.componentType] ?? sku.componentType} · ${codes.colorName(sku.color)} / ${codes.sizeName(sku.size)}`;

  const columns: ColumnsType<SkuGroup> = [
    {
      title: '구분',
      dataIndex: 'componentType',
      width: 120,
      render: (c: RentalComponentType) => RENTAL_COMPONENT_TYPE_LABELS[c] ?? c,
    },
    { title: '컬러', dataIndex: 'color', width: 140, render: (v: string) => codes.colorName(v) },
    { title: '사이즈', dataIndex: 'size', width: 100, render: (v: string) => codes.sizeName(v) },
    {
      title: '가용',
      dataIndex: 'count',
      width: 80,
      align: 'center',
      render: (v: number) => (
        <Typography.Text strong type="success">
          {v}
        </Typography.Text>
      ),
    },
    {
      title: '예약',
      key: 'allocate',
      width: 90,
      render: (_, r) => (
        <Button size="small" type="primary" onClick={() => openAllocate(r)}>
          예약
        </Button>
      ),
    },
  ];

  return (
    <PageShell>
      <PageCard>
        {/* 제목은 헤더가 이미 "렌탈 예약"으로 보여 준다 — 카드 안에서 반복하지 않는다.
            화면끼리 잇던 [출고·반납으로]·[렌탈 재고로] 버튼도 좌측 메뉴와 겹쳐 뺐다. */}
        {/*
          품목 대분류는 매번 쓰는 축이라 [조회]를 거치지 않고 누르는 즉시 달력이 갱신된다.
          재고 화면과 달리 '전체'는 두지 않는다 — 예약은 어느 한 품목을 놓고 잡는 일이라
          전 품목을 섞어 센 가용 수는 쓸 데가 없다. 건수 배지도 달력 셀이 이미 날짜별로 보여 준다.
          조회 기간 안내문은 뺐다 — 달력이 보고 있는 달을 그대로 보여 주므로 같은 말이 두 번이었다.
        */}
        <ListToolbar
          filters={
            <Form<FilterValues>
              form={form}
              layout="inline"
              initialValues={{ color: DEFAULT_FILTERS.color, size: DEFAULT_FILTERS.size }}
              style={{ rowGap: 8, columnGap: 0 }}
              onFinish={onSearch}
            >
              {/* 품목 대분류도 같은 줄에 둔다 — 필터가 두 줄로 갈리지 않게 한다.
                  Form 안에 있지만 값은 filters 로 직접 다루므로 Form.Item name 을 주지 않는다. */}
              <Form.Item>
                <Radio.Group
                  value={filters.componentType}
                  optionType="button"
                  buttonStyle="solid"
                  onChange={(e: RadioChangeEvent) => onComponentChange(e.target.value as RentalComponentType)}
                >
                  {componentTypeOptions.map((o) => (
                    <Radio.Button key={o.value} value={o.value}>
                      {o.label}
                    </Radio.Button>
                  ))}
                </Radio.Group>
              </Form.Item>
              {/* 컬러·사이즈는 코드값이라 손으로 칠 수 없다 — 앞에서 고른 품목의 코드만 목록으로 준다. */}
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
              <Form.Item name="size">
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
                <Button type="primary" htmlType="submit" icon={<SearchOutlined />} loading={calendarQuery.isLoading}>
                  조회
                </Button>
              </Form.Item>
            </Form>
          }
        />
      </PageCard>

      <PageCard styles={{ body: { paddingTop: 0 } }}>
        <Calendar
          value={month}
          onPanelChange={(value) => {
            setMonth(value);
            setSelectedDate(null);
          }}
          onSelect={(date, info) => {
            if (info?.source === 'date') setSelectedDate(date.format('YYYY-MM-DD'));
          }}
          cellRender={(current, info) => {
            if (info.type !== 'date') return info.originNode;
            const key = current.format('YYYY-MM-DD');
            const day = byDate.get(key);
            if (!day) return null;
            return (
              <Badge
                color={countColor(day.availableCount)}
                text={<span style={{ fontSize: 12 }}>가용 {day.availableCount}건</span>}
              />
            );
          }}
        />
      </PageCard>

      <PageCard title={selectedDate ? `${selectedDate} 가용 재고 (${selectedItems.length}벌)` : '가용 재고'}>
        {selectedDate ? (
          <DataTable<SkuGroup>
            rowKey={(r) => `${r.componentType}|${r.color}|${r.size}`}
            dataSource={selectedSkus}
            columns={columns}
            pagination={false}
            locale={{ emptyText: '이 날짜에 빌려줄 수 있는 재고가 없습니다.' }}
          />
        ) : (
          <Empty description="달력에서 날짜를 선택하면 그날 빌려줄 수 있는 재고가 표시됩니다." image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </PageCard>

      {/* 예약 실행 모달: SKU → 렌탈 주문·구성품 선택 + 대여 기간 → 배정 생성 (실물은 서버가 고른다) */}
      <Modal
        title={allocateSku ? `예약 — ${skuLabel(allocateSku)}` : '예약'}
        open={!!allocateSku}
        onCancel={() => setAllocateSku(null)}
        onOk={() => allocForm.submit()}
        okText="예약"
        cancelText="취소"
        confirmLoading={allocateMutation.isPending}
        destroyOnClose
      >
        {allocateSku && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" bordered column={1}>
              <Descriptions.Item label="규격">
                <Typography.Text strong>{skuLabel(allocateSku)}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="가용">
                {selectedDate ? `${selectedDate} 기준 ${allocateSku.count}벌` : `${allocateSku.count}벌`}
              </Descriptions.Item>
            </Descriptions>

            <Form<AllocateFormValues>
              form={allocForm}
              layout="vertical"
              onFinish={(values) => allocateMutation.mutate(values)}
            >
              <Form.Item
                name="componentId"
                label="렌탈 주문·구성품 (동일 구분의 미배정 건)"
                rules={[{ required: true, message: '배정할 주문 구성품을 선택해 주세요.' }]}
              >
                <Select
                  showSearch
                  loading={targetsQuery.isLoading}
                  placeholder="주문 구성품 선택"
                  optionFilterProp="label"
                  notFoundContent={
                    targetsQuery.isLoading ? '조회 중…' : '배정 가능한 주문 구성품이 없습니다.'
                  }
                  options={allocatableTargets.map((t) => ({
                    value: t.componentId,
                    label: `${t.customerName} · ${t.orderNo} · ${t.displayName}`,
                  }))}
                />
              </Form.Item>
              <Form.Item
                name="pickupDate"
                label="픽업일"
                rules={[{ required: true, message: '픽업일을 선택해 주세요.' }]}
              >
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                name="returnDueDate"
                label="반납 예정일"
                rules={[{ required: true, message: '반납 예정일을 선택해 주세요.' }]}
              >
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                반납 예정일 다음 날부터 다른 예약을 받을 수 있습니다. 세탁이 더 걸리면 반납 처리에서
                &lsquo;대여 가능 예정일&rsquo;을 미루세요.
              </Typography.Text>
            </Form>
          </Space>
        )}
      </Modal>
    </PageShell>
  );
}
