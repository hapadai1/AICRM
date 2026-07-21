/**
 * DASH-001 대시보드
 * - 오늘 일정 타임테이블(10:00~20:00, 목적별 색 배지, 클릭 → 예약 상세)
 * - 주간 미니 캘린더 (오늘 ±3일)
 * - 확인사항 카드 5종 + 목록 패널 (TaskBoard)
 * - 공유 메모 (SharedMemoCard)
 */
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, Col, Empty, Row, Select, Space, Spin, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchDashboardSummary } from '../../api/dashboard';
import type { DashboardAppointment } from '../../api/dashboard';
import { SharedMemoCard } from './SharedMemoCard';
import { TaskBoard } from './TaskBoard';

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

const TIMETABLE_HOURS = Array.from({ length: 10 }, (_, i) => 10 + i); // 10:00~19:00 시작 슬롯

const STATUS_LABEL: Record<DashboardAppointment['status'], string> = {
  RESERVED: '예약',
  CONFIRMED: '확정',
  VISITED: '방문완료',
  CANCELLED: '취소',
  NO_SHOW: '노쇼',
};

export function DashboardPage() {
  const navigate = useNavigate();
  const [purposeFilter, setPurposeFilter] = useState<string[]>([]);
  const todayStr = dayjs().format('YYYY-MM-DD');

  const summaryQuery = useQuery({
    queryKey: ['dashboard', 'summary', todayStr],
    queryFn: () => fetchDashboardSummary(todayStr),
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

  const appointmentsByHour = useMemo(() => {
    const map = new Map<number, DashboardAppointment[]>();
    for (const apt of filteredAppointments) {
      const hour = dayjs(apt.startAt).hour();
      const slot = Math.min(Math.max(hour, 10), 19);
      map.set(slot, [...(map.get(slot) ?? []), apt]);
    }
    return map;
  }, [filteredAppointments]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card
            title={`오늘 일정 (${dayjs().format('YYYY-MM-DD dddd')})`}
            size="small"
            extra={
              <Select
                mode="multiple"
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
              <Empty description="오늘 예약이 없습니다." />
            ) : (
              <div>
                {TIMETABLE_HOURS.map((hour) => {
                  const slotAppointments = appointmentsByHour.get(hour) ?? [];
                  return (
                    <Row
                      key={hour}
                      style={{ borderTop: '1px solid #f0f0f0', minHeight: 40, padding: '4px 0' }}
                      align="middle"
                    >
                      <Col flex="64px">
                        <Typography.Text type="secondary">
                          {String(hour).padStart(2, '0')}:00
                        </Typography.Text>
                      </Col>
                      <Col flex="auto">
                        <Space wrap size={[8, 8]}>
                          {slotAppointments.map((apt) => (
                            <Tag
                              key={apt.id}
                              color={PURPOSE_COLOR[apt.purposeCode] ?? 'default'}
                              style={{ cursor: 'pointer', padding: '2px 8px', marginInlineEnd: 0 }}
                              onClick={() => navigate(`/appointments/${apt.id}`)}
                            >
                              {dayjs(apt.startAt).format('HH:mm')} {apt.customerName} ·{' '}
                              {apt.purposeName} · {STATUS_LABEL[apt.status]}
                              {apt.source === 'NAVER' ? ' · 네이버' : ''}
                            </Tag>
                          ))}
                        </Space>
                      </Col>
                    </Row>
                  );
                })}
              </div>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card title="주간 일정" size="small">
              <Row gutter={8}>
                {(summary?.week ?? []).map((day) => {
                  const d = dayjs(day.date);
                  const isToday = day.date === todayStr;
                  return (
                    <Col key={day.date} flex="1 1 0">
                      <Card
                        size="small"
                        style={{
                          textAlign: 'center',
                          background: isToday ? '#e6f4ff' : undefined,
                          borderColor: isToday ? '#1677ff' : undefined,
                        }}
                        styles={{ body: { padding: '8px 4px' } }}
                      >
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {d.format('dd')}
                        </Typography.Text>
                        <div>
                          <Typography.Text strong={isToday}>{d.format('D')}</Typography.Text>
                        </div>
                        <Badge
                          count={day.count}
                          showZero
                          color={day.count > 0 ? '#1677ff' : '#d9d9d9'}
                        />
                      </Card>
                    </Col>
                  );
                })}
              </Row>
            </Card>
            <SharedMemoCard />
          </Space>
        </Col>
      </Row>

      <TaskBoard taskCounts={summary?.taskCounts} />
    </Space>
  );
}
