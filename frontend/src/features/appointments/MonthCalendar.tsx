import { Badge, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import type { CSSProperties } from 'react';
import type { Appointment } from '../../api/appointments';
import { SEMANTIC_COLOR } from '../../app/theme';
import { APPT_STATUS_META, appointmentKindLabel } from './appointment-constants';
import { metaOf } from '../../shared/status-meta';

/**
 * 월간 예약 캘린더 (개발설계서 05 G-02).
 * 설계 PDF 1페이지 "CRM 일정 달력 출력/확인"의 확인 쪽.
 * 셀을 누르면 그 날짜의 일간 뷰로 넘어간다.
 *
 * antd Calendar 대신 직접 그린다. antd 것은 6주 42칸 고정이라 이번 달과 상관없는
 * 지난달 말·다음달 초가 늘 함께 나왔고(9월이면 8/30~10/10), 그만큼 이번 달 칸이 납작해졌다.
 * 여기서는 이번 달 날짜만 4~6주로 담아 칸을 넓게 쓴다. 자체 달력 헤더(연/월 선택기)도
 * 두지 않는다 — 화면 위 툴바의 날짜 이동과 중복이었다.
 * 일/주 타임테이블(AppointmentsPage Timetable)과 같은 격자 규격을 쓴다.
 */

/** 한 칸에 보여 주는 예약 수. 나머지는 "+N건"으로 접는다. */
const MAX_VISIBLE = 5;
/** 칸 최소 높이 — 예약 5건 + 날짜 + "+N건" 줄이 들어가는 높이 */
const CELL_MIN_HEIGHT = 132;

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
/** 주말 날짜 숫자 색 — 매장이 가장 바쁜 날이라 평일과 구분해 둔다 */
const SUNDAY_COLOR = '#cf1322';
const SATURDAY_COLOR = '#1677ff';

interface Props {
  baseDate: Dayjs;
  appointments: Appointment[];
  onSelectDate: (date: Dayjs) => void;
  onOpen: (id: string) => void;
}

export function MonthCalendar({ baseDate, appointments, onSelectDate, onOpen }: Props) {
  // 날짜별로 미리 묶어 셀마다 전체 목록을 훑지 않게 한다.
  const byDate = new Map<string, Appointment[]>();
  for (const appointment of appointments) {
    // startAt 은 UTC(…Z)라 문자열을 자르면 한국 시각 오전 9시 전 예약이 전날 칸에 들어간다
    const key = dayjs(appointment.startAt).format('YYYY-MM-DD');
    const bucket = byDate.get(key);
    if (bucket) bucket.push(appointment);
    else byDate.set(key, [appointment]);
  }
  for (const list of byDate.values()) {
    list.sort((a, b) => a.startAt.localeCompare(b.startAt));
  }

  // 이번 달 날짜만 채운다. 1일 앞과 말일 뒤는 빈 칸으로 둬 요일 자리를 맞춘다.
  const first = baseDate.startOf('month');
  const daysInMonth = baseDate.daysInMonth();
  const leading = first.day(); // 0=일요일
  const weeks = Math.ceil((leading + daysInMonth) / 7);
  const cells: (Dayjs | null)[] = [];
  for (let i = 0; i < leading; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(first.date(d));
  while (cells.length < weeks * 7) cells.push(null);

  const cellStyle: CSSProperties = {
    borderTop: '1px solid #f0f0f0',
    borderLeft: '1px solid #f0f0f0',
    padding: 4,
    minHeight: CELL_MIN_HEIGHT,
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
        borderRight: '1px solid #f0f0f0',
        borderBottom: '1px solid #f0f0f0',
      }}
    >
      {WEEKDAYS.map((w, i) => (
        <div
          key={w}
          style={{
            ...cellStyle,
            minHeight: 0,
            textAlign: 'center',
            fontWeight: 600,
            background: '#fafafa',
            color: i === 0 ? SUNDAY_COLOR : i === 6 ? SATURDAY_COLOR : undefined,
          }}
        >
          {w}
        </div>
      ))}
      {cells.map((day, i) =>
        day === null ? (
          // 이번 달이 아닌 자리 — 날짜를 그리지 않아 이번 달만 눈에 들어온다
          // eslint-disable-next-line react/no-array-index-key
          <div key={`blank-${i}`} style={{ ...cellStyle, background: '#fafafa' }} />
        ) : (
          <DayCell
            key={day.format('YYYY-MM-DD')}
            day={day}
            rows={byDate.get(day.format('YYYY-MM-DD')) ?? []}
            selected={day.isSame(baseDate, 'day')}
            style={cellStyle}
            onSelectDate={onSelectDate}
            onOpen={onOpen}
          />
        ),
      )}
    </div>
  );
}

function DayCell({
  day,
  rows,
  selected,
  style,
  onSelectDate,
  onOpen,
}: {
  day: Dayjs;
  rows: Appointment[];
  selected: boolean;
  style: CSSProperties;
  onSelectDate: (date: Dayjs) => void;
  onOpen: (id: string) => void;
}) {
  const isToday = day.isSame(dayjs(), 'day');
  const weekday = day.day();
  return (
    <div
      onClick={() => onSelectDate(day)}
      style={{
        ...style,
        cursor: 'pointer',
        background: isToday ? SEMANTIC_COLOR.todayBg : selected ? SEMANTIC_COLOR.selectedBg : undefined,
      }}
    >
      <div
        style={{
          // 날짜 숫자는 칸 왼쪽 끝에 둔다 — 아래 예약 줄(배지)이 왼쪽에서 시작하므로
          // 숫자가 우측 끝에 있으면 어느 칸의 날짜인지 눈이 매번 되짚어야 했다(현업 요청).
          textAlign: 'left',
          fontSize: 12,
          fontWeight: isToday ? 700 : 600,
          marginBottom: 2,
          color: weekday === 0 ? SUNDAY_COLOR : weekday === 6 ? SATURDAY_COLOR : undefined,
        }}
      >
        {day.date()}
      </div>
      {rows.slice(0, MAX_VISIBLE).map((a) => (
        <div
          key={a.id}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(a.id);
          }}
          style={{
            cursor: 'pointer',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 12,
          }}
          title={`${dayjs(a.startAt).format('HH:mm')} ${a.customerName} · ${appointmentKindLabel(a)}`}
        >
          <Badge
            color={metaOf(APPT_STATUS_META, a.status).color}
            text={
              <span style={{ fontSize: 12 }}>
                {dayjs(a.startAt).format('HH:mm')} {a.customerName}
              </span>
            }
          />
        </div>
      ))}
      {rows.length > MAX_VISIBLE && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          +{rows.length - MAX_VISIBLE}건
        </Typography.Text>
      )}
    </div>
  );
}
