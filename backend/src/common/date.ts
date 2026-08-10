/**
 * 날짜 헬퍼 단일 출처 (2026-08-05).
 *
 * 전에는 toDate·today·toDateString류가 8개 모듈에 각각 복제돼 있었고, "오늘"의 기준이
 * 로컬 달력(dashboard)과 UTC 달력(rentals·production·repairs)으로 갈려 있었다 —
 * KST 자정~오전 9시 사이에는 두 기준의 날짜가 달라, 반납 예정·입고 지연 판정이
 * 모듈마다 어긋날 수 있었다(stats.service의 하루 밀림 주석과 같은 뿌리).
 *
 * 기준을 하나로 정한다:
 * - **@db.Date 컬럼 값은 UTC 자정 Date다.** 저장·비교는 parseDateOnly, 표기는 toDateOnlyString.
 * - **업무의 '오늘'은 매장(로컬) 달력이다.** todayDateOnly / todayAsDbDate.
 */

export const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' → UTC 자정 Date (@db.Date 컬럼 저장·비교용) */
export function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Date → 'YYYY-MM-DD'. @db.Date 값은 UTC 자정이므로 UTC 기준으로 자른다. */
export function toDateOnlyString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** 표기용 — 값이 없으면 null 유지. */
export function toDateOnlyStringOrNull(value: Date | null | undefined): string | null {
  return value ? toDateOnlyString(value) : null;
}

/** 로컬 달력 기준 오늘 'YYYY-MM-DD' — 업무의 '오늘'은 매장 달력을 따른다. */
export function todayDateOnly(): string {
  const now = new Date();
  return [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/** 로컬 달력 기준 오늘의 UTC 자정 Date (@db.Date 비교·이벤트 일자용) */
export function todayAsDbDate(): Date {
  return parseDateOnly(todayDateOnly());
}

/** 'YYYY-MM-DD' + n일 → 'YYYY-MM-DD'. 날짜가 UTC 자정이라 시간대 보정이 필요 없다. */
export function addDaysToDateOnly(value: string, days: number): string {
  const date = parseDateOnly(value);
  date.setUTCDate(date.getUTCDate() + days);
  return toDateOnlyString(date);
}

/** ISO·'YYYY-MM-DD' 문자열 → Date. 값이 없으면 undefined. */
export function toDateOrUndefined(value?: string): Date | undefined {
  return value ? new Date(value) : undefined;
}

/** ISO·'YYYY-MM-DD' 문자열 → Date. 값이 없으면 null. */
export function toDateOrNull(value?: string | null): Date | null {
  return value ? new Date(value) : null;
}
