import { readFileSync } from 'fs';
import { join } from 'path';
import {
  FALLBACK_PURPOSE_CODE,
  mapNaverBizItems,
  mapNaverBookings,
  NaverBizItemRaw,
  NaverBookingRaw,
  resolvePurposeCode,
} from '../../backend/src/modules/appointments/adapters/naver-booking.mapper';

/**
 * 네이버 예약 파싱 검증 — 실제 파트너센터 응답을 캡처해 개인정보만 가명화한 픽스처로 돌린다.
 * 네이버에 접속하지 않으므로 얼마든지 반복 실행해도 안전하다 (수집 차단 위험 회피).
 * 캡처 방법은 ops/naver-recon/recon.mjs 참고.
 */
const fixture: NaverBookingRaw[] = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'naver-bookings.sample.json'), 'utf8'),
);
const bizItemFixture: NaverBizItemRaw[] = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'naver-biz-items.sample.json'), 'utf8'),
);

describe('네이버 예약 파싱 (설계서 16.1 수집 매핑)', () => {
  it('픽스처의 모든 예약을 건너뛰지 않고 변환한다', () => {
    const { records, skipped } = mapNaverBookings(fixture);
    expect(skipped).toEqual([]);
    expect(records).toHaveLength(fixture.length);
  });

  it('예약번호·이름·전화번호를 CRM 수집 필드로 옮긴다', () => {
    const { records } = mapNaverBookings(fixture);
    const first = records[0];
    expect(first.externalId).toBe(String(fixture[0].bookingId));
    expect(first.customerName).toBe(fixture[0].name);
    // CRM 은 전화번호를 숫자만 남겨 비교하므로 네이버 형식(하이픈 없음)을 그대로 쓴다
    expect(first.phone).toMatch(/^\d+$/);
  });

  it('예약 일시는 스냅샷의 UTC 시각을 쓴다 (상위 startDate 는 날짜까지만 제공)', () => {
    const { records } = mapNaverBookings(fixture);
    const sample = fixture.find((f) => f.snapshotJson?.startDateTime);
    const mapped = records.find((r) => r.externalId === String(sample!.bookingId))!;
    expect(mapped.scheduledStart).toBe(new Date(sample!.snapshotJson!.startDateTime!).toISOString());
    // 캡처된 예약은 모두 30분 단위였다 — 소요시간이 종료시각으로 전달되는지 확인
    const durationMin =
      (Date.parse(mapped.scheduledEnd!) - Date.parse(mapped.scheduledStart)) / 60000;
    expect(durationMin).toBe(30);
  });

  it('상태 코드를 CRM 상태로 매핑한다 (RC03 확정 / RC04 취소 / RC08 이용완료=방문)', () => {
    const { records } = mapNaverBookings(fixture);
    const statusOf = (code: string) => {
      const raw = fixture.find((f) => f.bookingStatusCode === code)!;
      return records.find((r) => r.externalId === String(raw.bookingId))!.status;
    };
    expect(statusOf('RC03')).toBe('CONFIRMED');
    expect(statusOf('RC04')).toBe('CANCELLED');
    expect(statusOf('RC08')).toBe('VISITED');
  });

  it('네이버 메뉴 원본(ID·이름)을 그대로 넘긴다 — 메뉴별 보기에 쓴다', () => {
    const { records } = mapNaverBookings(fixture);
    const raw = fixture[0];
    const mapped = records.find((r) => r.externalId === String(raw.bookingId))!;
    expect(mapped.bizItemName).toBe(raw.bizItemName);
    expect(mapped.bizItemId).toBe(String(raw.bizItemId));
  });

  it('파트너센터에 등록된 메뉴 5종을 예약 목적 코드로 매핑한다', () => {
    expect(resolvePurposeCode('가봉_조율의 시간')).toBe('FITTING');
    expect(resolvePurposeCode('PICKUP_마침내 만나는 순간')).toBe('PICKUP');
    expect(resolvePurposeCode('예복상담_기억에 남을 순간')).toBe('INITIAL_CONSULTATION');
    expect(resolvePurposeCode('비즈니스 맞춤정장_그 날을 입다.')).toBe('INITIAL_CONSULTATION');
    expect(resolvePurposeCode('렌탈_필요한 하루')).toBe('RENTAL_CONSULTATION');
  });

  it('렌탈 메뉴는 이름이 바뀌어도 렌탈 상담으로 간다 (맞춤 상담으로 새지 않게)', () => {
    // 실제로 '렌탈_필요한 하루' → '렌탈(정장대여)' 로 바뀌었다. '렌탈' 이 빠진 이름도 대비한다.
    expect(resolvePurposeCode('렌탈(정장대여)')).toBe('RENTAL_CONSULTATION');
    expect(resolvePurposeCode('정장대여')).toBe('RENTAL_CONSULTATION');
    expect(resolvePurposeCode('예복 대여')).toBe('RENTAL_CONSULTATION');
    // 대여 규칙이 가봉·수선보다 먼저 걸려 버리지 않는다
    expect(resolvePurposeCode('대여 가봉')).toBe('FITTING');
  });

  it('예약 상품 목록은 파트너센터 노출 순서를 그대로 따른다 — 예약 0건 상품도 빠지지 않는다', () => {
    const items = mapNaverBizItems(bizItemFixture);
    expect(items.map((i) => i.name)).toEqual([
      '예복상담_기억에 남을 순간',
      '비즈니스 맞춤정장_그 날을 입다.',
      'PICKUP_마침내 만나는 순간',
      '렌탈(정장대여)',
      '가봉_조율의 시간',
    ]);
    // 렌탈은 예약이 드물어 수집본에 없을 수 있다 — 상품 목록에는 항상 있어야 한다
    expect(items.find((i) => i.name.includes('렌탈'))?.id).toBe('7372140');
  });

  it('상품 목록에서 이름 없는 항목·중복 ID·빈 응답을 걸러낸다', () => {
    expect(mapNaverBizItems([])).toEqual([]);
    const messy: NaverBizItemRaw[] = [
      { bizItemId: 1, name: '  ', order: 1 },
      { bizItemId: 2, name: '렌탈', order: 2 },
      { bizItemId: 2, name: '렌탈(정장대여)', order: 2 },
      { bizItemId: 3, name: '순서없음' },
    ];
    expect(mapNaverBizItems(messy)).toEqual([
      { id: '2', name: '렌탈(정장대여)', order: 2 },
      { id: '3', name: '순서없음', order: Number.MAX_SAFE_INTEGER },
    ]);
  });

  it('처음 보는 메뉴는 예약을 버리지 않고 기본 목적으로 넣되 운영자에게 알린다', () => {
    const novel: NaverBookingRaw = { ...fixture[0], bookingId: 999, bizItemName: '신규메뉴_아직없음' };
    const { records, unmappedBizItems } = mapNaverBookings([novel]);
    expect(records).toHaveLength(1);
    expect(records[0].purposeCode).toBe(FALLBACK_PURPOSE_CODE);
    expect(unmappedBizItems).toEqual(['신규메뉴_아직없음']);
  });

  it('고객 요청사항을 메모로 가져온다', () => {
    const withMemo = fixture.find((f) => (f.requestMessage ?? '').trim())!;
    const { records } = mapNaverBookings([withMemo]);
    expect(records[0].notes).toContain(withMemo.requestMessage!.trim());
  });

  it('취소 사유를 메모에 남긴다 (업체 취소·고객 취소 모두)', () => {
    const byShop: NaverBookingRaw = {
      ...fixture[0],
      bookingStatusCode: 'RC04',
      cancelledDesc: '일정변경 안내연락',
      userCancelledCount: 0,
    };
    expect(mapNaverBookings([byShop]).records[0].notes).toContain('[취소사유] 일정변경 안내연락');

    const byCustomer: NaverBookingRaw = {
      ...fixture[0],
      bookingStatusCode: 'RC04',
      cancelledDesc: null,
      userCancelledCount: 1,
    };
    expect(mapNaverBookings([byCustomer]).records[0].notes).toContain('[취소사유] 고객 직접 취소');
  });

  it('일정 변경으로 재발급된 예약은 이전 예약번호를 메모에 남긴다', () => {
    const rebooked: NaverBookingRaw = { ...fixture[0], previousBookingId: 1320062378 };
    expect(mapNaverBookings([rebooked]).records[0].notes).toContain('이전 예약번호 1320062378');
  });

  it('naverUpdatedAt 은 변경 시각 중 가장 최근 값을 쓴다 (충돌 판정 기준)', () => {
    const raw: NaverBookingRaw = {
      ...fixture[0],
      regDateTime: '2026-09-01T10:00:00+09:00',
      confirmedDateTime: '2026-09-02T11:00:00+09:00',
      cancelledDateTime: null,
      completedDateTime: '2026-09-03T12:00:00+09:00',
    };
    expect(mapNaverBookings([raw]).records[0].naverUpdatedAt).toBe('2026-09-03T12:00:00+09:00');
  });

  it('예약 일시가 없는 건만 건너뛰고 사유를 남긴다', () => {
    const broken: NaverBookingRaw[] = [{ ...fixture[0], bookingId: 1, snapshotJson: null }];
    const { records, skipped } = mapNaverBookings(broken);
    expect(records).toHaveLength(0);
    expect(skipped.map((s) => s.bookingId)).toEqual([1]);
  });

  it('처음 보는 상태 코드는 버리지 않고 예약 대기로 넣으면서 알린다', () => {
    const { records, skipped, unknownStatusCodes } = mapNaverBookings([
      { ...fixture[0], bookingId: 2, bookingStatusCode: 'RC99' },
    ]);
    expect(skipped).toEqual([]);
    expect(unknownStatusCodes).toEqual(['RC99']);
    expect(records[0].status).toBe('RESERVED');
    expect(records[0].notes).toContain('[상태확인] 네이버 상태코드 RC99');
  });
});
