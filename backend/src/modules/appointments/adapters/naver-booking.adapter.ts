import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { chromium, BrowserContext, Page } from 'playwright-core';
import { join } from 'path';
import { mapNaverBookings, NaverBizItemRaw, NaverBookingRaw } from './naver-booking.mapper';
import {
  buildListPageUrl,
  kstDate,
  pageSizeOf,
  replayableHeaders,
  splitDateRange,
} from './naver-booking.paging';
import { NaverBookingStore } from './naver-booking.store';
import { loginToNaver } from './naver-login';
import {
  NaverBizItem,
  NaverFetchOptions,
  NaverFetchResult,
  NaverFetchWindow,
  NaverReservationAdapter,
} from './naver-reservation.adapter';

/** 한 번의 파트너센터 접속으로 받아 오는 것 — 예약 원본과 예약 상품(메뉴) 마스터. */
export interface NaverScrapeResult {
  bookings: NaverBookingRaw[];
  /** 상품 목록 응답을 못 잡았으면 빈 배열 (저장소가 직전 저장본의 값을 유지한다) */
  bizItems: NaverBizItemRaw[];
}

/**
 * 네이버 예약 파트너센터 수집 어댑터 (설계서 16.1 — 네이버 → CRM 단방향).
 *
 * 네이버는 개별 사업자용 공개 API를 제공하지 않아(승인된 솔루션 벤더 제휴만 존재)
 * 파트너센터 화면을 여는 방식으로 수집한다. 화면 HTML을 긁는 대신, 화면이 스스로 호출하는
 * 예약 목록 JSON 응답을 가로채 쓴다 — 화면 개편에 덜 취약하고 파싱이 정확하다.
 *
 * 중요 — 읽기 전용: 이 어댑터는 목록 화면 이동(GET) 외에 어떤 조작도 하지 않는다.
 * 예약 확정·취소·수정 요청은 코드에 존재하지 않는다 (네이버는 운영 데이터).
 *
 * 로그인: 저장된 브라우저 프로필 세션을 재사용한다. 세션이 끊겼을 때만 자동 로그인을 1회 시도하고,
 * 캡차 등 사람이 풀어야 하는 화면이 뜨면 멈추고 알린다 (ops/naver-recon/README.md).
 *
 * 요청마다 스크래핑하지 않는다: 수집 결과는 파일(docs/naver-booking)로 저장하고, 저장본이 충분히 최근이며
 * 요청한 기간을 덮으면 그것을 돌려준다. 네이버 접속은 저장본이 없거나 오래됐거나 기간이 모자랄 때만 한다.
 */
@Injectable()
export class NaverBookingAdapter implements NaverReservationAdapter {
  private readonly logger = new Logger(NaverBookingAdapter.name);
  /**
   * 수집은 한 번에 하나씩. 같은 크롬 프로필은 동시에 두 번 열 수 없어서, 주기 수집 중에
   * "네이버 동기화" 버튼을 누르면 실패한다 — 앞선 수집이 끝나길 기다렸다가 이어서 돈다.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: ConfigService) {}

  private get bizId(): string {
    return this.config.get<string>('NAVER_BOOKING_BIZ_ID') ?? '';
  }

  /** 사람이 로그인해 둔 크롬 프로필 경로 (기본: ops/naver-recon/.profile) */
  private get profileDir(): string {
    return (
      this.config.get<string>('NAVER_BOOKING_PROFILE_DIR') ??
      join(process.cwd(), '..', 'ops', 'naver-recon', '.profile')
    );
  }

  /** 수집본 저장소 (기본: 저장소 루트 docs/naver-booking — 커밋 제외) */
  private get store(): NaverBookingStore {
    return new NaverBookingStore(
      this.config.get<string>('NAVER_BOOKING_DATA_DIR') ?? join(process.cwd(), '..', 'docs', 'naver-booking'),
    );
  }

  /** 조회 창: 과거 N일(취소·변경 반영) ~ 미래 M일. 호출부가 넘기면 그 값을 쓴다(첫 적재 등). */
  private range(window?: NaverFetchWindow): { start: Date; end: Date } {
    const back = window?.lookbackDays ?? Number(this.config.get('NAVER_BOOKING_LOOKBACK_DAYS') ?? 7);
    const ahead = window?.lookaheadDays ?? Number(this.config.get('NAVER_BOOKING_LOOKAHEAD_DAYS') ?? 45);
    const now = Date.now();
    return { start: new Date(now - back * 86_400_000), end: new Date(now + ahead * 86_400_000) };
  }

