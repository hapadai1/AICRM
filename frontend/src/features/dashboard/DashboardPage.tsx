/**
 * DASH-001 대시보드
 * - 오늘 일정 타임테이블(10:00~20:00, 목적별 색 배지, 클릭 → 예약 상세)
 * - 주간 미니 캘린더 (오늘 ±3일)
 * - 확인사항 카드 5종 + 목록 패널 (TaskBoard)
 * - 공유 메모 (SharedMemoCard)
 */
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, Col, Empty, Row, Select, Space, Spin, Tag, Typography, theme } from 'antd';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchDashboardSummary } from '../../api/dashboard';
import type { DashboardAppointment } from '../../api/dashboard';
import { SharedMemoCard } from './SharedMemoCard';
import { TaskBoard } from './TaskBoard';
import { SEMANTIC_COLOR } from '../../app/theme';

/** 예약 목적별 색 (텍스트 병기 — 색상 단독 전달 금지 규칙 준수) */
const PURPOSE_COLOR: Record<string, string> = {
  INITIAL_CONSULTATION: 'blue',
  FITTING: 'purple',
  PICKUP: 'green',
  REPAIR_RECEIPT: 'orange',
  REPAIR_PICKUP: 'gold',
  RENTAL_PICKUP: 'cyan',
  RENTAL_RETURN: 'magenta',
};

// 업무시간 10:00~20:00을 1시간 단위 10슬롯으로 분할한 타임테이블. (예약은 1시간 단위)
const DAY_START_MIN = 10 * 60; // 10:00
const DAY_END_MIN = 20 * 60; // 20:00
const SLOT_MIN = 60;
const SLOT_HEIGHT = 40; // 슬롯 1칸 픽셀 높이
const TIME_GUTTER = 64; // 좌측 시간 라벨 폭(px)
const BOX_WIDTH = 260; // 예약 박스 고정 폭(px)
const BOX_GAP = 8; // 같은 슬롯 예약 사이 간격(px)
/**
 * 예약이 있는 구간만 그릴 때의 최소 칸 수(=3시간).
 * 업무시간 10칸을 늘 펼치면 예약 1건인 날에도 빈 격자가 남아 오른쪽 컬럼과 높이가 크게 어긋났다.
 * 예약이 몰린 구간 앞뒤로 한 칸씩 여유를 두고, 너무 납작해지지 않게 이 값까지는 채운다.
 */
const MIN_SLOT_COUNT = 3;

/** 하루 기준 분에서 그 분이 속한 1시간 슬롯의 시작 분 */
function slotStartOf(min: number): number {
  return Math.floor((min - DAY_START_MIN) / SLOT_MIN) * SLOT_MIN + DAY_START_MIN;
}

/** 예약 시작 시각을 하루 기준 분으로 */
function startMinOf(apt: DashboardAppointment): number {
  const start = dayjs(apt.startAt);
  return start.hour() * 60 + start.minute();
}

/** 업무시간(10:00~20:00) 안에 시작하는 예약인지 */
function inBusinessHours(apt: DashboardAppointment): boolean {
  const min = startMinOf(apt);
  return min >= DAY_START_MIN && min < DAY_END_MIN;
}

/**
 * 그릴 시간 구간을 예약이 있는 범위로 좁힌다.
 * 예약이 없으면 업무 시작부터 최소 칸 수만 그린다.
 */
function visibleRange(appointments: DashboardAppointment[]): { start: number; count: number } {
  if (appointments.length === 0) return { start: DAY_START_MIN, count: MIN_SLOT_COUNT };
  const slots = appointments.map((apt) => slotStartOf(startMinOf(apt)));
  // 예약 앞뒤로 한 칸씩 여유
  let start = Math.max(DAY_START_MIN, Math.min(...slots) - SLOT_MIN);
  let end = Math.min(DAY_END_MIN, Math.max(...slots) + SLOT_MIN * 2);
  // 최소 칸 수를 못 채우면 뒤로, 그래도 모자라면 앞으로 늘린다.
  if ((end - start) / SLOT_MIN < MIN_SLOT_COUNT) {
    end = Math.min(DAY_END_MIN, start + MIN_SLOT_COUNT * SLOT_MIN);
    start = Math.max(DAY_START_MIN, end - MIN_SLOT_COUNT * SLOT_MIN);
  }
  return { start, count: (end - start) / SLOT_MIN };
}

const STATUS_LABEL: Record<DashboardAppointment['status'], string> = {
  RESERVED: '예약',
  CONFIRMED: '확정',
  VISITED: '방문완료',
  CANCELLED: '취소',
  NO_SHOW: '노쇼',
};

