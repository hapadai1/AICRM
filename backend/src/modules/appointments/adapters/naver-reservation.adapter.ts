import { Injectable } from '@nestjs/common';

/**
 * 네이버 예약 원본 레코드 (설계서 16.1 — 네이버 → CRM 단방향 수집).
 * 실제 연동 구현 전까지 어댑터 인터페이스로 격리한다 (구현표준 1.1).
 */
export interface NaverReservationRecord {
  /** 네이버 예약 고유번호 → appointments.external_id */
  externalId: string;
  customerName: string;
  phone: string;
  /** appointment_purposes.code (INITIAL_CONSULTATION 등) */
  purposeCode: string;
  /** ISO-8601 */
  scheduledStart: string;
  scheduledEnd?: string;
  /** 네이버 측 상태를 CRM 상태로 매핑한 값 */
  status: 'RESERVED' | 'CONFIRMED' | 'CANCELLED';
  /** 네이버 최종 변경 시각 (ISO-8601) */
  naverUpdatedAt?: string;
  notes?: string;
}

export interface NaverReservationAdapter {
  /** 신규·변경·취소 예약 목록을 가져온다. */
  fetchReservations(): Promise<NaverReservationRecord[]>;
}

export const NAVER_RESERVATION_ADAPTER = Symbol('NAVER_RESERVATION_ADAPTER');

/** MVP 스텁: 실제 네이버 API 연동 전까지 빈 목록을 반환한다. */
@Injectable()
export class NaverReservationStubAdapter implements NaverReservationAdapter {
  async fetchReservations(): Promise<NaverReservationRecord[]> {
    return [];
  }
}
