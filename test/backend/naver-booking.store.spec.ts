import { ConfigService } from '@nestjs/config';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  NaverBookingAdapter,
  NaverScrapeResult,
} from '../../backend/src/modules/appointments/adapters/naver-booking.adapter';
import {
  NaverBizItemRaw,
  NaverBookingRaw,
} from '../../backend/src/modules/appointments/adapters/naver-booking.mapper';
import { NaverBookingStore } from '../../backend/src/modules/appointments/adapters/naver-booking.store';
import { NaverFetchWindow } from '../../backend/src/modules/appointments/adapters/naver-reservation.adapter';

/**
 * 요청마다 스크래핑하지 않는다 — 수집본 파일 저장과 재사용 규칙 검증.
 * 실제 브라우저·네이버 접속은 없다 (스크래핑 단계를 호출 횟수만 세는 가짜로 바꾼다).
 */
const fixture: NaverBookingRaw[] = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'naver-bookings.sample.json'), 'utf8'),
);
const bizItemFixture: NaverBizItemRaw[] = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'naver-biz-items.sample.json'), 'utf8'),
);

class CountingAdapter extends NaverBookingAdapter {
  scrapes = 0;
  /** 이 수집이 돌려줄 상품 목록 — 응답을 못 잡은 수집을 시험하려면 빈 배열로 둔다 */
  bizItems: NaverBizItemRaw[] = bizItemFixture;
  protected async scrape(): Promise<NaverScrapeResult> {
    this.scrapes += 1;
    return { bookings: fixture, bizItems: this.bizItems };
  }
}

