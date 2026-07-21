import { LeftOutlined, PlusOutlined, PrinterOutlined, RightOutlined, SyncOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, DatePicker, Empty, Segmented, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  fetchAppointmentPurposes,
  fetchAppointments,
  syncNaverReservations,
  type Appointment,
  type AppointmentSource,
  type AppointmentStatus,
} from '../../api/appointments';
import { ApiError } from '../../api/client';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
import { CUSTOMER_STATUS_META } from '../customers/customer-constants';
import {
  APPT_STATUS_META,
  SOURCE_META,
  SYNC_STATUS_META,
  TIMETABLE_END_HOUR,
  TIMETABLE_START_HOUR,
} from './appointment-constants';
import { AppointmentFormModal } from './AppointmentFormModal';
import { MonthCalendar } from './MonthCalendar';
import { metaOf } from '../../shared/status-meta';

const { RangePicker } = DatePicker;

type ViewMode = 'day' | 'week' | 'month' | 'list';

/** 타임테이블 셀에 표시하는 예약 카드 */
function AppointmentCard({ appointment, onOpen }: { appointment: Appointment; onOpen: (id: string) => void }) {
  const statusMeta = metaOf(APPT_STATUS_META, appointment.status);
  const sourceMeta = metaOf(SOURCE_META, appointment.source);
  const syncMeta = metaOf(SYNC_STATUS_META, appointment.syncStatus);
  const cancelled = appointment.status === 'CANCELLED' || appointment.status === 'NO_SHOW';
  return (
    <div
      onClick={() => onOpen(appointment.id)}
      style={{
        cursor: 'pointer',
        background: '#fff',
        border: '1px solid #e6e6e6',
        borderLeft: `3px solid ${statusMeta.hex}`,
        borderRadius: 4,
        padding: '2px 6px',
        marginBottom: 4,
        opacity: cancelled ? 0.55 : 1,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, textDecoration: cancelled ? 'line-through' : undefined }}>
        {dayjs(appointment.startAt).format('HH:mm')} {appointment.customerName}
      </div>
      <div style={{ fontSize: 11, lineHeight: '18px' }}>
        <Tag color={sourceMeta.color} style={{ fontSize: 10, lineHeight: '14px', marginInlineEnd: 4, paddingInline: 4 }}>
          {sourceMeta.label}
        </Tag>
        {appointment.purposeName} · {statusMeta.label}
        {appointment.syncStatus !== 'NORMAL' && (
          <Tag color={syncMeta.color} style={{ fontSize: 10, lineHeight: '14px', marginInlineStart: 4, paddingInline: 4 }}>
            {syncMeta.label}
          </Tag>
        )}
      </div>
    </div>
  );
}

