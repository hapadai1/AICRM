import { Badge, Calendar, Space, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import type { Appointment } from '../../api/appointments';
import { APPT_STATUS_META } from './appointment-constants';
import { metaOf } from '../../shared/status-meta';

/**
 * 월간 예약 캘린더 (개발설계서 05 G-02).
 * 설계 PDF 1페이지 "CRM 일정 달력 출력/확인"의 확인 쪽.
 * 셀을 누르면 그 날짜의 일간 뷰로 넘어간다.
 */

/** 한 셀에 다 보여주면 넘치므로 앞의 몇 건만 보이고 나머지는 개수로 접는다. */
const MAX_VISIBLE = 3;

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
    const key = appointment.startAt.slice(0, 10);
    const bucket = byDate.get(key);
    if (bucket) bucket.push(appointment);
    else byDate.set(key, [appointment]);
  }
  for (const list of byDate.values()) {
    list.sort((a, b) => a.startAt.localeCompare(b.startAt));
  }

  return (
    <Calendar
      value={baseDate}
      onSelect={(date, info) => {
        // 패널 이동(월 전환)은 날짜 선택으로 치지 않는다.
        if (info?.source === 'date') onSelectDate(date);
      }}
      cellRender={(current, info) => {
        if (info.type !== 'date') return info.originNode;
        const rows = byDate.get(current.format('YYYY-MM-DD')) ?? [];
        if (rows.length === 0) return null;
        return (
          <Space direction="vertical" size={0} style={{ width: '100%' }}>
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
                title={`${a.startAt.slice(11, 16)} ${a.customerName} · ${a.purposeName}`}
              >
                <Badge
                  color={metaOf(APPT_STATUS_META, a.status).color}
                  text={
                    <span style={{ fontSize: 12 }}>
                      {a.startAt.slice(11, 16)} {a.customerName}
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
          </Space>
        );
      }}
    />
  );
}
