import {
  LeftOutlined,
  PrinterOutlined,
  RightOutlined,
  SearchOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, DatePicker, Empty, Input, Segmented, Space, Spin, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState, type CSSProperties } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  fetchAllAppointments,
  fetchNaverMenus,
  syncNaverReservations,
  type Appointment,
  type AppointmentSource,
  type AppointmentStatus,
  type NaverSyncResult,
} from '../../api/appointments';
import { ApiError } from '../../api/client';
import { LAYOUT, SEMANTIC_COLOR } from '../../app/theme';
import { Can } from '../../shared/Can';
import { DataTable } from '../../shared/DataTable';
import { ListToolbar, PageCard, PageShell } from '../../shared/PageShell';
import { StatusBadge } from '../../shared/StatusBadge';
import {
  APPT_STATUS_META,
  SYNC_STATUS_META,
  TIMETABLE_END_HOUR,
  TIMETABLE_START_HOUR,
  appointmentKindLabel,
  naverMenuLabel,
} from './appointment-constants';
import { MonthCalendar } from './MonthCalendar';
import { formatPhone } from '../../shared/phone';
import { metaOf } from '../../shared/status-meta';
import { COL } from '../../shared/table-width';

const { RangePicker } = DatePicker;

type ViewMode = 'day' | 'week' | 'month' | 'list';

/**
 * 예약 화면은 네이버 예약만 다룬다.
 * 매장 예약은 전부 네이버 예약으로 들어오고 CRM에서 직접 받는 예약은 없어서,
 * 출처 구분 보기(전체/CRM/네이버)는 의미 없는 선택지만 늘렸다.
 * 조회를 NAVER로 고정하고, 그 자리에 예약 목적(네이버 메뉴) 구분 버튼을 둔다.
 */
const SOURCE: AppointmentSource = 'NAVER';

/** 예약 목적(네이버 메뉴) 구분 버튼의 "전체" 값 — 메뉴 ID와 겹치지 않는다 */
const ALL_MENUS = 'ALL';

