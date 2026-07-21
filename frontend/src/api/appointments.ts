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
  createdBy: string;
  createdAt: string;
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
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  purposeCodes?: string[];
  statuses?: AppointmentStatus[];
  source?: AppointmentSource;
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
  created: number;
  updated: number;
  conflicts: number;
}

export function fetchAppointmentPurposes(): Promise<AppointmentPurpose[]> {
  return request({ url: '/appointment-purposes', method: 'GET' });
}

export function fetchAppointments(params: AppointmentListParams): Promise<Paged<Appointment>> {
  return request({
    url: '/appointments',
    method: 'GET',
    params: {
      from: params.from,
      to: params.to,
      purposeCodes: params.purposeCodes?.length ? params.purposeCodes.join(',') : undefined,
      statuses: params.statuses?.length ? params.statuses.join(',') : undefined,
      source: params.source || undefined,
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
  return request({ url: `/appointments/${id}`, method: 'PATCH', data: body });
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
  body: { interests: string[]; content: string },
): Promise<Consultation> {
  return request({ url: `/appointments/${appointmentId}/consultations`, method: 'POST', data: body });
}

export function syncNaverReservations(): Promise<NaverSyncResult> {
  return request({ url: '/integrations/naver/reservations/sync', method: 'POST' });
}
