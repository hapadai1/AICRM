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
