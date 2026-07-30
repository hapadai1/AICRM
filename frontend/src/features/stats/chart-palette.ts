/**
 * 차트 색·눈금 규격 (STAT-001).
 *
 * 화면 색은 theme.ts가 단일 출처지만, 차트 계열색은 성격이 다르다 — 서로 구분되는 것이
 * 유일한 목적이고, 색맹(적록·청황) 조건에서도 인접 계열이 구분되어야 한다.
 * 아래 8색은 그 조건을 검증한 순서다(OKLab 인접쌍 ΔE ≥ 8, 정상시력 ΔE ≥ 15,
 * 카드 배경 #ffffff 기준). 순서 자체가 안전장치이므로 임의로 섞지 않는다.
 *
 * 8색 중 아쿠아·옐로·마젠타는 흰 배경 대비가 3:1 미만이라 색 하나로 뜻을 전달하면 안 된다.
 * 그래서 모든 차트에 범례와 [표] 보기를 함께 둔다(색 없이도 값을 읽을 수 있는 경로).
 */
export const CHART_SERIES_COLORS = [
  '#2a78d6', // 1 blue
  '#eb6834', // 2 orange
  '#1baf7a', // 3 aqua
  '#eda100', // 4 yellow
  '#e87ba4', // 5 magenta
  '#008300', // 6 green
  '#4a3aa7', // 7 violet
  '#e34948', // 8 red
] as const;

/** '기타' 묶음 색 — 계열이 아니라 잔여분이므로 무채색으로 뒤로 물린다. */
export const CHART_OTHER_COLOR = '#8c8c8c';

/** 눈금·축·격자 등 차트 크롬 */
export const CHART_CHROME = {
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  axisLabel: '#898781',
  tooltipBorder: 'rgba(11,11,11,0.10)',
} as const;

/** colorIndex(-1은 기타)를 실제 색으로. 8을 넘는 슬롯은 서버가 '기타'로 접으므로 오지 않는다. */
export function seriesColor(colorIndex: number): string {
  if (colorIndex < 0) return CHART_OTHER_COLOR;
  return CHART_SERIES_COLORS[colorIndex % CHART_SERIES_COLORS.length];
}