/** 동기화 결과 한 줄 요약 — 0건 항목은 뺀다 */
function syncSummary(r: NaverSyncResult): string {
  const parts = [
    r.created && `신규 ${r.created}건`,
    r.updated && `변경 ${r.updated}건`,
    r.cancelled && `취소 ${r.cancelled}건`,
  ].filter(Boolean);
  // 요청마다 네이버에 접속하지 않으므로, 몇 시에 받아 온 데이터인지 함께 알려 준다
  const basis = r.fetchedAt
    ? ` (${dayjs(r.fetchedAt).format('HH:mm')} ${r.fromCache ? '수집본 기준' : '수집'})`
    : '';
  const head = `네이버 ${r.firstLoad ? '첫 적재(과거·미래 30일)' : '동기화'} 완료${basis} — 조회 ${r.fetched}건`;
  return parts.length ? `${head}, ${parts.join(', ')}` : `${head}, 바뀐 예약 없음`;
}

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
        {appointmentKindLabel(appointment)} · {statusMeta.label}
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
              style={{ ...cellStyle, minHeight: 0, textAlign: 'center', fontWeight: 600, background: isToday ? SEMANTIC_COLOR.todayBg : '#fafafa' }}
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

  // 대시보드 "월간 일정" 버튼 등에서 ?view=month 로 진입할 수 있게 초기 모드를 URL에서 읽는다.
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<ViewMode>(() => {
    const v = searchParams.get('view');
    return v === 'day' || v === 'week' || v === 'month' || v === 'list' ? v : 'day';
  });
  const [baseDate, setBaseDate] = useState<Dayjs>(() => dayjs());
  // 목록 뷰 기본 기간은 "오늘 이후" — 종료일은 비워 둔다(설계서 07 D4).
  const [listRange, setListRange] = useState<[Dayjs | null, Dayjs | null]>(() => [dayjs(), null]);
  const [keyword, setKeyword] = useState('');
  const [q, setQ] = useState('');
  // 예약 목적(네이버 메뉴) 구분 보기 — 캘린더·목록·인쇄 모두에 적용한다
  const [naverMenuId, setNaverMenuId] = useState<string | undefined>();

  const { data: naverMenus } = useQuery({ queryKey: ['appointments', 'naver-menus'], queryFn: fetchNaverMenus });

  const [fromStr, toStr] = useMemo<[string | undefined, string | undefined]>(() => {
    const range = (a: Dayjs, b: Dayjs): [string, string] => [a.format('YYYY-MM-DD'), b.format('YYYY-MM-DD')];
    if (mode === 'day') return range(baseDate, baseDate);
    if (mode === 'week') return range(baseDate.startOf('week'), baseDate.endOf('week'));
    // 월간 캘린더는 그 달 날짜만 그린다(MonthCalendar) — 앞뒤 주까지 가져올 이유가 없다.
    // 인쇄도 이 범위를 그대로 써서 "9월 일정표"에 8월 말·10월 초가 섞이지 않는다.
    if (mode === 'month') return range(baseDate.startOf('month'), baseDate.endOf('month'));
    return [listRange[0]?.format('YYYY-MM-DD'), listRange[1]?.format('YYYY-MM-DD')];
  }, [mode, baseDate, listRange]);

  // 목록 뷰에서만 통합 검색어·살아있는 상태 필터를 건다. 캘린더는 선택 날짜의 예약을 그대로 보여준다(D5).
  const isList = mode === 'list';
  const listStatuses = isList ? LIST_ALIVE_STATUSES : undefined;
  const listQ = isList ? q : '';

  const { data, isLoading } = useQuery({
    queryKey: ['appointments', { fromStr: fromStr ?? '', toStr: toStr ?? '', listQ, isList, naverMenuId }],
    // 기간 전체를 받는다 — 한 요청은 최대 100건이라, 한 페이지만 받으면 예약이 많은 달의
    // 뒤쪽 날짜가 통째로 비어 "예약 없는 날"로 보인다(8월 150건 중 50건이 그렇게 빠져 있었다).
    queryFn: () =>
      fetchAllAppointments({
        q: listQ || undefined,
        from: fromStr,
        to: toStr,
        statuses: listStatuses,
        source: SOURCE,
        naverMenuId,
      }),
  });
  const appointments = data ?? [];

  const runSearch = () => setQ(keyword.trim());

  const syncMutation = useMutation({
    mutationFn: syncNaverReservations,
    onSuccess: (result) => {
      message.success(syncSummary(result));
      if (result.conflicts > 0) {
        message.warning(`CRM에서 수정한 예약 중 ${result.conflicts}건이 네이버에서도 바뀌었습니다. 확인이 필요합니다.`);
      }
      if (result.failed > 0) {
        message.error(
          `${result.failed}건은 가져오지 못했습니다 (네이버 예약번호 ${result.failures
            .map((f) => f.externalId)
            .join(', ')}). 나머지는 정상 반영됐습니다.`,
        );
      }
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
    query.set('source', SOURCE);
    if (naverMenuId) {
      query.set('naverMenuId', naverMenuId);
      const menuName = naverMenus?.find((m) => m.id === naverMenuId)?.name;
      if (menuName) query.set('naverMenuName', menuName);
    }
    window.open(`/appointments/print?${query.toString()}`, '_blank');
  };

  const columns: ColumnsType<Appointment> = [
    {
      title: '예약 일시',
      dataIndex: 'startAt',
      width: COL.datetime,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD (dd) HH:mm'),
    },
    // 미계약/계약 배지는 제거했다 — 가망/계약 고객 구분이 폐기되어 표시 의미가 없다(설계서 07 D8).
    { title: '고객명', dataIndex: 'customerName', width: COL.name },
    { title: '전화번호', dataIndex: 'phone', width: COL.code, render: (v: string) => formatPhone(v) },
    {
      // 화면에서 "예약 목적"은 네이버 예약 메뉴를 가리킨다 — 예약이 전부 네이버로 들어오므로
      // 손님이 실제로 고른 그 이름이 곧 목적이다. 내부 매핑값(purposeName, "가봉 피팅")은
      // 같은 뜻을 한 번 더 보여 주는 셈이라 열에서 뺐다.
      title: '예약 목적',
      dataIndex: 'naverMenu',
      width: COL.name,
      render: (v?: string | null) =>
        v ? (
          <Typography.Text ellipsis={{ tooltip: v }} style={{ maxWidth: 160 }}>
            {naverMenuLabel(v)}
          </Typography.Text>
        ) : (
          '-'
        ),
    },
    {
      title: '상태',
      dataIndex: 'status',
      width: COL.status,
      render: (v: AppointmentStatus) => (
        <StatusBadge label={metaOf(APPT_STATUS_META, v).label} color={metaOf(APPT_STATUS_META, v).color} />
      ),
    },
    {
      title: '동기화',
      dataIndex: 'syncStatus',
      width: COL.status,
      render: (v: Appointment['syncStatus']) => (
        <StatusBadge label={metaOf(SYNC_STATUS_META, v).label} color={metaOf(SYNC_STATUS_META, v).color} />
      ),
    },
    {
      title: '메모',
      dataIndex: 'memo',
      width: COL.text,
      // 열 ellipsis 옵션을 쓰지 않고 셀 안에서 자른다 — 툴팁으로 전문을 보여 주기 위해서다.
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
    <PageShell>
      <PageCard>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <ListToolbar
          filters={
            <>
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
              {/*
                * 예약 목적 구분 — 눌러서 바로 그 목적의 예약만 본다.
                * 건수는 일부러 붙이지 않는다 — 서버가 주는 count 는 적재된 전체 누적이라
                * 화면의 기간·검색과 무관하게 고정된 값이어서 오히려 오해를 준다.
                * 표시명은 키워드만 쓰고(가봉_조율의 시간 → 가봉) 원문은 툴팁으로 남긴다.
                */}
              <Segmented
                value={naverMenuId ?? ALL_MENUS}
                onChange={(v) => setNaverMenuId(v === ALL_MENUS ? undefined : (v as string))}
                options={[
                  { label: '전체', value: ALL_MENUS },
                  ...(naverMenus ?? []).map((m) => ({
                    value: m.id,
                    label: <span title={m.name}>{naverMenuLabel(m.name)}</span>,
                  })),
                ]}
              />
              {mode === 'list' ? (
                <>
                  {/* 통합 검색 1필드 — 예약자 이름·전화번호·예약 목적을 한 번에 찾는다(설계서 07 D4) */}
                  <Input
                    allowClear
                    style={{ width: LAYOUT.searchWidth }}
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
                </>
              ) : (
                <Space size={4}>
                  <Button icon={<LeftOutlined />} onClick={() => moveBase(-1)} aria-label="이전" />
                  <DatePicker allowClear={false} value={baseDate} onChange={(v) => v && setBaseDate(v)} />
                  <Button icon={<RightOutlined />} onClick={() => moveBase(1)} aria-label="다음" />
                  <Button onClick={() => setBaseDate(dayjs())}>오늘</Button>
                </Space>
              )}
            </>
          }
          info={isList ? <Typography.Text type="secondary">예약접수·확정 건만 보여 줍니다.</Typography.Text> : null}
          actions={
            <>
              {/* 설계 PDF 1페이지 "CRM 일정 달력 출력" */}
              <Button icon={<PrinterOutlined />} onClick={openPrint}>
                인쇄
              </Button>
              <Can permission="NAVER_SYNC">
                <Button icon={<SyncOutlined />} loading={syncMutation.isPending} onClick={() => syncMutation.mutate()}>
                  네이버 동기화
                </Button>
              </Can>
            </>
          }
        />

        {mode === 'list' ? (
          <DataTable<Appointment>
            rowKey="id"
            loading={isLoading}
            columns={columns}
            dataSource={appointments}
            pagination={{}}
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
      </PageCard>
    </PageShell>
  );
}
