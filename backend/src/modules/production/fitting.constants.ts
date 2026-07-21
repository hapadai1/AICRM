/**
 * 가봉 표준 확인 항목 (개발설계서 05 G-04).
 * 설계 PDF 1페이지 가봉 단계의 "실루엣·균형·여유분·길이 확인" 대응.
 * DB enum 대신 varchar + 상수 배열로 관리한다 (구현표준 1.2).
 */
export const FITTING_AREA_CODES = ['SILHOUETTE', 'BALANCE', 'EASE', 'LENGTH', 'ETC'] as const;
export type FittingAreaCode = (typeof FITTING_AREA_CODES)[number];

export const FITTING_AREA_NAMES: Record<FittingAreaCode, string> = {
  SILHOUETTE: '실루엣',
  BALANCE: '균형',
  EASE: '여유분',
  LENGTH: '길이',
  ETC: '기타',
};

/** 커버리지 판정 대상 — 기타는 표준 항목이 아니므로 제외한다. */
export const FITTING_STANDARD_AREAS = ['SILHOUETTE', 'BALANCE', 'EASE', 'LENGTH'] as const;

export function fittingAreaName(code: string): string {
  return FITTING_AREA_NAMES[code as FittingAreaCode] ?? code;
}

/**
 * 4대 표준 항목의 기재 여부.
 * 미기재를 막지는 않고 화면에서 경고만 띄운다 — 현장 유연성을 우선한다.
 */
export function fittingCoverage(
  adjustments: Array<{ areaCode: string }>,
): Record<string, boolean> {
  const written = new Set(adjustments.map((a) => a.areaCode));
  return Object.fromEntries(FITTING_STANDARD_AREAS.map((code) => [code, written.has(code)]));
}
