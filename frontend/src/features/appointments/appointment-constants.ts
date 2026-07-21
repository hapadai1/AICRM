import type {
  AppointmentSource,
  AppointmentStatus,
  AppointmentSyncStatus,
} from '../../api/appointments';

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
