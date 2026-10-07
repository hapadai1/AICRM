import { readFileSync } from 'fs';
import { join } from 'path';
import { mapNaverBookings, NaverBookingRaw } from '../../backend/src/modules/appointments/adapters/naver-booking.mapper';
import {
  NaverBizItem,
  NAVER_RESERVATION_ADAPTER,
  NaverFetchOptions,
  NaverFetchResult,
  NaverFetchWindow,
  NaverReservationAdapter,
  NaverReservationRecord,
} from '../../backend/src/modules/appointments/adapters/naver-reservation.adapter';
import { api, auth, createTestContext, TestContext, truncateBusinessData } from './helpers';

/**
 * 네이버 예약 → CRM 적재 (설계서 16.1).
 *
 * 실제 파트너센터 응답을 가명화한 픽스처를 가짜 어댑터로 흘려, 수집 이후의 DB 적재를 검증한다.
 * 네이버에는 접속하지 않는다.
 */
class FakeNaverAdapter implements NaverReservationAdapter {
  records: NaverReservationRecord[] = [];
  /** 파트너센터 상품 목록 — 예약이 0건인 상품도 화면 선택지에 나오는지 보기 위해 따로 둔다 */
  bizItems: NaverBizItem[] = [];
  windows: Array<NaverFetchWindow | undefined> = [];
  options: Array<NaverFetchOptions | undefined> = [];

  async fetchBizItems(): Promise<NaverBizItem[]> {
    return this.bizItems.map((i) => ({ ...i }));
  }

  async fetchReservations(window?: NaverFetchWindow, options?: NaverFetchOptions): Promise<NaverFetchResult> {
    this.windows.push(window);
    this.options.push(options);
    // 호출부가 레코드를 바꿔도 이전 호출 결과가 흔들리지 않게 복사해 준다
    return { records: this.records.map((r) => ({ ...r })), fetchedAt: new Date().toISOString(), fromCache: false };
  }
}

const fixture: NaverBookingRaw[] = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'naver-bookings.sample.json'), 'utf8'),
);
const fixtureRecords = mapNaverBookings(fixture).records;

