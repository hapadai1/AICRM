import {
  LeftOutlined,
  PlusOutlined,
  PrinterOutlined,
  RightOutlined,
  SearchOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, DatePicker, Empty, Input, Segmented, Space, Spin, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  fetchAppointments,
  syncNaverReservations,
  type Appointment,
  type AppointmentSource,
  type AppointmentStatus,
} from '../../api/appointments';
import { ApiError } from '../../api/client';
import { Can } from '../../shared/Can';
import { StatusBadge } from '../../shared/StatusBadge';
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
import { autoWidth } from '../../shared/table-width';

const { RangePicker } = DatePicker;

type ViewMode = 'day' | 'week' | 'month' | 'list';

/**
 * 목록 뷰 기본 상태 필터 (설계서 07 D4) — 아직 맞이하지 않은 예약.
 * 방문완료·취소·노쇼는 지나간 건이라 "앞으로 맞이할 손님" 목록에서 뺀다.
 * 캘린더(일/주/월)와 인쇄는 이 필터를 쓰지 않는다 — 과거 이력 확인이 본래 목적이다(D5).
 */
const LIST_ALIVE_STATUSES: AppointmentStatus[] = ['RESERVED', 'CONFIRMED'];

/** 일 뷰에서 같은 시간대 예약을 가로로 나열할 때 쓰는 카드 고정폭(px). 개수와 무관하게 동일. */
const CARD_WIDTH = 200;

