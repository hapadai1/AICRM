import type {
  Appointment,
  AppointmentSource,
  AppointmentStatus,
  AppointmentSyncStatus,
} from '../../api/appointments';

/**
 * 예약 목적 짧은 표시명 — "가봉_조율의 시간" → "가봉".
 * 화면의 "예약 목적"은 네이버 예약 메뉴를 가리킨다. 메뉴명이 "키워드_감성 문구" 형태라
 * 카드·표에서는 키워드만 보여 준다(원문은 툴팁).
 */
export function naverMenuLabel(name?: string | null): string {
  if (!name) return '';
  return name.split('_')[0].trim() || name;
}

/**
 * 예약 종류 표시명. 네이버 메뉴를 쓰고, 없을 때만 내부 매핑값(purposeName)으로 떨어진다 —
 * 매핑값으로 합치면 "예복상담"과 "비즈니스 맞춤정장"이 둘 다 "맞춤 상담"이 되어 구분이 사라진다.
 */
export function appointmentKindLabel(a: Pick<Appointment, 'naverMenu' | 'purposeName'>): string {
  return naverMenuLabel(a.naverMenu) || a.purposeName;
}

interface Meta {
  label: string;
  /** AntD Badge/Tag 색상명 */
  color: string;
  /** 캘린더 카드 좌측 보더 등 원색 표기 */
  hex: string;
}

export const APPT_STATUS_META: Record<AppointmentStatus, Meta> = {
  RESERVED: { label: '예약', color: 'blue', hex: '#1677ff' },
  CONFIRMED: { label: '확정', color: 'cyan', hex: '#13c2c2' },
  VISITED: { label: '방문완료', color: 'green', hex: '#52c41a' },
  CANCELLED: { label: '취소', color: 'default', hex: '#bfbfbf' },
  NO_SHOW: { label: '노쇼', color: 'red', hex: '#ff4d4f' },
};

export const SYNC_STATUS_META: Record<AppointmentSyncStatus, { label: string; color: string }> = {
  NORMAL: { label: '정상', color: 'green' },
  LOCAL_EDITED: { label: '로컬수정', color: 'orange' },
  NAVER_CHANGED: { label: '네이버변경', color: 'gold' },
  CONFLICT: { label: '충돌', color: 'red' },
};

export const SOURCE_META: Record<AppointmentSource, { label: string; color: string }> = {
  NAVER: { label: '네이버', color: 'green' },
  CRM: { label: 'CRM', color: 'blue' },
};

/** 상담 "거래 관심" 선택지 (참고 정보) */
export const CONSULTATION_INTERESTS = [
  '비즈니스 맞춤',
  '웨딩 맞춤',
  '웨딩 렌탈',
  '일반 렌탈',
  '셔츠·액세서리',
  '수선',
];

/** 타임테이블 표시 구간 (문서 03 §4.2: 10:00~20:00) */
export const TIMETABLE_START_HOUR = 10;
export const TIMETABLE_END_HOUR = 20;