/** 하루 기준 분(600=10:00)을 HH:mm 문자열로. */
function fmtMin(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** 화면에 배치된 예약 1건 — 시작 슬롯 top과 같은 슬롯 겹침 레인 정보. */
interface LaidOutAppointment {
  apt: DashboardAppointment;
  top: number;
  lane: number;
}

/**
 * 예약들을 1시간 그리드 위 절대배치 좌표로 변환한다.
 * - 박스는 시작 슬롯 한 칸(1시간)으로 균일 표시하며 종료시각만큼 늘리지 않는다.
 * - 업무시간(10:00~20:00) 밖 예약은 표시하지 않는다(호출 측에서 건수를 따로 알린다).
 * - 같은 슬롯에 여러 예약이 있으면 레인(열)을 나눠 나란히 배치한다.
 * @param rangeStart 그리드 첫 칸의 시작 분 — top 좌표 기준
 */
function layoutAppointments(
  appointments: DashboardAppointment[],
  rangeStart: number,
): LaidOutAppointment[] {
  const bySlot = new Map<number, DashboardAppointment[]>();
  for (const apt of appointments) {
    const start = dayjs(apt.startAt);
    const startMin = start.hour() * 60 + start.minute();
    if (startMin < DAY_START_MIN || startMin >= DAY_END_MIN) continue;
    // 1시간 슬롯 시작으로 내림 (예: 11:45 → 11:00 슬롯)
    const slotStart = slotStartOf(startMin);
    bySlot.set(slotStart, [...(bySlot.get(slotStart) ?? []), apt]);
  }

  const result: LaidOutAppointment[] = [];
  for (const [slotStart, apts] of bySlot) {
    apts.forEach((apt, lane) => {
      result.push({
        apt,
        top: ((slotStart - rangeStart) / SLOT_MIN) * SLOT_HEIGHT,
        lane,
      });
    });
  }
  return result;
}

export function DashboardPage() {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const [purposeFilter, setPurposeFilter] = useState<string[]>([]);
  const todayStr = dayjs().format('YYYY-MM-DD');
  // 주간 미니 캘린더에서 선택한 기준일. 좌측 일정 타임테이블·주간 캘린더가 이 날짜에 맞춰진다.
  const [selectedDate, setSelectedDate] = useState(todayStr);
  const isTodaySelected = selectedDate === todayStr;

  const summaryQuery = useQuery({
    queryKey: ['dashboard', 'summary', selectedDate],
    queryFn: () => fetchDashboardSummary(selectedDate),
  });
  const summary = summaryQuery.data;

  const purposeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const apt of summary?.appointments ?? []) {
      seen.set(apt.purposeCode, apt.purposeName);
    }
    return Array.from(seen, ([value, label]) => ({ value, label }));
  }, [summary]);

  const filteredAppointments = useMemo(() => {
    const list = summary?.appointments ?? [];
    if (purposeFilter.length === 0) return list;
    return list.filter((a) => purposeFilter.includes(a.purposeCode));
  }, [summary, purposeFilter]);

  // 업무시간(10~20시) 밖 예약은 격자에 그리지 않는다. 예전에는 조용히 사라져
  // 대시보드에서 아예 안 보였으므로, 예약 화면처럼 건수를 아래에 알린다.
  const gridAppointments = useMemo(
    () => filteredAppointments.filter(inBusinessHours),
    [filteredAppointments],
  );
  const outOfHoursCount = filteredAppointments.length - gridAppointments.length;

  // 예약이 있는 구간만 그린다 — 빈 격자로 카드 높이를 늘리지 않는다.
  const range = useMemo(() => visibleRange(gridAppointments), [gridAppointments]);
  const timetableSlots = useMemo(
    () => Array.from({ length: range.count }, (_, i) => range.start + i * SLOT_MIN),
    [range],
  );

  const laidOutAppointments = useMemo(
    () => layoutAppointments(gridAppointments, range.start),
    [gridAppointments, range.start],
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card
            title={`${isTodaySelected ? '오늘 일정' : '일정'} (${dayjs(selectedDate).format('YYYY-MM-DD dddd')})`}
            size="small"
            extra={
              <Select
                mode="multiple"
                size="small"
                allowClear
                placeholder="목적 필터"
                style={{ minWidth: 200 }}
                value={purposeFilter}
                onChange={setPurposeFilter}
                options={purposeOptions}
                maxTagCount="responsive"
              />
            }
          >
            {summaryQuery.isLoading ? (
              <div style={{ textAlign: 'center', padding: 32 }}>
                <Spin />
              </div>
            ) : filteredAppointments.length === 0 ? (
              <Empty description={`${isTodaySelected ? '오늘' : '해당 날짜'} 예약이 없습니다.`} />
            ) : (
              <div style={{ position: 'relative', height: range.count * SLOT_HEIGHT }}>
                {/* 1시간 단위 눈금 + 좌측 시간 라벨 (배경) */}
                {timetableSlots.map((min, i) => (
                  <div
                    key={min}
                    style={{
                      position: 'absolute',
                      top: i * SLOT_HEIGHT,
                      left: 0,
                      right: 0,
                      height: SLOT_HEIGHT,
                      // 1시간 단위 정시 눈금 실선
                      borderTop: '1px solid #f0f0f0',
                    }}
                  >
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 12, paddingLeft: 4, lineHeight: '16px' }}
                    >
                      {fmtMin(min)}
                    </Typography.Text>
                  </div>
                ))}
                {/* 예약 블록 (전경) — 시작 슬롯 한 칸 균일 크기, 같은 슬롯은 레인 분할 */}
                {laidOutAppointments.map(({ apt, top, lane }) => (
                  <div
                    key={apt.id}
                    style={{
                      position: 'absolute',
                      top: top + 1,
                      height: SLOT_HEIGHT - 2,
                      left: TIME_GUTTER + lane * (BOX_WIDTH + BOX_GAP),
                      width: BOX_WIDTH,
                    }}
                  >
                    <Tag
                      color={PURPOSE_COLOR[apt.purposeCode] ?? 'default'}
                      style={{
                        margin: 0,
                        width: '100%',
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        cursor: 'pointer',
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                        textOverflow: 'ellipsis',
                        padding: '2px 6px',
                        fontSize: 12,
                      }}
                      onClick={() => navigate(`/appointments/${apt.id}`)}
                    >
                      {apt.customerName} · {apt.purposeName} · {STATUS_LABEL[apt.status]}
                      {apt.source === 'NAVER' ? ' · 네이버' : ''}
                    </Tag>
                  </div>
                ))}
              </div>
            )}
            {outOfHoursCount > 0 && (
              <div style={{ marginTop: 8 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  표시 구간(10:00~20:00) 외 예약 {outOfHoursCount}건 — 예약 화면에서 확인하세요.
                </Typography.Text>
              </div>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={10}>
            <Card
              title="주간 일정"
              size="small"
              extra={
                <Button
                  size="small"
                  onClick={() => setSelectedDate(todayStr)}
                  disabled={isTodaySelected}
                >
                  오늘
                </Button>
              }
            >
              <Row gutter={8}>
                {(summary?.week ?? []).map((day) => {
                  const d = dayjs(day.date);
                  const isToday = day.date === todayStr;
                  // 선택일 강조는 오늘(파란색)과 구분되도록 별도 색상(골드)으로 표기. 오늘은 항상 파란색 유지.
                  const isSelected = day.date === selectedDate && !isToday;
                  return (
                    <Col key={day.date} flex="1 1 0">
                      <Card
                        size="small"
                        hoverable
                        onClick={() => setSelectedDate(day.date)}
                        style={{
                          textAlign: 'center',
                          cursor: 'pointer',
                          background: isToday ? SEMANTIC_COLOR.todayBg : isSelected ? SEMANTIC_COLOR.selectedBg : undefined,
                          borderColor: isToday ? token.colorPrimary : isSelected ? SEMANTIC_COLOR.selectedBorder : undefined,
                          boxShadow: isSelected ? '0 0 0 2px rgba(250,173,20,0.2)' : undefined,
                        }}
                        styles={{ body: { padding: '8px 4px' } }}
                      >
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {d.format('dd')}
                        </Typography.Text>
                        <div>
                          <Typography.Text strong={isToday || isSelected}>
                            {d.format('D')}
                          </Typography.Text>
                        </div>
                        <Badge
                          count={day.count}
                          showZero
                          color={day.count > 0 ? token.colorPrimary : token.colorBorder}
                        />
                      </Card>
                    </Col>
                  );
                })}
              </Row>
            </Card>
        </Col>
      </Row>

      {/*
        공유 메모는 우측 컬럼 안에 있었다. 타임테이블이 예약 있는 구간만 그리도록 바뀌어
        좌측 카드가 짧아지자 이번엔 우측이 훨씬 길어져 좌우가 다시 어긋났다.
        메모는 가로로 넓을 때 더 읽기 좋은 목록이라 전체 폭으로 내린다.
      */}
      <SharedMemoCard />

      <TaskBoard taskCounts={summary?.taskCounts} />
    </Space>
  );
}
