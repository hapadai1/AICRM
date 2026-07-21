/**
 * 백엔드 응답 → 화면 뷰 변환 공용 유틸.
 *
 * 백엔드는 Prisma raw row를 그대로 내보낸다(뷰 계층이 예약 모듈에만 있다).
 * 그래서 `api/*.ts`가 아래 3가지를 일관되게 흡수한다 — 2차 정합화 계획(docs/dev/08) §2.1.
 *
 * 1. `@db.Date` / `Timestamptz` → ISO 문자열로 온다. 화면은 `YYYY-MM-DD`를 쓴다.
 * 2. `Decimal` → JSON에서 문자열(`"750000"`)로 온다. 그대로 계산하면 문자열 연결·NaN이 된다.
 * 3. 중첩 관계(`order.contract.customer.name`)를 화면용 평면 필드로 편다.
 */

/** ISO 일시 → `YYYY-MM-DD`. 값이 없으면 undefined. */
export function toDateOnly(value?: string | Date | null): string | undefined {
  if (!value) return undefined;
  return (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
}

/** ISO 일시 → `YYYY-MM-DD HH:mm`. 값이 없으면 undefined. */
export function toDateTime(value?: string | Date | null): string | undefined {
  if (!value) return undefined;
  const iso = value instanceof Date ? value.toISOString() : String(value);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Decimal 문자열·숫자 → number. 값이 없거나 숫자가 아니면 undefined. */
export function toNumber(value?: string | number | null): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isNaN(n) ? undefined : n;
}

/** Decimal 문자열·숫자 → number. 값이 없으면 0 (합계 계산용). */
export function toAmount(value?: string | number | null): number {
  return toNumber(value) ?? 0;
}

/** 원화 표기. 문자열 Decimal도 안전하게 처리한다. */
export function formatKrw(value?: string | number | null): string {
  const n = toNumber(value);
  return n === undefined ? '-' : `${n.toLocaleString('ko-KR')}원`;
}
