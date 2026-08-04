/**
 * 채촌 기록 이름표 (현업 확정 2026-08-01).
 * 채촌은 버전 관리를 하지 않는다 — 기록은 "구분 + 채촌일"로 알아본다.
 * 같은 구분이 여러 건이면 오래된 것부터 회차를 붙인다: 가봉 1회차 · 가봉 2회차.
 */
import { MEASUREMENT_TYPE_LABELS } from '../../api/measurements';
import { labelOf } from '../../shared/status-meta';

export interface RecordTitleSource {
  measurementType: string;
  measurementDate: string;
  /** 같은 날 여러 건일 때의 저장 순서 (화면에는 노출하지 않는 내부 일련번호) */
  versionNo: number;
}

/**
 * 입력 배열과 같은 순서로 이름표를 돌려준다 (index 대응).
 * 같은 구분이 하나뿐이면 회차를 붙이지 않는다.
 */
export function buildRecordTitles(records: RecordTitleSource[]): string[] {
  const totals = new Map<string, number>();
  records.forEach((r) => totals.set(r.measurementType, (totals.get(r.measurementType) ?? 0) + 1));

  const oldestFirst = records
    .map((r, index) => ({ r, index }))
    .sort((a, b) =>
      a.r.measurementDate === b.r.measurementDate
        ? a.r.versionNo - b.r.versionNo
        : a.r.measurementDate < b.r.measurementDate
          ? -1
          : 1,
    );

  const seen = new Map<string, number>();
  const titles = new Array<string>(records.length).fill('');
  oldestFirst.forEach(({ r, index }) => {
    const nth = (seen.get(r.measurementType) ?? 0) + 1;
    seen.set(r.measurementType, nth);
    const type = labelOf(MEASUREMENT_TYPE_LABELS, r.measurementType);
    titles[index] = (totals.get(r.measurementType) ?? 0) > 1 ? `${type} ${nth}회차` : type;
  });
  return titles;
}

/** 한 건짜리 이름표 — 같은 고객의 기록 목록을 함께 넘겨야 회차가 맞는다. */
export function recordTitleOf(records: RecordTitleSource[], index: number): string {
  return buildRecordTitles(records)[index] ?? '';
}

/** 셀렉트·비교 화면용 한 줄 표기: "가봉 2회차 · 2026-07-28" */
export function recordLabel(title: string, measurementDate: string): string {
  return `${title} · ${measurementDate}`;
}
