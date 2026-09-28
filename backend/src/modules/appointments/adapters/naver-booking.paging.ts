/**
 * 네이버 예약 목록 조회 범위·페이지 계산 (순수 함수).
 *
 * 파트너센터 목록 API 는 한 번에 최대 31일(maxDays=31)만 조회하고, 결과를 50건씩(page/size) 나눠 준다.
 * 그대로 한 번만 부르면 넓은 기간은 잘리고 50건 넘는 예약은 누락되므로
 * 기간을 쪼개고 페이지를 끝까지 넘긴다.
 */

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 3_600_000;

/** 한 번에 조회할 최대 일수 — API 상한(31)보다 하루 여유를 둔다 */
export const MAX_SPAN_DAYS = 30;

export interface DateChunk {
  /** 한국 날짜 YYYY-MM-DD (포함) */
  from: string;
  /** 한국 날짜 YYYY-MM-DD (포함) */
  to: string;
}

/** 시각 → 한국 날짜 문자열 */
export function kstDate(at: Date): string {
  return new Date(at.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * [from, to] 한국 날짜 구간을 최대 maxSpan 일 조각으로 나눈다.
 * 경계일 누락이 없도록 조각끼리 하루씩 겹치게 한다 (중복은 예약번호로 걸러낸다).
 */
export function splitDateRange(from: string, to: string, maxSpan = MAX_SPAN_DAYS): DateChunk[] {
  if (from > to) return [];
  const chunks: DateChunk[] = [];
  let start = from;
  for (;;) {
    const end = addDays(start, maxSpan - 1);
    if (end >= to) {
      chunks.push({ from: start, to });
      return chunks;
    }
    chunks.push({ from: start, to: end });
    start = end; // 하루 겹침
  }
}

/**
 * 화면이 실제로 부른 목록 URL 을 본떠 특정 기간·페이지 URL 을 만든다.
 * 화면이 붙이는 나머지 파라미터(업종·정렬 등)는 그대로 둔다.
 * 기간은 화면과 같은 방식(한국 자정의 UTC 시각)으로 넣고, 끝 날짜를 포함하도록 다음날 자정까지로 잡는다.
 */
export function buildListPageUrl(templateUrl: string, chunk: DateChunk, page: number, size: number): string {
  const url = new URL(templateUrl);
  const kstMidnight = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00+09:00`)).toISOString();
  url.searchParams.set('startDateTime', kstMidnight(chunk.from));
  url.searchParams.set('endDateTime', kstMidnight(addDays(chunk.to, 1)));
  url.searchParams.set('page', String(page));
  url.searchParams.set('size', String(size));
  return url.toString();
}

/** 템플릿 URL 의 페이지 크기 (없으면 50) */
export function pageSizeOf(templateUrl: string): number {
  const size = Number(new URL(templateUrl).searchParams.get('size'));
  return Number.isFinite(size) && size > 0 ? size : 50;
}

/**
 * 화면 요청 헤더 중 브라우저 fetch 로 그대로 다시 보낼 수 있는 것만 남긴다.
 * 쿠키·UA·sec-* 같은 헤더는 브라우저가 알아서 붙이고, 직접 넣으면 오히려 거부된다.
 * if-none-match 같은 캐시 확인 헤더를 따라 보내면 본문 없는 304 가 돌아온다.
 */
export function replayableHeaders(headers: Record<string, string>): Record<string, string> {
  const blocked =
    /^(:|sec-|if-|cookie$|user-agent$|referer$|host$|origin$|connection$|content-length$|accept-encoding$)/i;
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !blocked.test(k)));
}
