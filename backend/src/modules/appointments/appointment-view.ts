import { Appointment, Consultation } from '@prisma/client';
import { usageTypeName } from './consultations.constants';

/**
 * 예약 응답 평면 뷰 (연동정합화 계약 §1).
 * 목록·상세·액션 응답 및 고객 상세·대시보드에서 공통 사용하는 순수 매퍼.
 */

export type AppointmentSyncStatus = 'NORMAL' | 'LOCAL_EDITED' | 'NAVER_CHANGED' | 'CONFLICT';

export type AppointmentWithRefs = Appointment & {
  customer?: { id: string; name: string; phone: string; customerStatus: string } | null;
  purpose?: { code: string; name: string } | null;
};

/**
 * 동기화 상태 판정: CRM 예약은 항상 NORMAL.
 * NAVER 예약은 localOverride → LOCAL_EDITED, naverUpdatedAt > syncedAt → NAVER_CHANGED, 둘 다 → CONFLICT.
 */
export function appointmentSyncStatus(
  appt: Pick<Appointment, 'source' | 'localOverride' | 'naverUpdatedAt' | 'syncedAt'>,
): AppointmentSyncStatus {
  if (appt.source !== 'NAVER') return 'NORMAL';
  const localEdited = appt.localOverride;
  const naverChanged =
    appt.naverUpdatedAt !== null && (appt.syncedAt === null || appt.naverUpdatedAt > appt.syncedAt);
  if (localEdited && naverChanged) return 'CONFLICT';
  if (localEdited) return 'LOCAL_EDITED';
  if (naverChanged) return 'NAVER_CHANGED';
  return 'NORMAL';
}

export function toAppointmentView(appt: AppointmentWithRefs) {
  return {
    id: appt.id,
    customerId: appt.customerId,
    customerName: appt.customer?.name ?? null,
    phone: appt.customer?.phone ?? null,
    customerStatus: appt.customer?.customerStatus ?? null,
    purposeCode: appt.purpose?.code ?? null,
    purposeName: appt.purpose?.name ?? null,
    source: appt.source,
    status: appt.status,
    startAt: appt.scheduledStart,
    endAt: appt.scheduledEnd,
    memo: appt.notes,
    version: appt.rowVersion,
    syncStatus: appointmentSyncStatus(appt),
    naverReservationId: appt.externalId,
    createdAt: appt.createdAt,
    updatedAt: appt.updatedAt,
  };
}

export type AppointmentView = ReturnType<typeof toAppointmentView>;

/** consultation_category 콤마 저장값 → interests[] */
export function parseInterests(consultationCategory: string | null): string[] {
  if (!consultationCategory) return [];
  return consultationCategory
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export type ConsultationWithStaff = Consultation & {
  staff?: { displayName: string } | null;
};

export function toConsultationView(row: ConsultationWithStaff) {
  return {
    id: row.id,
    appointmentId: row.appointmentId,
    customerId: row.customerId,
    interests: parseInterests(row.consultationCategory),
    content: row.content,
    // 초도 상담 항목 (개발설계서 05 G-01)
    usageType: row.usageType,
    usageTypeName: usageTypeName(row.usageType),
    budgetMin: row.budgetMin,
    budgetMax: row.budgetMax,
    preferredStyle: row.preferredStyle,
    desiredDueDate: row.desiredDueDate,
    consultedAt: row.consultedAt,
    createdBy: row.staff?.displayName ?? null,
    createdAt: row.createdAt,
  };
}

export type ConsultationView = ReturnType<typeof toConsultationView>;