/** 타임테이블 셀에 표시하는 예약 카드. fixedWidth를 주면 폭 고정(가로 나열용). */
function AppointmentCard({
  appointment,
  onOpen,
  fixedWidth,
}: {
  appointment: Appointment;
  onOpen: (id: string) => void;
  fixedWidth?: number;
}) {
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
        // 가로 나열(고정폭)일 땐 gap이 간격을 잡으므로 marginBottom을 두지 않는다.
        marginBottom: fixedWidth ? 0 : 4,
        width: fixedWidth,
        opacity: cancelled ? 0.55 : 1,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, textDecoration: cancelled ? 'line-through' : undefined }}>
        {appointment.customerName}
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
  // 1시간 단위 슬롯 (A1: 예약 시간단위 1시간). 기존 30분 예약이 남아 있어도 시(hour) 셀에 흡수된다.
  const hours: number[] = [];
  for (let h = TIMETABLE_START_HOUR; h < TIMETABLE_END_HOUR; h++) hours.push(h);
  // 일 뷰에서만 같은 시간대 예약을 고정폭 카드로 가로 나열(넘치면 다음 줄로 wrap).
  // 주 뷰는 x축이 이미 요일이라 셀 안에서는 세로 스택을 유지한다.
  const horizontal = days.length === 1;
  const cellStyle: CSSProperties = {
    borderTop: '1px solid #f0f0f0',
    borderLeft: '1px solid #f0f0f0',
    padding: 4,
    minHeight: 44,
  };
  // 시(hour) 단위 매칭 — 분(minute) 분기 없이 해당 시간대 예약을 모두 담는다.
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
              <div
                key={`${d.format('YYYY-MM-DD')}-${h}`}
                style={
                  horizontal
                    ? { ...cellStyle, display: 'flex', flexWrap: 'wrap', gap: 4, alignContent: 'flex-start' }
                    : cellStyle
                }
              >
                {findCell(d, h).map((a) => (
                  <AppointmentCard
                    key={a.id}
                    appointment={a}
                    onOpen={onOpen}
                    fixedWidth={horizontal ? CARD_WIDTH : undefined}
                  />
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
  // 목록 뷰 기본 기간은 "오늘 이후" — 종료일은 비워 둔다(설계서 07 D4).
  const [listRange, setListRange] = useState<[Dayjs | null, Dayjs | null]>(() => [dayjs(), null]);
  const [keyword, setKeyword] = useState('');
  const [q, setQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const [fromStr, toStr] = useMemo<[string | undefined, string | undefined]>(() => {
    const range = (a: Dayjs, b: Dayjs): [string, string] => [a.format('YYYY-MM-DD'), b.format('YYYY-MM-DD')];
    if (mode === 'day') return range(baseDate, baseDate);
    if (mode === 'week') return range(baseDate.startOf('week'), baseDate.endOf('week'));
    // 월간은 앞뒤 주가 캘린더에 걸쳐 보이므로 그 범위까지 함께 가져온다.
    if (mode === 'month')
      return range(baseDate.startOf('month').startOf('week'), baseDate.endOf('month').endOf('week'));
    return [listRange[0]?.format('YYYY-MM-DD'), listRange[1]?.format('YYYY-MM-DD')];
  }, [mode, baseDate, listRange]);

  // 목록 뷰에서만 통합 검색어·살아있는 상태 필터를 건다. 캘린더는 선택 날짜의 예약을 그대로 보여준다(D5).
  const isList = mode === 'list';
  const listStatuses = isList ? LIST_ALIVE_STATUSES : undefined;
  const listQ = isList ? q : '';

  const { data, isLoading } = useQuery({
    queryKey: ['appointments', { fromStr: fromStr ?? '', toStr: toStr ?? '', listQ, isList }],
    queryFn: () =>
      fetchAppointments({ q: listQ || undefined, from: fromStr, to: toStr, statuses: listStatuses, size: 100 }),
  });
  const appointments = data?.data ?? [];

  const runSearch = () => setQ(keyword.trim());

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

  /** 현재 기간 그대로 인쇄 페이지를 새 탭으로 연다 (개발설계서 05 G-02). */
  const openPrint = () => {
    const query = new URLSearchParams();
    if (fromStr) query.set('from', fromStr);
    if (toStr) query.set('to', toStr);
    window.open(`/appointments/print?${query.toString()}`, '_blank');
  };

  const columns: ColumnsType<Appointment> = [
    {
      title: '예약 일시',
      dataIndex: 'startAt',
      ...autoWidth(),
      render: (v: string) => dayjs(v).format('YYYY-MM-DD (dd) HH:mm'),
    },
    // 미계약/계약 배지는 제거했다 — 가망/계약 고객 구분이 폐기되어 표시 의미가 없다(설계서 07 D8).
    { title: '고객명', dataIndex: 'customerName', ...autoWidth(100) },
    { title: '전화번호', dataIndex: 'phone', ...autoWidth() },
    { title: '예약 목적', dataIndex: 'purposeName', ...autoWidth() },
    {
      title: '출처',
      dataIndex: 'source',
      ...autoWidth(),
      render: (v: AppointmentSource) => <Tag color={metaOf(SOURCE_META, v).color}>{metaOf(SOURCE_META, v).label}</Tag>,
    },
    {
      title: '상태',
      dataIndex: 'status',
      ...autoWidth(),
      render: (v: AppointmentStatus) => (
        <StatusBadge label={metaOf(APPT_STATUS_META, v).label} color={metaOf(APPT_STATUS_META, v).color} />
      ),
    },
    {
      title: '동기화',
      dataIndex: 'syncStatus',
      ...autoWidth(),
      render: (v: Appointment['syncStatus']) => (
        <StatusBadge label={metaOf(SYNC_STATUS_META, v).label} color={metaOf(SYNC_STATUS_META, v).color} />
      ),
    },
    {
      title: '메모',
      dataIndex: 'memo',
      // 열 ellipsis 옵션은 표 전체를 고정 레이아웃으로 되돌린다. 셀 안에서 잘라 자동 폭을 유지한다.
      render: (v?: string) =>
        v ? (
          <Typography.Text ellipsis={{ tooltip: v }} style={{ maxWidth: 320 }}>
            {v}
          </Typography.Text>
        ) : (
          '-'
        ),
    },
  ];

  return (
    <Card>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            캘린더·목록
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
            <>
              {/* 통합 검색 1필드 — 예약자 이름·전화번호·예약 목적을 한 번에 찾는다(설계서 07 D4) */}
              <Input
                allowClear
                style={{ width: 280 }}
                placeholder="예약자 이름 / 전화번호 / 예약 목적"
                prefix={<SearchOutlined />}
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onPressEnter={runSearch}
              />
              <Button icon={<SearchOutlined />} onClick={runSearch}>
                검색
              </Button>
              {/* 종료일을 비우면 오늘 이후 전부. 과거를 보려면 시작일을 앞으로 당기면 된다. */}
              <RangePicker
                allowEmpty={[true, true]}
                value={listRange}
                onChange={(v) => setListRange([v?.[0] ?? null, v?.[1] ?? null])}
              />
              <Typography.Text type="secondary">예약접수·확정 건만</Typography.Text>
            </>
          ) : (
            <Space size={4}>
              <Button icon={<LeftOutlined />} onClick={() => moveBase(-1)} aria-label="이전" />
              <DatePicker allowClear={false} value={baseDate} onChange={(v) => v && setBaseDate(v)} />
              <Button icon={<RightOutlined />} onClick={() => moveBase(1)} aria-label="다음" />
              <Button onClick={() => setBaseDate(dayjs())}>오늘</Button>
            </Space>
          )}
        </Space>

        {mode === 'list' ? (
          <Table<Appointment>
            rowKey="id"
            scroll={{ x: 'max-content' }}
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
