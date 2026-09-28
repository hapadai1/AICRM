import {
  buildListPageUrl,
  kstDate,
  pageSizeOf,
  replayableHeaders,
  splitDateRange,
} from '../../backend/src/modules/appointments/adapters/naver-booking.paging';

/**
 * 네이버 목록 API 는 한 번에 31일·50건까지만 준다 — 기간 분할·페이지 URL 계산 검증.
 * 실제 화면이 부른 URL 을 본보기로 쓴다 (2026-09-17 캡처).
 */
const TEMPLATE =
  'https://partner.booking.naver.com/api/businesses/1581427/bookings?bizItemTypes=STANDARD&bookingStatusCodes=' +
  '&businessTypeId=13&dateDropdownType=WEEK&dateFilter=USEDATE&endDateTime=2026-09-23T15%3A00%3A00.000Z' +
  '&maxDays=31&nPayChargedStatusCodes=&orderBy=&orderByStartDate=ASC&paymentStatusCodes=&searchValue=' +
  '&startDateTime=2026-09-14T15%3A00%3A00.000Z&page=0&size=50';

describe('네이버 예약 목록 기간 분할·페이지', () => {
  it('30일 이내 기간은 한 조각으로 조회한다', () => {
    expect(splitDateRange('2026-09-15', '2026-09-24')).toEqual([{ from: '2026-09-15', to: '2026-09-24' }]);
  });

  it('긴 기간(첫 적재 61일)은 30일 조각으로 나누고 경계일을 겹쳐 빠짐이 없게 한다', () => {
    const chunks = splitDateRange('2026-08-18', '2026-10-17');
    expect(chunks).toEqual([
      { from: '2026-08-18', to: '2026-09-16' },
      { from: '2026-09-16', to: '2026-10-15' },
      { from: '2026-10-15', to: '2026-10-17' },
    ]);
    // 조각마다 API 상한 31일을 넘지 않는다
    for (const c of chunks) {
      const days = (Date.parse(c.to) - Date.parse(c.from)) / 86_400_000 + 1;
      expect(days).toBeLessThanOrEqual(30);
    }
  });

  it('조각 URL 은 화면과 같은 형식(한국 자정의 UTC)으로 기간·페이지만 바꾼다', () => {
    const url = new URL(buildListPageUrl(TEMPLATE, { from: '2026-09-15', to: '2026-09-24' }, 2, 50));
    expect(url.searchParams.get('startDateTime')).toBe('2026-09-14T15:00:00.000Z');
    // 끝 날짜를 포함하도록 다음날 한국 자정까지
    expect(url.searchParams.get('endDateTime')).toBe('2026-09-24T15:00:00.000Z');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('size')).toBe('50');
    // 화면이 붙인 나머지 조건은 그대로
    expect(url.searchParams.get('businessTypeId')).toBe('13');
    expect(url.searchParams.get('dateFilter')).toBe('USEDATE');
    expect(url.searchParams.get('orderByStartDate')).toBe('ASC');
  });

  it('페이지 크기는 화면 요청을 따른다', () => {
    expect(pageSizeOf(TEMPLATE)).toBe(50);
    expect(pageSizeOf('https://x.naver.com/api?page=0')).toBe(50);
  });

  it('한국 날짜는 UTC 자정 전후를 올바르게 넘긴다', () => {
    expect(kstDate(new Date('2026-09-16T14:59:59Z'))).toBe('2026-09-16');
    expect(kstDate(new Date('2026-09-16T15:00:00Z'))).toBe('2026-09-17');
  });

  it('브라우저가 직접 붙이는 헤더는 다시 보내지 않는다', () => {
    expect(
      replayableHeaders({
        accept: 'application/json',
        'x-booking-naver-role': 'OWNER',
        cookie: 'NID_SES=secret',
        'user-agent': 'Chrome',
        'sec-ch-ua': '"Chromium"',
        referer: 'https://partner.booking.naver.com/',
        ':authority': 'partner.booking.naver.com',
        // 따라 보내면 본문 없는 304 가 온다 (실제로 겪음)
        'if-none-match': 'W/"abc"',
        'if-modified-since': 'Thu, 17 Sep 2026 01:00:00 GMT',
      }),
    ).toEqual({ accept: 'application/json', 'x-booking-naver-role': 'OWNER' });
  });
});
