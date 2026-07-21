/** 결제 화면 공용 표시 포맷 */
export const krw = (n: number | null | undefined) =>
  n === null || n === undefined || Number.isNaN(Number(n)) ? '-' : `${Number(n).toLocaleString('ko-KR')}원`;
