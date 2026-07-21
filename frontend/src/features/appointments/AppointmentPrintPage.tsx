import { useQuery } from '@tanstack/react-query';
import { Spin } from 'antd';
import dayjs from 'dayjs';
import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchAppointments, type Appointment } from '../../api/appointments';
import { useAuthStore } from '../../app/auth-store';
import { APPT_STATUS_META } from './appointment-constants';
import { metaOf } from '../../shared/status-meta';

/**
 * 예약 일정 인쇄 (개발설계서 05 G-02).
 * 설계 PDF 1페이지 "CRM 일정 달력 출력/확인"의 출력 쪽.
 *
 * 별도 경로(`/appointments/print`)로 열어 메뉴·버튼 없이 표만 인쇄한다.
 * 목록 API를 그대로 쓰되 백엔드 size 상한(100)을 넘길 수 있어 페이지를 순회한다.
 */

const PAGE_SIZE = 100;
/** 폭주 방지 상한. 한 달치 예약이 이보다 많을 일은 없다. */
const MAX_PAGES = 20;

async function fetchAllAppointments(params: {
  from: string;
  to: string;
  purposeCodes: string[];
}): Promise<Appointment[]> {
  const all: Appointment[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await fetchAppointments({ ...params, page, size: PAGE_SIZE });
    all.push(...res.data);
    if (all.length >= res.page.totalElements || res.data.length === 0) break;
  }
  return all.sort((a, b) => a.startAt.localeCompare(b.startAt));
}

const PRINT_STYLE = `
  @page { size: A4 portrait; margin: 12mm; }
  @media print {
    .no-print { display: none !important; }
  }
  .print-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .print-table th, .print-table td {
    border: 1px solid #d9d9d9; padding: 5px 7px; text-align: left;
  }
  .print-table th { background: #fafafa; font-weight: 600; }
  .print-table tr { page-break-inside: avoid; }
  .print-day { background: #f0f0f0; font-weight: 600; }
`;

export function AppointmentPrintPage() {
  const [params] = useSearchParams();
  const userName = useAuthStore((s) => s.user?.displayName ?? '');

  const from = params.get('from') ?? dayjs().format('YYYY-MM-DD');
  const to = params.get('to') ?? from;
  const purposeCodes = (params.get('purposeCodes') ?? '').split(',').filter(Boolean);

  const { data, isLoading } = useQuery({
    queryKey: ['appointments', 'print', { from, to, purposeCodes }],
    queryFn: () => fetchAllAppointments({ from, to, purposeCodes }),
  });

  // 표가 다 그려진 뒤 한 번만 인쇄창을 띄운다.
  useEffect(() => {
    if (!isLoading && data) {
      const timer = setTimeout(() => window.print(), 300);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [isLoading, data]);

  if (isLoading || !data) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin />
      </div>
    );
  }

  // 날짜가 바뀌는 지점에 구분 행을 넣어 종이에서 읽기 쉽게 한다.
  let lastDate = '';

  return (
    <div style={{ padding: 16, background: '#fff' }}>
      <style>{PRINT_STYLE}</style>

      <div style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>예약 일정표</h2>
        <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
          기간 {from} ~ {to} · 총 {data.length}건 · 출력 {dayjs().format('YYYY-MM-DD HH:mm')}
          {userName ? ` · ${userName}` : ''}
        </div>
      </div>

      <button className="no-print" onClick={() => window.print()} style={{ marginBottom: 12 }}>
        인쇄
      </button>

      <table className="print-table">
        <thead>
          <tr>
            <th style={{ width: '10%' }}>시각</th>
            <th style={{ width: '15%' }}>고객명</th>
            <th style={{ width: '17%' }}>연락처</th>
            <th style={{ width: '15%' }}>목적</th>
            <th style={{ width: '10%' }}>상태</th>
            <th>메모</th>
          </tr>
        </thead>
        <tbody>
          {data.length === 0 && (
            <tr>
              <td colSpan={6} style={{ textAlign: 'center', color: '#999' }}>
                해당 기간에 예약이 없습니다.
              </td>
            </tr>
          )}
          {data.map((a) => {
            const date = a.startAt.slice(0, 10);
            const isNewDay = date !== lastDate;
            lastDate = date;
            return (
              <>
                {isNewDay && (
                  <tr key={`${date}-head`} className="print-day">
                    <td colSpan={6}>{dayjs(date).format('YYYY-MM-DD (dd)')}</td>
                  </tr>
                )}
                <tr key={a.id}>
                  <td>{a.startAt.slice(11, 16)}</td>
                  <td>{a.customerName}</td>
                  <td>{a.phone}</td>
                  <td>{a.purposeName}</td>
                  <td>{metaOf(APPT_STATUS_META, a.status).label}</td>
                  <td>{a.memo ?? ''}</td>
                </tr>
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
