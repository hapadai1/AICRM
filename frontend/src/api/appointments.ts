import { request } from './client';

/** 예약 상태 (문서 03 §4.3) */
export type AppointmentStatus = 'RESERVED' | 'CONFIRMED' | 'VISITED' | 'CANCELLED' | 'NO_SHOW';
/** 예약 출처 */
export type AppointmentSource = 'NAVER' | 'CRM';
/** 네이버 동기화 상태 */
export type AppointmentSyncStatus = 'NORMAL' | 'LOCAL_EDITED' | 'NAVER_CHANGED' | 'CONFLICT';

export type CustomerStatus = 'PROSPECT' | 'CONTRACTED' | 'INACTIVE';

export interface Appointment {
  id: string;
  customerId?: string;
  customerName: string;
  phone: string;
  /** 연결된 고객의 상태 (미연결 시 undefined) */
  customerStatus?: CustomerStatus;
  purposeCode: string;
  purposeName: string;
  startAt: string; // ISO-8601
  endAt: string; // ISO-8601
  status: AppointmentStatus;
  source: AppointmentSource;
  syncStatus: AppointmentSyncStatus;
  naverReservationId?: string;
  /** 네이버 예약 메뉴 이름 (예: "예복상담"). CRM 예약은 null */
  naverMenu?: string | null;
  /** 네이버 예약 메뉴 ID — 메뉴 이름이 바뀌어도 그대로다 */
  naverMenuId?: string | null;
  memo?: string;
  cancelReason?: string;
  visitedAt?: string;
  /** 충돌 시 네이버 원본 예약 일시 */
  conflictNaverStartAt?: string;
  version: number;
}

export interface Consultation {
  id: string;
  appointmentId: string;
  customerId?: string;
  /** 거래 관심 (비즈니스 맞춤, 웨딩 렌탈 등) */
  interests: string[];
  content: string;
  /** 초도 상담 항목 (개발설계서 05 G-01) */
  usageType?: string | null;
  usageTypeName?: string | null;
  budgetMin?: number | null;
  budgetMax?: number | null;
  preferredStyle?: string | null;
  desiredDueDate?: string | null;
  createdBy: string;
  createdAt: string;
}

/** 용도 — 진행 단계 trackType과 1:1 대응 */
export const USAGE_TYPES = ['BUSINESS_CUSTOM', 'WEDDING_RENTAL'] as const;
export type UsageType = (typeof USAGE_TYPES)[number];

export const USAGE_TYPE_LABELS: Record<UsageType, string> = {
  BUSINESS_CUSTOM: '비즈니스 맞춤',
  WEDDING_RENTAL: '웨딩패키지 렌탈',
};

/** 초도 상담 항목 입력값 */
export interface ConsultationIntake {
  usageType?: UsageType;
  budgetMin?: number;
  budgetMax?: number;
  preferredStyle?: string;
  desiredDueDate?: string;
}

export interface AppointmentDetail extends Appointment {
  consultations: Consultation[];
}

export interface AppointmentPurpose {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  active: boolean;
}

export interface PageInfo {
  number: number;
  size: number;
  totalElements: number;
  totalPages: number;
}

export interface Paged<T> {
  data: T[];
  page: PageInfo;
}

export interface AppointmentListParams {
  /** 통합 검색어 — 고객명 / 전화번호 / 예약 목적명 (설계서 07 D4) */
  q?: string;
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
  purposeCodes?: string[];
  statuses?: AppointmentStatus[];
  source?: AppointmentSource;
  /** 네이버 메뉴 ID 로 좁힌다 (이름은 파트너센터에서 바뀔 수 있다) */
  naverMenuId?: string;
  page?: number;
  size?: number;
}

/** 생성·수정 요청 body — 계약 문서 04 §1: scheduledStart/scheduledEnd/notes 로 전송 */
export interface AppointmentSaveBody {
  customerName: string;
  phone: string;
  purposeCode: string;
  scheduledStart: string;
  scheduledEnd: string;
  notes?: string;
  customerId?: string;
  version?: number;
}

export interface NaverSyncResult {
  fetched: number;
  created: number;
  updated: number;
  cancelled: number;
  conflicts: number;
  unchanged: number;
  /** 적재하지 못한 건수 — 나머지는 정상 적재된다 */
  failed: number;
  failures: Array<{ externalId: string; reason: string }>;
  /** 첫 적재(과거·미래 30일 조회) 여부 */
  firstLoad: boolean;
  /** 반영한 데이터를 네이버에서 받아 온 시각 */
  fetchedAt: string | null;
  /** true 면 네이버에 새로 접속하지 않고 최근 수집본을 썼다 */
  fromCache: boolean;
}

/** 수집된 네이버 메뉴와 건수 (이름은 가장 최근에 맞춰 본 것) */
export interface NaverMenu {
  id: string;
  name: string;
  count: number;
}

export function fetchAppointmentPurposes(): Promise<AppointmentPurpose[]> {
  return request({ url: '/appointment-purposes', method: 'GET' });
}

