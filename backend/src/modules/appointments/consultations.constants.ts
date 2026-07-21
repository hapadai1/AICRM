/**
 * 초도 상담 항목 상수 (개발설계서 05 G-01).
 * 설계 PDF 1페이지 "방문 목적 파악 (용도, 예산, 희망 스타일, 납기 확인)" 대응.
 * DB enum 대신 varchar + 상수 배열로 관리한다 (구현표준 1.2).
 */

/** 용도 — 진행 단계 trackType과 1:1 대응한다 (CUSTOM / RENTAL). */
export const USAGE_TYPES = ['BUSINESS_CUSTOM', 'WEDDING_RENTAL'] as const;
export type UsageType = (typeof USAGE_TYPES)[number];

export const USAGE_TYPE_NAMES: Record<UsageType, string> = {
  BUSINESS_CUSTOM: '비즈니스 맞춤',
  WEDDING_RENTAL: '웨딩패키지 렌탈',
};

export function usageTypeName(code: string | null): string | null {
  return code ? (USAGE_TYPE_NAMES[code as UsageType] ?? code) : null;
}