  /**
   * 실제로 쓸 조회 창 — 수집이 멈춘 동안 생긴 예약을 영구히 잃지 않도록 과거 일수를 자동으로 늘린다.
   *
   * 어떤 날짜의 예약은 그 날 당일까지 계속 늘어난다(실측: 이용일 1일 전 60%, 3~4일 전 32%,
   * 5~7일 전 17%만 들어와 있다). 그래서 미리 긁어 둔 값은 언제나 덜 찬 상태이고, 그 날짜를
   * **이용일 당일 또는 그 이후에 한 번 더** 긁어야 비로소 채워진다.
   * 과거 조회 일수가 수집 공백보다 짧으면 그 사이 날짜는 덜 찬 채로 영구히 고정된다
   * (서버가 꺼져 있던 2026-10-01~04 가 실제로 그렇게 굳었다).
   *
   * 그래서 "마지막 수집 이후 지난 날수 + 하루" 만큼은 반드시 다시 본다. 상한을 두어
   * 오래 멈췄다 켠 뒤 과거 전체를 긁지는 않는다(그건 scripts/naver-sync.ts 의 몫).
   */
  private effectiveWindow(window: NaverFetchWindow | undefined, lastFetchedAt?: string): NaverFetchWindow | undefined {
    if (window) return window; // 호출부가 명시한 창은 그대로 쓴다 (기간 지정 적재·첫 적재)
    if (!lastFetchedAt) return undefined;
    const back = Number(this.config.get('NAVER_BOOKING_LOOKBACK_DAYS') ?? 7);
    const ahead = Number(this.config.get('NAVER_BOOKING_LOOKAHEAD_DAYS') ?? 45);
    const maxBack = Number(this.config.get('NAVER_BOOKING_MAX_LOOKBACK_DAYS') ?? 45);
    // 마지막 수집 날짜 자체도 다시 봐야 한다 (그날 수집 이후 들어온 예약이 있다) — 그래서 +1
    const gapDays = Math.floor((Date.now() - Date.parse(lastFetchedAt)) / 86_400_000) + 1;
    const lookbackDays = Math.min(maxBack, Math.max(back, Number.isFinite(gapDays) ? gapDays : back));
    if (lookbackDays > back) {
      this.logger.warn(`수집 공백 — 과거 조회를 ${back}일에서 ${lookbackDays}일로 늘린다`);
    }
    return { lookbackDays, lookaheadDays: ahead };
  }

  private listUrl(window?: NaverFetchWindow): string {
    const { start, end } = this.range(window);
    return (
      `https://partner.booking.naver.com/bizes/${this.bizId}/booking-list-view` +
      `?dateDropdownType=WEEK&startDateTime=${kstDate(start)}&endDateTime=${kstDate(end)}&dateFilter=USEDATE`
    );
  }