describe('네이버 수집본 저장·재사용', () => {
  let dir: string;
  const adapterFor = (extra: Record<string, string> = {}) =>
    new CountingAdapter(new ConfigService({ NAVER_BOOKING_DATA_DIR: dir, NAVER_BOOKING_BIZ_ID: '1581427', ...extra }));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'naver-store-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe('저장소', () => {
    it('원본과 파싱 결과를 함께 저장하고, 읽을 때는 원본을 다시 파싱한다', async () => {
      const store = new NaverBookingStore(dir);
      await store.save({ fetchedAt: new Date('2026-09-17T02:32:00Z'), from: '2026-09-15', to: '2026-09-24', raw: fixture });

      const onDisk = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
      expect(onDisk.raw).toHaveLength(fixture.length);
      expect(onDisk.records).toHaveLength(fixture.length); // 사람이 열어 볼 파싱 결과

      // 파싱 규칙이 바뀌어도 다시 수집하지 않고 반영되는지 — 저장된 records 를 망가뜨려도 원본에서 다시 만든다
      writeFileSync(join(dir, 'latest.json'), JSON.stringify({ ...onDisk, records: [] }));
      const loaded = await store.latest();
      expect(loaded!.parsed.records).toHaveLength(fixture.length);
      expect(loaded!.fetchedAt).toBe('2026-09-17T02:32:00.000Z');
    });

    it('상품 목록을 함께 저장하고, 응답을 못 잡은 수집에서는 직전 저장본의 것을 유지한다', async () => {
      const store = new NaverBookingStore(dir);
      const at = { from: '2026-09-15', to: '2026-09-24' };
      await store.save({ fetchedAt: new Date('2026-09-17T02:32:00Z'), ...at, raw: fixture, bizItemsRaw: bizItemFixture });
      const first = await store.latest();
      expect(first!.parsedBizItems.map((i) => i.name)).toContain('렌탈(정장대여)');

      // 다음 수집이 상품 응답을 놓쳐도 화면 선택지가 사라지면 안 된다
      await store.save({ fetchedAt: new Date('2026-09-17T03:32:00Z'), ...at, raw: fixture, bizItemsRaw: [] });
      const second = await store.latest();
      expect(second!.parsedBizItems).toEqual(first!.parsedBizItems);
    });

    it('과거 수집본은 정해진 개수만 남긴다', async () => {
      const store = new NaverBookingStore(dir, 3);
      for (let i = 0; i < 5; i += 1) {
        await store.save({ fetchedAt: new Date(Date.UTC(2026, 8, 17, i)), from: 'a', to: 'b', raw: [] });
      }
      const history = readdirSync(join(dir, 'history')).sort();
      expect(history).toEqual(['2026-09-17T02-00-00.json', '2026-09-17T03-00-00.json', '2026-09-17T04-00-00.json']);
    });

    it('파일이 없거나 깨졌으면 저장본 없음으로 본다', async () => {
      const store = new NaverBookingStore(dir);
      expect(await store.latest()).toBeNull();
      writeFileSync(join(dir, 'latest.json'), '{ 반쯤 쓰인');
      expect(await store.latest()).toBeNull();
    });
  });

  describe('어댑터의 수집 여부 판단', () => {
    it('저장본이 없으면 수집하고 파일로 남긴다', async () => {
      const adapter = adapterFor();
      const result = await adapter.fetchReservations();
      expect(adapter.scrapes).toBe(1);
      expect(result.fromCache).toBe(false);
      expect(result.records).toHaveLength(fixture.length);
      expect(JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')).count).toBe(fixture.length);
    });

    it('최근 저장본이 기간을 덮으면 여러 번 요청해도 다시 수집하지 않는다', async () => {
      const adapter = adapterFor();
      await adapter.fetchReservations(); // 수집 1회
      for (let i = 0; i < 5; i += 1) {
        const again = await adapter.fetchReservations();
        expect(again.fromCache).toBe(true);
        expect(again.records).toHaveLength(fixture.length);
      }
      expect(adapter.scrapes).toBe(1);
    });

    it('저장본보다 넓은 기간을 요청하면 새로 수집한다', async () => {
      const adapter = adapterFor();
      await adapter.fetchReservations(); // 기본 창 (과거 2일~미래 7일)
      const wider: NaverFetchWindow = { lookbackDays: 30, lookaheadDays: 30 };
      expect((await adapter.fetchReservations(wider)).fromCache).toBe(false);
      expect(adapter.scrapes).toBe(2);
      // 넓게 받아 둔 뒤의 좁은 요청은 저장본으로 충분하다
      expect((await adapter.fetchReservations()).fromCache).toBe(true);
      expect(adapter.scrapes).toBe(2);
    });

    it('저장본이 최소 간격보다 오래됐으면 새로 수집한다', async () => {
      const store = new NaverBookingStore(dir);
      await store.save({
        fetchedAt: new Date(Date.now() - 31 * 60_000),
        from: '2000-01-01',
        to: '2100-01-01',
        raw: fixture,
      });
      const adapter = adapterFor({ NAVER_BOOKING_MIN_FETCH_INTERVAL_MIN: '30' });
      expect((await adapter.fetchReservations()).fromCache).toBe(false);
      expect(adapter.scrapes).toBe(1);
    });

    it('명시적 적재(maxAgeMinutes 0)는 저장본이 있어도 새로 수집한다', async () => {
      const adapter = adapterFor();
      await adapter.fetchReservations();
      expect((await adapter.fetchReservations(undefined, { maxAgeMinutes: 0 })).fromCache).toBe(false);
      expect(adapter.scrapes).toBe(2);
    });

    it('상품 목록 조회는 저장본만 읽는다 — 네이버에 접속하지 않는다', async () => {
      const adapter = adapterFor();
      expect(await adapter.fetchBizItems()).toEqual([]); // 저장본 없음
      expect(adapter.scrapes).toBe(0);

      await adapter.fetchReservations(); // 수집 1회 — 상품 목록도 함께 저장된다
      const items = await adapter.fetchBizItems();
      expect(items.map((i) => i.name)).toContain('렌탈(정장대여)');
      expect(adapter.scrapes).toBe(1); // 상품 조회가 수집을 유발하지 않는다
    });

    it('저장본 전용(cacheOnly)은 저장본이 오래됐거나 없어도 절대 수집하지 않는다', async () => {
      const adapter = adapterFor();
      const none = await adapter.fetchReservations(undefined, { cacheOnly: true });
      expect(none).toEqual({ records: [], fetchedAt: undefined, fromCache: true });

      const store = new NaverBookingStore(dir);
      await store.save({ fetchedAt: new Date(Date.now() - 24 * 3_600_000), from: 'x', to: 'y', raw: fixture });
      const old = await adapter.fetchReservations(undefined, { cacheOnly: true });
      expect(old.records).toHaveLength(fixture.length);
      expect(adapter.scrapes).toBe(0);
    });
  });
});
