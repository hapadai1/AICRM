import { SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Calendar,
  Card,
  Empty,
  Form,
  Input,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  RENTAL_COMPONENT_TYPE_LABELS,
  fetchAvailabilityCalendar,
  type RentalCalendarFilters,
  type RentalCalendarItem,
  type RentalComponentType,
} from '../../api/rentals';
import { COLOR_OPTIONS, DESIGN_OPTIONS, componentTypeOptions } from './rental-constants';

interface FilterValues {
  q?: string;
  sku?: string;
  componentType?: RentalComponentType;
  design?: string;
  color?: string;
  size?: string;
}

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
export function RentalAllocatePage() {
  const navigate = useNavigate();
  const [form] = Form.useForm<FilterValues>();

  const [month, setMonth] = useState<Dayjs>(dayjs());
  const [filters, setFilters] = useState<FilterValues>({});
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

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

  const onSearch = (values: FilterValues) => {
    setFilters(values);
    setSelectedDate(null);
  };

  const selectedItems = selectedDate ? (byDate.get(selectedDate)?.items ?? []) : [];

  const columns: ColumnsType<RentalCalendarItem> = [
    {
      title: '구분',
      dataIndex: 'componentType',
      width: 120,
      render: (c: RentalComponentType) => RENTAL_COMPONENT_TYPE_LABELS[c] ?? c,
    },
    { title: '디자인', dataIndex: 'design', width: 120 },
    { title: '컬러', dataIndex: 'color', width: 100 },
    { title: '사이즈', dataIndex: 'size', width: 90 },
    {
      title: '관리 ID',
      dataIndex: 'managementCode',
      render: (v: string, r) => (
        <Button type="link" style={{ padding: 0 }} onClick={() => navigate(`/rentals/${r.id}`)}>
          {v}
        </Button>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Typography.Title level={4} style={{ margin: 0 }}>
            렌탈예약 — 가용 달력
          </Typography.Title>
          <Space>
            <Button onClick={() => navigate('/rentals/handover')}>출고·반납으로</Button>
            <Button onClick={() => navigate('/rentals')}>전체관리로</Button>
          </Space>
        </Space>

        <Form<FilterValues>
          form={form}
          layout="inline"
          style={{ rowGap: 8, marginTop: 16 }}
          onFinish={onSearch}
        >
          <Form.Item name="q" label="검색어">
            <Input allowClear placeholder="관리코드·디자인·컬러" style={{ width: 180 }} />
          </Form.Item>
          <Form.Item name="sku" label="SKU">
            <Input allowClear placeholder="SKU 설명" style={{ width: 140 }} />
          </Form.Item>
          <Form.Item name="componentType" label="구분">
            <Select allowClear placeholder="전체" style={{ width: 130 }} options={componentTypeOptions} />
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
            <Button type="primary" htmlType="submit" icon={<SearchOutlined />} loading={calendarQuery.isLoading}>
              조회
            </Button>
          </Form.Item>
        </Form>
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
          조회 기간: {from} ~ {to} (달력의 월을 이동하면 자동 재조회됩니다)
        </Typography.Text>
      </Card>

      <Card styles={{ body: { paddingTop: 0 } }}>
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
      </Card>

      <Card title={selectedDate ? `${selectedDate} 가용 실물 (${selectedItems.length}건)` : '가용 실물'}>
        {selectedDate ? (
          <Table<RentalCalendarItem>
            rowKey="id"
            size="middle"
            scroll={{ x: 'max-content' }}
            dataSource={selectedItems}
            columns={columns}
            pagination={false}
            locale={{ emptyText: '이 날짜에 가용한 실물이 없습니다.' }}
          />
        ) : (
          <Empty description="달력에서 날짜를 선택하면 그날 가용한 실물이 표시됩니다." image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Card>
    </Space>
  );
}