  fetchReservations(window?: NaverFetchWindow, options: NaverFetchOptions = {}): Promise<NaverFetchResult> {
    // 앞선 수집이 막 끝나 저장본이 갱신됐을 수 있으므로, 순서를 기다린 뒤 저장본 판단을 한다
    const run = this.queue.then(() => this.fetchOrReuse(window, options));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * 예약 상품(메뉴) 목록 — 저장본만 읽는다. 이 호출로 네이버에 접속하지 않는다.
   * 상품 목록은 예약 목록 화면이 스스로 함께 호출하므로 예약 수집 때 같이 저장해 둔다.
   */
  async fetchBizItems(): Promise<NaverBizItem[]> {
    return (await this.store.latest())?.parsedBizItems ?? [];
  }

  private async fetchOrReuse(window: NaverFetchWindow | undefined, options: NaverFetchOptions): Promise<NaverFetchResult> {
    const saved = await this.store.latest();

    if (options.cacheOnly) {
      return { records: saved?.parsed.records ?? [], fetchedAt: saved?.fetchedAt, fromCache: true };
    }

    // 수집 공백만큼 과거를 더 본다 — 저장본을 읽은 뒤에야 알 수 있어 여기서 창을 확정한다
    const effective = this.effectiveWindow(window, saved?.fetchedAt);
    const { start, end } = this.range(effective);
    const want = { from: kstDate(start), to: kstDate(end) };

    const maxAge = options.maxAgeMinutes ?? Number(this.config.get('NAVER_BOOKING_MIN_FETCH_INTERVAL_MIN') ?? 30);
    if (saved && maxAge > 0) {
      const ageMinutes = (Date.now() - Date.parse(saved.fetchedAt)) / 60_000;
      const covers = saved.from <= want.from && saved.to >= want.to;
      if (ageMinutes < maxAge && covers) {
        this.logger.log(
          `저장본 사용 — ${Math.round(ageMinutes)}분 전 수집분(${saved.from}~${saved.to}), 네이버에 접속하지 않음`,
        );
        return { records: saved.parsed.records, fetchedAt: saved.fetchedAt, fromCache: true };
      }
    }

    if (!this.bizId) {
      this.logger.warn('NAVER_BOOKING_BIZ_ID 가 없어 네이버 예약 수집을 건너뛴다');
      return { records: [], fromCache: false };
    }

    const fetchedAt = new Date();
    const { bookings: raw, bizItems } = await this.scrape(effective);
    const stored = await this.store.save({ fetchedAt, ...want, raw, bizItemsRaw: bizItems }).catch((e) => {
      // 저장 실패로 이번 수집까지 버리지는 않는다 — 다음 요청이 다시 수집하게 될 뿐이다
      this.logger.warn(`수집본 저장 실패: ${e instanceof Error ? e.message : e}`);
      return null;
    });
    const { records, unmappedBizItems, unknownStatusCodes, skipped } = stored ?? mapNaverBookings(raw);
    if (!bizItems.length) {
      this.logger.warn('예약 상품(메뉴) 목록 응답을 잡지 못했다 — 직전 저장본의 상품 목록을 유지한다');
    }
    if (unmappedBizItems.length) {
      this.logger.warn(`목적 매핑 규칙에 없는 네이버 메뉴: ${unmappedBizItems.join(', ')} — 기본 목적으로 수집했다`);
    }
    if (unknownStatusCodes?.length) {
      this.logger.warn(
        `상태 매핑 규칙에 없는 네이버 상태 코드: ${unknownStatusCodes.join(', ')} — 예약 대기로 수집했다`,
      );
    }
    if (skipped.length) this.logger.warn(`건너뛴 예약 ${skipped.length}건: ${JSON.stringify(skipped)}`);
    this.logger.log(`네이버 예약 ${records.length}건 수집 (원본 ${raw.length}건, ${want.from}~${want.to})`);
    return { records, fetchedAt: fetchedAt.toISOString(), fromCache: false };
  }

  /**
   * 파트너센터에 접속해 조회 기간의 예약 원본과 예약 상품 목록을 받아 온다 (조회만).
   * 테스트에서 바꿔 끼울 수 있게 protected.
   */
  protected async scrape(window?: NaverFetchWindow): Promise<NaverScrapeResult> {
    let context: BrowserContext | undefined;
    try {
      context = await chromium.launchPersistentContext(this.profileDir, {
        channel: 'chrome',
        headless: this.config.get('NAVER_BOOKING_HEADLESS') !== 'false',
        chromiumSandbox: true,
        locale: 'ko-KR',
        timezoneId: 'Asia/Seoul',
        args: ['--disable-blink-features=AutomationControlled'],
      });
      const page = context.pages()[0] ?? (await context.newPage());

      // 화면이 부르는 예약 목록 요청을 잡아 "본보기"로 쓴다 — 예약 객체 배열인 JSON 응답만
      // (같은 경로에 count·quick-search 같은 다른 응답도 오간다)
      let captured: NaverBookingRaw[] | undefined;
      let capturedUrl = '';
      let capturedHeaders: Record<string, string> = {};
      // 같은 화면이 상품(메뉴) 목록도 스스로 불러온다 — 추가 요청 없이 그 응답을 함께 챙긴다.
      // 예약이 0건인 상품(렌탈처럼 드문 메뉴)도 화면 선택지에 띄우기 위해 필요하다.
      let capturedBizItems: NaverBizItemRaw[] | undefined;
      context.on('response', async (resp) => {
        try {
          const url = resp.url();
          const ct = resp.headers()['content-type'] ?? '';
          if (!ct.includes('json')) return;
          if (!capturedBizItems && url.includes('/biz-items')) {
            const body = JSON.parse(await resp.text());
            if (Array.isArray(body) && body.every((b) => b && typeof b === 'object' && 'bizItemId' in b && 'name' in b)) {
              capturedBizItems = body as NaverBizItemRaw[];
            }
            return;
          }
          if (captured || !url.includes('/bookings')) return;
          const body = JSON.parse(await resp.text());
          if (Array.isArray(body) && body.every((b) => b && typeof b === 'object' && 'bookingId' in b)) {
            captured = body as NaverBookingRaw[];
            capturedUrl = url;
            capturedHeaders = await resp.request().allHeaders();
          }
        } catch {
          // 파싱 불가 응답은 무시 — 목록 응답이 아니다
        }
      });

      await page.goto(this.listUrl(window), { waitUntil: 'domcontentloaded', timeout: 60_000 });

      // 세션이 끊겼으면 자동 로그인 1회 — 캡차 등 추가 확인이 뜨면 그대로 중단된다.
      // (성공하면 목적지로 돌아오지만, 확실히 하려고 목록을 한 번 더 연다)
      if (/nid\.naver\.com/.test(page.url())) {
        await loginToNaver(
          page,
          {
            id: this.config.get<string>('NAVER_BOOKING_ID') ?? '',
            pw: this.config.get<string>('NAVER_BOOKING_PW') ?? '',
          },
          this.logger,
        );
        if (!page.url().includes('booking-list-view')) {
          await page.goto(this.listUrl(window), { waitUntil: 'domcontentloaded', timeout: 60_000 });
        }
      }

      // SPA 가 목록을 불러올 때까지 대기 (사람이 화면을 보는 정도의 시간)
      const deadline = Date.now() + 30_000;
      while (!captured && Date.now() < deadline) {
        if (/nid\.naver\.com/.test(page.url())) {
          throw new Error('로그인 후에도 예약 목록에 접근하지 못했다 — 수집을 중단한다');
        }
        await page.waitForTimeout(1000);
      }
      if (!captured) throw new Error('예약 목록 응답을 받지 못했다 (화면 구조 변경 가능성)');
      this.logger.debug(`예약 목록 본보기 URL: ${capturedUrl}`);

      const bookings = await this.fetchAllPages(page, capturedUrl, capturedHeaders, window);
      return { bookings, bizItems: capturedBizItems ?? [] };
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  /**
   * 조회 기간 전체를 빠짐없이 가져온다. 목록 API 는 31일·50건 단위로 끊어 주므로
   * 기간을 30일 조각으로 나누고, 조각마다 마지막 페이지까지 넘긴다.
   *
   * 요청은 로그인된 화면 안에서 화면과 같은 주소·헤더로 보낸다 (조회 GET 만).
   * 요청 사이에는 사람이 목록을 넘기는 정도의 간격을 둔다.
   */
  private async fetchAllPages(
    page: Page,
    templateUrl: string,
    templateHeaders: Record<string, string>,
    window?: NaverFetchWindow,
  ): Promise<NaverBookingRaw[]> {
    const { start, end } = this.range(window);
    const size = pageSizeOf(templateUrl);
    const headers = replayableHeaders(templateHeaders);
    const byId = new Map<number, NaverBookingRaw>();
    const MAX_PAGES_PER_CHUNK = 40; // 조각당 2,000건 — 넘으면 무한 반복을 의심한다

    for (const chunk of splitDateRange(kstDate(start), kstDate(end))) {
      for (let pageNo = 0; ; pageNo += 1) {
        if (pageNo >= MAX_PAGES_PER_CHUNK) {
          throw new Error(`예약 목록 페이지가 비정상적으로 많다 (${chunk.from}~${chunk.to})`);
        }
        await page.waitForTimeout(800 + Math.random() * 1700);
        const url = buildListPageUrl(templateUrl, chunk, pageNo, size);
        const rows = await page.evaluate(
          async ({ url, headers }) => {
            // 브라우저 안에서 실행된다 — cache 옵션은 Node 타입 정의에 없어 형 변환한다
            const init = { credentials: 'include', headers, cache: 'no-store' } as RequestInit;
            const res = await fetch(url, init);
            if (!res.ok) return { error: res.status };
            return { data: await res.json() };
          },
          { url, headers },
        );
        if ('error' in rows) {
          throw new Error(`예약 목록 조회 실패 HTTP ${rows.error} (${chunk.from}~${chunk.to}, ${pageNo}쪽)`);
        }
        if (!Array.isArray(rows.data)) throw new Error('예약 목록 응답 형식이 바뀌었다 (배열 아님)');

        for (const b of rows.data as NaverBookingRaw[]) byId.set(b.bookingId, b);
        if (rows.data.length < size) break;
      }
    }
    return [...byId.values()];
  }
}