export function fetchNaverMenus(): Promise<NaverMenu[]> {
  return request({ url: '/appointments/naver-menus', method: 'GET' });
}

/** 서버 페이지 크기 상한 (backend PageQueryDto @Max(100)) */
const MAX_PAGE_SIZE = 100;
/** 폭주 방지 상한. 한 달치 예약이 2000건을 넘을 일은 없다. */
const MAX_PAGES = 20;

/**
 * 조건에 맞는 예약을 **전부** 받아 온다.
 *
 * 한 번의 요청으로는 최대 100건뿐이라, 캘린더처럼 "그 기간 전체"를 그려야 하는 화면이
 * 한 페이지만 받으면 뒤쪽 예약이 통째로 빠진다 — 예약 150건인 달에서 뒤 50건이 사라져
 * 그 날들이 "예약 없는 날"로 보이는 문제가 실제로 있었다(2026-09 확인).
 * 화면에서 직접 페이지를 넘기는 목록 표와 달리, 캘린더·인쇄는 이 함수를 쓴다.
 */
export async function fetchAllAppointments(
  params: Omit<AppointmentListParams, 'page' | 'size'>,
): Promise<Appointment[]> {
  const all: Appointment[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await fetchAppointments({ ...params, page, size: MAX_PAGE_SIZE });
    all.push(...res.data);
    if (all.length >= res.page.totalElements || res.data.length === 0) break;
  }
  // 서버도 시작일 오름차순으로 주지만, 페이지를 이어 붙인 뒤 한 번 더 맞춰 둔다.
  return all.sort((a, b) => a.startAt.localeCompare(b.startAt));
}

export function fetchAppointments(params: AppointmentListParams): Promise<Paged<Appointment>> {
  return request({
    url: '/appointments',
    method: 'GET',
    params: {
      q: params.q || undefined,
      from: params.from,
      to: params.to,
      purposeCodes: params.purposeCodes?.length ? params.purposeCodes.join(',') : undefined,
      statuses: params.statuses?.length ? params.statuses.join(',') : undefined,
      source: params.source || undefined,
      naverMenuId: params.naverMenuId || undefined,
      page: params.page ?? 1,
      size: params.size ?? 30,
    },
  });
}

export function fetchAppointment(id: string): Promise<AppointmentDetail> {
  return request({ url: `/appointments/${id}`, method: 'GET' });
}

export function createAppointment(body: AppointmentSaveBody): Promise<Appointment> {
  return request({ url: '/appointments', method: 'POST', data: body });
}

export function updateAppointment(id: string, body: Partial<AppointmentSaveBody>): Promise<Appointment> {
  // UpdateAppointmentDto 허용 필드로만 정제한다. 고객명·전화는 예약이 아니라 고객 엔티티 소관이라
  // 수정 대상이 아니고(백엔드에 없음), forbidNonWhitelisted에서 400이므로 반드시 제외한다.
  const data: Record<string, unknown> = {};
  if (body.purposeCode !== undefined) data.purposeCode = body.purposeCode;
  if (body.scheduledStart !== undefined) data.scheduledStart = body.scheduledStart;
  if (body.scheduledEnd !== undefined) data.scheduledEnd = body.scheduledEnd;
  if (body.notes !== undefined) data.notes = body.notes;
  if (body.customerId !== undefined) data.customerId = body.customerId;
  if (body.version !== undefined) data.version = body.version;
  return request({ url: `/appointments/${id}`, method: 'PATCH', data });
}

export function confirmAppointment(id: string): Promise<Appointment> {
  return request({ url: `/appointments/${id}/confirm`, method: 'POST' });
}

export function visitAppointment(id: string): Promise<Appointment> {
  return request({ url: `/appointments/${id}/visit`, method: 'POST' });
}

export function cancelAppointment(id: string, reason: string): Promise<Appointment> {
  return request({ url: `/appointments/${id}/cancel`, method: 'POST', data: { reason } });
}

export function noShowAppointment(id: string): Promise<Appointment> {
  return request({ url: `/appointments/${id}/no-show`, method: 'POST' });
}

/** 네이버 원본/CRM 수정값 충돌 해소 (계약 문서 04 §1: body { resolution }) */
export function resolveAppointmentConflict(id: string, choice: 'NAVER' | 'CRM'): Promise<Appointment> {
  return request({ url: `/appointments/${id}/resolve-conflict`, method: 'POST', data: { resolution: choice } });
}

export function saveConsultation(
  appointmentId: string,
  body: { interests: string[]; content: string } & ConsultationIntake,
): Promise<Consultation> {
  return request({ url: `/appointments/${appointmentId}/consultations`, method: 'POST', data: body });
}

/** 상담 내용 정정 — PATCH /consultations/{id} */
export function updateConsultation(
  id: string,
  body: { interests?: string[]; content?: string } & ConsultationIntake,
): Promise<Consultation> {
  return request({ url: `/consultations/${id}`, method: 'PATCH', data: body });
}

export function syncNaverReservations(): Promise<NaverSyncResult> {
  return request({ url: '/integrations/naver/reservations/sync', method: 'POST' });
}