/** 일/주 타임테이블 (10:00~20:00) */
function Timetable({
  days,
  appointments,
  onOpen,
}: {
  days: Dayjs[];
  appointments: Appointment[];
  onOpen: (id: string) => void;
}) {
  const hours = Array.from(
    { length: TIMETABLE_END_HOUR - TIMETABLE_START_HOUR },
    (_, i) => TIMETABLE_START_HOUR + i,
  );
  const cellStyle: CSSProperties = {
    borderTop: '1px solid #f0f0f0',
    borderLeft: '1px solid #f0f0f0',
    padding: 4,
    minHeight: 44,
  };
  const findCell = (day: Dayjs, hour: number) =>
    appointments.filter((a) => {
      const s = dayjs(a.startAt);
      return s.isSame(day, 'day') && s.hour() === hour;
    });
  // 표시 구간(10~20시) 밖의 예약도 유실 없이 보여준다.
  const outOfRange = appointments.filter((a) => {
    const h = dayjs(a.startAt).hour();
    return h < TIMETABLE_START_HOUR || h >= TIMETABLE_END_HOUR;
  });

  return (
    <div style={{ overflowX: 'auto' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `56px repeat(${days.length}, minmax(${days.length > 1 ? 130 : 260}px, 1fr))`,
          borderRight: '1px solid #f0f0f0',
          borderBottom: '1px solid #f0f0f0',
          minWidth: days.length > 1 ? 980 : undefined,
        }}
      >
        <div style={{ ...cellStyle, minHeight: 0 }} />
        {days.map((d) => {
          const isToday = d.isSame(dayjs(), 'day');
          return (
            <div
              key={d.format('YYYY-MM-DD')}
              style={{ ...cellStyle, minHeight: 0, textAlign: 'center', fontWeight: 600, background: isToday ? '#e6f4ff' : '#fafafa' }}
            >
              {d.format('M/D (dd)')}
            </div>
          );
        })}
        {hours.map((h) => (
          <div key={h} style={{ display: 'contents' }}>
            <div style={{ ...cellStyle, fontSize: 12, color: '#888', textAlign: 'right', paddingRight: 6 }}>
              {String(h).padStart(2, '0')}:00
            </div>
            {days.map((d) => (
              <div key={`${d.format('YYYY-MM-DD')}-${h}`} style={cellStyle}>
                {findCell(d, h).map((a) => (
                  <AppointmentCard key={a.id} appointment={a} onOpen={onOpen} />
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
      {outOfRange.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <Typography.Text type="secondary">표시 구간(10:00~20:00) 외 예약 {outOfRange.length}건</Typography.Text>
        </div>
      )}
    </div>
  );
}

/** APPT-001 예약 캘린더·목록 */
export function AppointmentsPage() {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<ViewMode>('day');
  const [baseDate, setBaseDate] = useState<Dayjs>(() => dayjs());
  const [listRange, setListRange] = useState<[Dayjs, Dayjs]>(() => [dayjs().subtract(7, 'day'), dayjs().add(7, 'day')]);
  const [purposeCodes, setPurposeCodes] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<AppointmentStatus[]>([]);
  const [source, setSource] = useState<AppointmentSource | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);

  const [from, to] = useMemo<[Dayjs, Dayjs]>(() => {
    if (mode === 'day') return [baseDate, baseDate];
    if (mode === 'week') return [baseDate.startOf('week'), baseDate.endOf('week')];
    // 월간은 앞뒤 주가 캘린더에 걸쳐 보이므로 그 범위까지 함께 가져온다.
    if (mode === 'month')
      return [baseDate.startOf('month').startOf('week'), baseDate.endOf('month').endOf('week')];
    return listRange;
  }, [mode, baseDate, listRange]);
  const fromStr = from.format('YYYY-MM-DD');
  const toStr = to.format('YYYY-MM-DD');

  const { data: purposes } = useQuery({
    queryKey: ['appointment-purposes'],
    queryFn: fetchAppointmentPurposes,
    staleTime: 5 * 60_000,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['appointments', { fromStr, toStr, purposeCodes, statuses, source: source ?? '' }],
    queryFn: () => fetchAppointments({ from: fromStr, to: toStr, purposeCodes, statuses, source, size: 100 }),
  });
  const appointments = data?.data ?? [];

  const syncMutation = useMutation({
    mutationFn: syncNaverReservations,
    onSuccess: (result) => {
      message.success(
        `네이버 동기화 완료: 신규 ${result.created}건, 변경 ${result.updated}건` +
          (result.conflicts > 0 ? `, 충돌 ${result.conflicts}건 확인 필요` : ''),
      );
      void queryClient.invalidateQueries({ queryKey: ['appointments'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : '네이버 동기화에 실패했습니다.'),
  });

  const openDetail = (id: string) => navigate(`/appointments/${id}`);

  const moveBase = (diff: number) => {
    const unit = mode === 'week' ? 'week' : mode === 'month' ? 'month' : 'day';
    setBaseDate((d) => d.add(diff, unit));
  };

  /** 현재 필터·기간 그대로 인쇄 페이지를 새 탭으로 연다 (개발설계서 05 G-02). */
  const openPrint = () => {
    const query = new URLSearchParams({ from: fromStr, to: toStr });
    if (purposeCodes.length > 0) query.set('purposeCodes', purposeCodes.join(','));
    window.open(`/appointments/print?${query.toString()}`, '_blank');
  };

  const columns: ColumnsType<Appointment> = [
    {
      title: '예약 일시',
      dataIndex: 'startAt',
      width: 160,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD (dd) HH:mm'),
    },
    {
      title: '고객명',
      dataIndex: 'customerName',
      width: 140,
      render: (_, r) => (
        <Space size={4}>
          <span>{r.customerName}</span>
          {r.customerStatus && (
            <Tag color={metaOf(CUSTOMER_STATUS_META, r.customerStatus).color}>
              {metaOf(CUSTOMER_STATUS_META, r.customerStatus).label}
            </Tag>
          )}
        </Space>
      ),
    },
    { title: '전화번호', dataIndex: 'phone', width: 130 },
    { title: '예약 목적', dataIndex: 'purposeName', width: 110 },
    {
      title: '출처',
      dataIndex: 'source',
      width: 90,
      render: (v: AppointmentSource) => <Tag color={metaOf(SOURCE_META, v).color}>{metaOf(SOURCE_META, v).label}</Tag>,
    },
    {
      title: '상태',
      dataIndex: 'status',
      width: 100,
      render: (v: AppointmentStatus) => (
        <StatusBadge label={metaOf(APPT_STATUS_META, v).label} color={metaOf(APPT_STATUS_META, v).color} />
      ),
    },
    {
      title: '동기화',
      dataIndex: 'syncStatus',
      width: 100,
      render: (v: Appointment['syncStatus']) => (
        <StatusBadge label={metaOf(SYNC_STATUS_META, v).label} color={metaOf(SYNC_STATUS_META, v).color} />
      ),
    },
    { title: '메모', dataIndex: 'memo', ellipsis: true },
  ];

  return (
    <Card>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            예약 캘린더·목록
          </Typography.Title>
          <Space wrap>
            {/* 설계 PDF 1페이지 "CRM 일정 달력 출력" */}
            <Button icon={<PrinterOutlined />} onClick={openPrint}>
              인쇄
            </Button>
            <Can permission="NAVER_SYNC">
              <Button icon={<SyncOutlined />} loading={syncMutation.isPending} onClick={() => syncMutation.mutate()}>
                네이버 동기화
              </Button>
            </Can>
            <Can permission="APPOINTMENT_EDIT">
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                예약 추가
              </Button>
            </Can>
          </Space>
        </Space>

        <Space wrap>
          <Segmented
            value={mode}
            onChange={(v) => setMode(v as ViewMode)}
            options={[
              { label: '일', value: 'day' },
              { label: '주', value: 'week' },
              { label: '월', value: 'month' },
              { label: '목록', value: 'list' },
            ]}
          />
          {mode === 'list' ? (
            <RangePicker
              allowClear={false}
              value={listRange}
              onChange={(v) => {
                if (v?.[0] && v?.[1]) setListRange([v[0], v[1]]);
              }}
            />
          ) : (
            <Space size={4}>
              <Button icon={<LeftOutlined />} onClick={() => moveBase(-1)} aria-label="이전" />
              <DatePicker allowClear={false} value={baseDate} onChange={(v) => v && setBaseDate(v)} />
              <Button icon={<RightOutlined />} onClick={() => moveBase(1)} aria-label="다음" />
              <Button onClick={() => setBaseDate(dayjs())}>오늘</Button>
            </Space>
          )}
          <Select
            mode="multiple"
            allowClear
            placeholder="예약 목적"
            style={{ minWidth: 180 }}
            value={purposeCodes}
            onChange={setPurposeCodes}
            options={(purposes ?? []).map((p) => ({ value: p.code, label: p.name }))}
            maxTagCount="responsive"
          />
          <Select
            mode="multiple"
            allowClear
            placeholder="상태"
            style={{ minWidth: 160 }}
            value={statuses}
            onChange={setStatuses}
            options={Object.entries(APPT_STATUS_META).map(([value, meta]) => ({ value, label: meta.label }))}
            maxTagCount="responsive"
          />
          <Select
            allowClear
            placeholder="출처"
            style={{ minWidth: 110 }}
            value={source}
            onChange={(v) => setSource(v as AppointmentSource | undefined)}
            options={[
              { value: 'NAVER', label: '네이버' },
              { value: 'CRM', label: 'CRM' },
            ]}
          />
        </Space>

        {mode === 'list' ? (
          <Table<Appointment>
            rowKey="id"
            size="middle"
            loading={isLoading}
            columns={columns}
            dataSource={appointments}
            pagination={{ pageSize: 30, showSizeChanger: true, pageSizeOptions: [30, 50, 100] }}
            onRow={(r) => ({ onClick: () => openDetail(r.id), style: { cursor: 'pointer' } })}
            locale={{ emptyText: <Empty description="조건에 해당하는 예약이 없습니다." /> }}
          />
        ) : isLoading ? (
          <div style={{ textAlign: 'center', padding: 48 }}>
            <Spin />
          </div>
        ) : mode === 'month' ? (
          <MonthCalendar
            baseDate={baseDate}
            appointments={appointments}
            onSelectDate={(d) => {
              setBaseDate(d);
              setMode('day');
            }}
            onOpen={openDetail}
          />
        ) : (
          <Timetable
            days={
              mode === 'day'
                ? [baseDate]
                : Array.from({ length: 7 }, (_, i) => baseDate.startOf('week').add(i, 'day'))
            }
            appointments={appointments}
            onOpen={openDetail}
          />
        )}
      </Space>

      <AppointmentFormModal open={createOpen} defaultDate={baseDate} onClose={() => setCreateOpen(false)} />
    </Card>
  );
}