describe('네이버 예약 → CRM 적재 (설계서 16.1)', () => {
  let ctx: TestContext;
  const naver = new FakeNaverAdapter();

  const sync = async () =>
    (await api(ctx).post('/api/v1/integrations/naver/reservations/sync').set(auth(ctx)).expect(201)).body.data;
  const findAppt = (externalId: string) =>
    ctx.prisma.appointment.findFirstOrThrow({
      where: { source: 'NAVER', externalId },
      include: { purpose: true, customer: true },
    });
  /** 픽스처에서 조건에 맞는 첫 레코드 */
  const pick = (status: NaverReservationRecord['status'], skip = 0) =>
    fixtureRecords.filter((r) => r.status === status)[skip];
  /** 가짜 네이버의 특정 예약만 바꾼다 */
  const patchNaver = (externalId: string, change: Partial<NaverReservationRecord>) => {
    naver.records = naver.records.map((r) => (r.externalId === externalId ? { ...r, ...change } : r));
  };

  beforeAll(async () => {
    ctx = await createTestContext([], (b) => b.overrideProvider(NAVER_RESERVATION_ADAPTER).useValue(naver));
    await truncateBusinessData(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('첫 적재는 과거·미래 30일을 조회해 예약·고객을 만든다', async () => {
    naver.records = fixtureRecords;
    const result = await sync();

    expect(naver.windows.at(-1)).toEqual({ lookbackDays: 30, lookaheadDays: 30 });
    expect(result).toMatchObject({
      firstLoad: true,
      fetched: fixtureRecords.length,
      created: fixtureRecords.length,
      failed: 0,
    });
    expect(await ctx.prisma.appointment.count({ where: { source: 'NAVER' } })).toBe(fixtureRecords.length);
    // 전화번호마다 가망 고객이 하나씩 생긴다
    expect(await ctx.prisma.customer.count()).toBe(new Set(fixtureRecords.map((r) => r.phone)).size);
  });

  it('예약 일시·상태·목적·메뉴·메모가 네이버 원본대로 들어간다', async () => {
    const fitting = fixtureRecords.find((r) => r.bizItemName?.startsWith('가봉') && r.notes)!;
    const appt = await findAppt(fitting.externalId);
    expect(appt.scheduledStart.toISOString()).toBe(fitting.scheduledStart);
    expect(appt.scheduledEnd?.toISOString()).toBe(fitting.scheduledEnd);
    expect(appt.status).toBe(fitting.status);
    expect(appt.purpose.code).toBe('FITTING');
    expect(appt.naverBizItemName).toBe('가봉_조율의 시간');
    expect(appt.notes).toBe(fitting.notes);
    expect(appt.customer.name).toBe(fitting.customerName);

    // 네이버 이용완료(RC08)는 방문 완료로 들어온다
    const visited = await findAppt(pick('VISITED').externalId);
    expect(visited.status).toBe('VISITED');
  });

  it('두 번째부터는 기본 창으로 조회하고, 바뀐 게 없으면 아무것도 쓰지 않는다', async () => {
    const before = await ctx.prisma.appointment.findMany({ where: { source: 'NAVER' } });
    const auditBefore = await ctx.prisma.auditLog.count();

    const result = await sync();

    expect(naver.windows.at(-1)).toBeUndefined();
    expect(result).toMatchObject({ firstLoad: false, created: 0, updated: 0, unchanged: fixtureRecords.length });
    const after = await ctx.prisma.appointment.findMany({ where: { source: 'NAVER' } });
    // 행 버전이 그대로여야 직원이 열어 둔 수정 화면이 저장 때 버전 충돌로 튕기지 않는다
    for (const a of after) {
      expect(a.rowVersion).toBe(before.find((b) => b.id === a.id)!.rowVersion);
    }
    expect(await ctx.prisma.auditLog.count()).toBe(auditBefore);
  });

  it('네이버에서 취소되면 CRM 예약을 삭제하지 않고 취소로 바꾼다', async () => {
    const target = pick('CONFIRMED', 0);
    patchNaver(target.externalId, { status: 'CANCELLED', naverUpdatedAt: new Date().toISOString() });

    const result = await sync();

    expect(result).toMatchObject({ cancelled: 1, failed: 0 });
    expect((await findAppt(target.externalId)).status).toBe('CANCELLED');
  });

  it('일정을 바꾸면 사라진 옛 예약을 취소로 정리한다 (12시 예약이 남던 건)', async () => {
    // 네이버는 일정 변경 시 옛 예약을 취소로 남기지 않고 목록에서 빼버린 뒤 새 예약번호를 발급한다.
    const before: NaverReservationRecord = {
      ...fixtureRecords[0],
      externalId: '9900000001',
      scheduledStart: '2026-09-29T03:00:00.000Z',
      scheduledEnd: undefined,
      status: 'CONFIRMED',
      notes: undefined,
      previousExternalId: undefined,
      naverUpdatedAt: new Date().toISOString(),
    };
    naver.records = [...naver.records, before];
    expect(await sync()).toMatchObject({ created: 1, superseded: 0, failed: 0 });

    const moved: NaverReservationRecord = {
      ...before,
      externalId: '9900000002',
      scheduledStart: '2026-09-29T04:00:00.000Z',
      previousExternalId: before.externalId,
      naverUpdatedAt: new Date().toISOString(),
    };
    naver.records = naver.records.filter((r) => r.externalId !== before.externalId).concat(moved);

    const result = await sync();

    expect(result).toMatchObject({ created: 1, superseded: 1, failed: 0 });
    const old = await findAppt(before.externalId);
    expect(old.status).toBe('CANCELLED');
    expect(old.notes).toContain(moved.externalId);
    expect((await findAppt(moved.externalId)).scheduledStart.toISOString()).toBe(moved.scheduledStart);

    // 같은 수집본을 다시 반영해도 이미 취소된 건을 또 건드리지 않는다
    expect(await sync()).toMatchObject({ superseded: 0, updated: 0 });
  });

  it('네이버에서 이용완료되면 방문 완료로 바꾼다', async () => {
    const target = pick('CONFIRMED', 1);
    patchNaver(target.externalId, { status: 'VISITED', naverUpdatedAt: new Date().toISOString() });

    const result = await sync();

    expect(result).toMatchObject({ updated: 1 });
    expect((await findAppt(target.externalId)).status).toBe('VISITED');
  });

  it('CRM 에서 방문 처리한 예약을 네이버의 "확정"으로 되돌리지 않는다', async () => {
    const target = pick('CONFIRMED', 2);
    const appt = await findAppt(target.externalId);
    await api(ctx).post(`/api/v1/appointments/${appt.id}/visit`).set(auth(ctx)).expect(201);

    // 네이버에는 여전히 확정으로 남아 있다
    const result = await sync();

    expect(result.failed).toBe(0);
    expect((await findAppt(target.externalId)).status).toBe('VISITED');
  });

  it('CRM 에서 수정한 예약은 덮어쓰지 않고, 네이버도 바뀌면 충돌로 표시한다', async () => {
    const target = pick('VISITED', 0);
    const appt = await findAppt(target.externalId);
    const localStart = '2026-12-01T01:00:00.000Z';
    await api(ctx)
      .patch(`/api/v1/appointments/${appt.id}`)
      .set(auth(ctx))
      .send({ scheduledStart: localStart, version: appt.rowVersion })
      .expect(200);

    // 네이버 쪽도 나중에 바뀌었다
    patchNaver(target.externalId, { notes: '네이버에서 바뀐 메모', naverUpdatedAt: new Date(Date.now() + 60_000).toISOString() });
    const result = await sync();

    expect(result).toMatchObject({ conflicts: 1, failed: 0 });
    const after = await findAppt(target.externalId);
    expect(after.scheduledStart.toISOString()).toBe(localStart);
    expect(after.notes).not.toBe('네이버에서 바뀐 메모');

    const view = await api(ctx).get(`/api/v1/appointments/${appt.id}`).set(auth(ctx)).expect(200);
    expect(view.body.data.syncStatus).toBe('CONFLICT');
  });

  it('동기화 버튼은 저장본 우선 규칙을 따르고, 충돌 해소는 저장본만 본다 (요청마다 스크래핑 안 함)', async () => {
    naver.options = [];
    await sync();
    // 강제 수집 옵션 없이 호출 — 어댑터가 최근 저장본이 있으면 그것을 쓴다
    expect(naver.options.at(-1)).toBeUndefined();

    const conflicted = await ctx.prisma.appointment.findFirstOrThrow({
      where: { source: 'NAVER', localOverride: true },
    });
    await api(ctx)
      .post(`/api/v1/appointments/${conflicted.id}/resolve-conflict`)
      .set(auth(ctx))
      .send({ resolution: 'NAVER' })
      .expect(201);
    expect(naver.options.at(-1)).toEqual({ cacheOnly: true });
  });

  it('한 건이 잘못돼도 나머지는 적재하고, 실패 건과 사유를 돌려준다', async () => {
    const good: NaverReservationRecord = {
      ...fixtureRecords[0],
      externalId: 'NEW-GOOD',
      phone: '01099990001',
      customerName: '정상고객',
    };
    const bad: NaverReservationRecord = {
      ...fixtureRecords[0],
      externalId: 'NEW-BAD',
      phone: '12', // 정규화 불가 전화번호
      customerName: '이상고객',
    };
    // 잘못된 건을 앞에 둬야 "뒤 건이 막히지 않는다"를 검증할 수 있다
    naver.records = [bad, ...naver.records, good];

    const result = await sync();

    expect(result.failed).toBe(1);
    expect(result.failures[0].externalId).toBe('NEW-BAD');
    expect(result.created).toBe(1);
    expect((await findAppt('NEW-GOOD')).customer.name).toBe('정상고객');
    naver.records = naver.records.filter((r) => r.externalId !== 'NEW-BAD');
  });

  it('이미 있는 고객이면 전화번호로 연결하고 고객을 새로 만들지 않는다', async () => {
    const existingCustomer = await ctx.prisma.customer.findFirstOrThrow({
      where: { phoneNormalized: fixtureRecords[0].phone },
    });
    const customersBefore = await ctx.prisma.customer.count();
    naver.records = [
      ...naver.records,
      { ...fixtureRecords[0], externalId: 'REPEAT-VISIT', scheduledStart: '2026-10-01T02:00:00.000Z' },
    ];

    await sync();

    expect(await ctx.prisma.customer.count()).toBe(customersBefore);
    expect((await findAppt('REPEAT-VISIT')).customerId).toBe(existingCustomer.id);
  });

  it('목록을 출처·네이버 메뉴별로 나눠 볼 수 있다', async () => {
    const all = await api(ctx).get('/api/v1/appointments?size=100').set(auth(ctx)).expect(200);
    const naverOnly = await api(ctx).get('/api/v1/appointments?source=NAVER&size=100').set(auth(ctx)).expect(200);
    expect(naverOnly.body.data.length).toBe(all.body.data.length); // 이 스위트의 예약은 전부 네이버

    const menus = await api(ctx).get('/api/v1/appointments/naver-menus').set(auth(ctx)).expect(200);
    const fitting = menus.body.data.find((m: { name: string }) => m.name === '가봉_조율의 시간');
    expect(fitting).toBeDefined();
    const total = menus.body.data.reduce((s: number, m: { count: number }) => s + m.count, 0);
    expect(total).toBe(naverOnly.body.data.length);

    const fittingOnly = await api(ctx)
      .get(`/api/v1/appointments?source=NAVER&naverMenuId=${fitting.id}&size=100`)
      .set(auth(ctx))
      .expect(200);
    expect(fittingOnly.body.data).toHaveLength(fitting.count);
    for (const a of fittingOnly.body.data) expect(a.naverMenuId).toBe(fitting.id);
  });

  it('예약이 한 건도 없는 상품도 메뉴 목록에 0건으로 남는다 (렌탈이 화면에서 사라졌던 건)', async () => {
    // 렌탈은 예약이 드물어 수집 창(과거 7일~미래 45일) 안에 한 건도 없는 날이 많다.
    // 적재분만으로 선택지를 만들면 그때 메뉴가 사라져 "네이버엔 있는데 시스템엔 없다"가 된다.
    const fitting = (await api(ctx).get('/api/v1/appointments/naver-menus').set(auth(ctx)).expect(200)).body
      .data[0] as { id: string };
    naver.bizItems = [
      { id: fitting.id, name: '가봉', order: 1 },
      { id: '7372140', name: '렌탈(정장대여)', order: 2 },
    ];

    const menus = (await api(ctx).get('/api/v1/appointments/naver-menus').set(auth(ctx)).expect(200)).body
      .data as Array<{ id: string; name: string; count: number }>;
    const rental = menus.find((m) => m.id === '7372140');
    expect(rental).toEqual({ id: '7372140', name: '렌탈(정장대여)', count: 0 });
    // 순서는 파트너센터 설정을 따르고, 상품 목록에 없는 과거 메뉴도 뒤에 남는다
    expect(menus.slice(0, 2).map((m) => m.id)).toEqual([fitting.id, '7372140']);
    expect(menus.length).toBeGreaterThan(2);

    naver.bizItems = []; // 다음 테스트에 영향이 없도록 되돌린다
  });

  it('파트너센터에서 메뉴 이름을 바꿔도 한 메뉴로 묶이고, 예전 예약도 새 이름으로 보인다', async () => {
    const menusBefore = (await api(ctx).get('/api/v1/appointments/naver-menus').set(auth(ctx)).expect(200)).body
      .data as Array<{ id: string; name: string; count: number }>;
    const fitting = menusBefore.find((m) => m.name === '가봉_조율의 시간')!;

    // 실제로 2026-09-17 오전에 "가봉_조율의 시간" → "가봉" 으로 바뀌었다.
    // 이번 조회 창에는 그 메뉴 예약이 한 건만 걸렸다고 가정한다.
    const inWindow = naver.records.find((r) => r.bizItemId === fitting.id)!;
    naver.records = [{ ...inWindow, bizItemName: '가봉' }];
    const result = await sync();
    expect(result.failed).toBe(0);

    const menusAfter = (await api(ctx).get('/api/v1/appointments/naver-menus').set(auth(ctx)).expect(200)).body
      .data as Array<{ id: string; name: string; count: number }>;
    const renamed = menusAfter.filter((m) => m.id === fitting.id);
    expect(renamed).toEqual([{ id: fitting.id, name: '가봉', count: fitting.count }]);
    expect(
      await ctx.prisma.appointment.count({ where: { naverBizItemId: fitting.id, naverBizItemName: '가봉_조율의 시간' } }),
    ).toBe(0);
  });
});
