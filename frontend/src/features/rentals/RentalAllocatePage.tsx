import { ArrowLeftOutlined, CheckOutlined, SearchOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Empty,
  Form,
  Input,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  RENTAL_COMPONENT_TYPE_LABELS,
  RENTAL_ITEM_STATUS_META,
  allocateRentalItem,
  fetchAvailability,
  fetchRentalComponentTargets,
  type RentalComponentType,
  type RentalItem,
} from '../../api/rentals';
import { StatusBadge } from '../../shared/StatusBadge';
import { COLOR_OPTIONS, DESIGN_OPTIONS, componentTypeOptions } from './rental-constants';
import { metaOf } from '../../shared/status-meta';

interface SearchValues {
  pickupDate: Dayjs;
  returnDueDate: Dayjs;
  availabilityEndDate: Dayjs;
  componentType?: RentalComponentType;
  design?: string;
  color?: string;
  size?: string;
}

interface SearchCriteria {
  pickupDate: string;
  returnDueDate: string;
  availabilityEndDate: string;
  /** 백엔드 가용 조회 필수 파라미터 — 대상 구성품 구분이 기본값이다. */
  componentType: RentalComponentType;
  design?: string;
  color?: string;
  size?: string;
}

/** RENT-003 렌탈 가용 검색·실물 배정 (?componentId= 쿼리 수용) */
export function RentalAllocatePage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const componentIdParam = searchParams.get('componentId') ?? undefined;

  const [form] = Form.useForm<SearchValues>();
  const [targetComponentId, setTargetComponentId] = useState<string | undefined>(componentIdParam);
  const [criteria, setCriteria] = useState<SearchCriteria | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>();
  const [manualCode, setManualCode] = useState('');
  const [allocError, setAllocError] = useState<{ code: string; message: string } | null>(null);

  const targetsQuery = useQuery({
    queryKey: ['rentals', 'component-targets'],
    queryFn: () => fetchRentalComponentTargets(),
  });

  const target = targetsQuery.data?.find((t) => t.componentId === targetComponentId);

  // 대상 구성품이 정해지면 구분·기본 기간을 자동 반영
  useEffect(() => {
    if (target) {
      const alloc = target.currentAllocation;
      form.setFieldsValue({
        componentType: target.componentType,
        pickupDate: alloc?.pickupDate ? dayjs(alloc.pickupDate) : dayjs(),
        returnDueDate: alloc?.returnDueDate ? dayjs(alloc.returnDueDate) : dayjs().add(2, 'day'),
        availabilityEndDate: alloc?.availabilityEndDate
          ? dayjs(alloc.availabilityEndDate)
          : dayjs().add(4, 'day'),
      });
    }
  }, [target, form]);

  const availabilityQuery = useQuery({
    queryKey: ['rentals', 'availability', criteria],
    queryFn: () =>
      fetchAvailability({
        componentType: criteria!.componentType,
        design: criteria!.design,
        color: criteria!.color,
        size: criteria!.size,
        pickupDate: criteria!.pickupDate,
        availabilityEndDate: criteria!.availabilityEndDate,
      }),
    enabled: !!criteria,
  });

  const allocateMutation = useMutation({
    mutationFn: (v: { inventoryItemId?: string; itemCode?: string }) => {
      if (!target || !criteria) throw new ApiError('VALIDATION_ERROR', '배정 대상 구성품과 기간을 먼저 선택해 주세요.');
      return allocateRentalItem(target.orderId, {
        componentId: target.componentId,
        inventoryItemId: v.inventoryItemId,
        itemCode: v.itemCode,
        pickupDate: criteria.pickupDate,
        returnDueDate: criteria.returnDueDate,
        availabilityEndDate: criteria.availabilityEndDate,
      });
    },
    onSuccess: (alloc) => {
      setAllocError(null);
      setSelectedItemId(undefined);
      setManualCode('');
      message.success(`관리 ID ${alloc.managementCode}가 배정되었습니다. (${alloc.pickupDate} ~ ${alloc.returnDueDate})`);
      void queryClient.invalidateQueries({ queryKey: ['rentals'] });
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        setAllocError({ code: e.code, message: e.message });
        // 기간 겹침이면 가용 목록 재조회 유도
        if (e.code === 'RENTAL_PERIOD_OVERLAP') {
          void queryClient.invalidateQueries({ queryKey: ['rentals', 'availability'] });
        }
      } else {
        setAllocError({ code: 'UNKNOWN_ERROR', message: '배정에 실패했습니다.' });
      }
    },
  });

  const onSearch = (values: SearchValues) => {
    setAllocError(null);
    setSelectedItemId(undefined);
    if (!values.componentType && !target?.componentType) {
      setAllocError({
        code: 'VALIDATION_ERROR',
        message: '구분을 선택하거나 배정 대상 구성품을 먼저 고르세요.',
      });
      return;
    }
    setCriteria({
      pickupDate: values.pickupDate.format('YYYY-MM-DD'),
      returnDueDate: values.returnDueDate.format('YYYY-MM-DD'),
      availabilityEndDate: values.availabilityEndDate.format('YYYY-MM-DD'),
      // 백엔드가 필수로 요구하므로 미선택 시 대상 구성품 구분을 쓴다.
      componentType: (values.componentType ?? target?.componentType) as RentalComponentType,
      design: values.design,
      color: values.color,
      size: values.size,
    });
  };

  const columns: ColumnsType<RentalItem> = [
    {
      title: '선택',
      key: 'select',
      width: 60,
      render: (_, r) => (
        <Radio checked={selectedItemId === r.id} onChange={() => setSelectedItemId(r.id)} />
      ),
    },
    { title: '관리 ID', dataIndex: 'managementCode', width: 170 },
    {
      title: '구분',
      dataIndex: 'componentType',
      width: 120,
      render: (c: RentalComponentType) => RENTAL_COMPONENT_TYPE_LABELS[c] ?? c,
    },
    { title: '디자인', dataIndex: 'design', width: 100 },
    { title: '컬러', dataIndex: 'color', width: 90 },
    { title: '사이즈', dataIndex: 'size', width: 80 },
    {
      title: '현재 상태',
      dataIndex: 'status',
      width: 110,
      render: (s: RentalItem['status']) => (
        <StatusBadge label={metaOf(RENTAL_ITEM_STATUS_META, s).label} color={metaOf(RENTAL_ITEM_STATUS_META, s).color} />
      ),
    },
    {
      title: '가용',
      key: 'availability',
      render: (_, r) =>
        r.currentAllocation ? (
          <Typography.Text type="secondary">
            다른 기간 예약 있음 ({r.currentAllocation.pickupDate} ~ {r.currentAllocation.returnDueDate})
          </Typography.Text>
        ) : (
          <Tag color="green">요청 기간 가용</Tag>
        ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Space>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/rentals')}>
              재고 목록
            </Button>
            <Typography.Title level={4} style={{ margin: 0 }}>
              렌탈 가용 검색·실물 배정 (RENT-003)
            </Typography.Title>
          </Space>
          <Button onClick={() => navigate('/rentals/handover')}>출고·반납으로</Button>
        </Space>

        <Alert
          style={{ marginTop: 16 }}
          type="info"
          showIcon
          message="상의·하의는 서로 다른 사이즈의 실물을 각각 배정할 수 있습니다. 구성품을 바꿔가며 관리 ID를 확정하세요."
        />

        <Form.Item label="배정 대상 구성품" style={{ marginTop: 16, marginBottom: 8 }} required>
          <Select
            style={{ width: '100%', maxWidth: 640 }}
            placeholder="배정할 렌탈 구성품 선택"
            loading={targetsQuery.isLoading}
            value={targetComponentId}
            onChange={(v: string) => {
              setTargetComponentId(v);
              setCriteria(null);
              setAllocError(null);
            }}
            options={(targetsQuery.data ?? []).map((t) => {
              const label = `${t.customerName} · ${t.orderNo} · ${t.displayName} · ${RENTAL_COMPONENT_TYPE_LABELS[t.componentType]}`;
              return {
                value: t.componentId,
                label: t.currentAllocation
                  ? `${label} — 현재 배정: ${t.currentAllocation.managementCode}`
                  : label,
              };
            })}
          />
        </Form.Item>
        {target && (
          <Descriptions size="small" bordered column={4} style={{ marginBottom: 8 }}>
            <Descriptions.Item label="고객">{target.customerName}</Descriptions.Item>
            <Descriptions.Item label="주문번호">{target.orderNo}</Descriptions.Item>
            <Descriptions.Item label="구분">{RENTAL_COMPONENT_TYPE_LABELS[target.componentType]}</Descriptions.Item>
            <Descriptions.Item label="현재 배정 ID">{target.currentAllocation?.managementCode ?? '-'}</Descriptions.Item>
          </Descriptions>
        )}

        <Form<SearchValues>
          form={form}
          layout="inline"
          style={{ rowGap: 8, marginTop: 8 }}
          initialValues={{
            pickupDate: dayjs(),
            returnDueDate: dayjs().add(2, 'day'),
            availabilityEndDate: dayjs().add(4, 'day'),
          }}
          onFinish={onSearch}
        >
          <Form.Item
            name="pickupDate"
            label="픽업일"
            rules={[{ required: true, message: '픽업일을 선택해 주세요.' }]}
          >
            <DatePicker />
          </Form.Item>
          <Form.Item
            name="returnDueDate"
            label="반납 예정일"
            rules={[{ required: true, message: '반납 예정일을 선택해 주세요.' }]}
          >
            <DatePicker />
          </Form.Item>
          <Form.Item
            name="availabilityEndDate"
            label="가용 종료일(정비 포함)"
            rules={[{ required: true, message: '가용 종료일을 선택해 주세요.' }]}
          >
            <DatePicker />
          </Form.Item>
          <Form.Item name="componentType" label="구분" extra="대상 구성품 선택 시 자동 지정">
            <Select
              allowClear
              placeholder="구분 선택"
              style={{ width: 140 }}
              options={componentTypeOptions}
            />
          </Form.Item>
          <Form.Item name="design" label="디자인">
            <Select allowClear placeholder="전체" style={{ width: 120 }} options={DESIGN_OPTIONS} />
          </Form.Item>
          <Form.Item name="color" label="컬러">
            <Select allowClear placeholder="전체" style={{ width: 110 }} options={COLOR_OPTIONS} />
          </Form.Item>
          <Form.Item name="size" label="사이즈">
            <Input allowClear placeholder="예: 100" style={{ width: 100 }} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" icon={<SearchOutlined />}>
              가용 조회
            </Button>
          </Form.Item>
        </Form>
      </Card>

      {allocError && (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setAllocError(null)}
          message={`배정 실패 (${allocError.code})`}
          description={allocError.message}
        />
      )}

      <Card
        title={
          criteria
            ? `가용 실물 목록 — ${criteria.pickupDate} ~ ${criteria.availabilityEndDate}`
            : '가용 실물 목록'
        }
        extra={
          <Button
            type="primary"
            icon={<CheckOutlined />}
            disabled={!selectedItemId || !target}
            loading={allocateMutation.isPending}
            onClick={() => allocateMutation.mutate({ inventoryItemId: selectedItemId })}
          >
            선택 실물 배정
          </Button>
        }
      >
        {criteria ? (
          <Table<RentalItem>
            rowKey="id"
            size="middle"
            loading={availabilityQuery.isLoading}
            dataSource={availabilityQuery.data ?? []}
            columns={columns}
            pagination={false}
            onRow={(r) => ({ onClick: () => setSelectedItemId(r.id) })}
          />
        ) : (
          <Empty description="기간과 조건을 입력한 뒤 가용 조회를 실행해 주세요." image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}

        <Space style={{ marginTop: 16 }} wrap>
          <Typography.Text type="secondary">관리 ID 직접 입력 배정(기간 겹침 검증 데모):</Typography.Text>
          <Input
            style={{ width: 220 }}
            placeholder="예: JKT-BLK-100-001"
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value)}
          />
          <Button
            disabled={!manualCode.trim() || !target || !criteria}
            loading={allocateMutation.isPending}
            onClick={() => allocateMutation.mutate({ itemCode: manualCode.trim() })}
          >
            직접 배정
          </Button>
        </Space>
      </Card>
    </Space>
  );
}
