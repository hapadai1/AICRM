import { randomUUID } from 'crypto';
import { AppointmentsModule } from '../../backend/src/modules/appointments/appointments.module';
import { api, auth, createTestContext, TestContext, truncateBusinessData } from './helpers';

describe('예약·상담 (Phase 2 + 연동정합화 §1)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext([AppointmentsModule]);
    await truncateBusinessData(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('신규 전화번호로 CRM 예약 생성 시 PROSPECT 고객을 자동 생성하고 평면 뷰로 응답한다', async () => {
    const res = await api(ctx)
      .post('/api/v1/appointments')
      .set(auth(ctx))
      .send({
        customerName: '이신규',
        phone: '010-3333-1111',
        purposeCode: 'INITIAL_CONSULTATION',
        scheduledStart: '2026-08-01T10:00:00+09:00',
        notes: '첫 상담 예약',
      })
      .expect(201);
    // 평면 뷰 매퍼 (연동정합화 계약 §1)
    expect(res.body.data.source).toBe('CRM');
    expect(res.body.data.status).toBe('RESERVED');
    expect(res.body.data.customerName).toBe('이신규');
    expect(res.body.data.phone).toBe('010-3333-1111');
    expect(res.body.data.customerStatus).toBe('PROSPECT');
    expect(res.body.data.purposeCode).toBe('INITIAL_CONSULTATION');
    expect(res.body.data.purposeName).toBeDefined();
    expect(res.body.data.startAt).toBeDefined();
    expect(res.body.data.memo).toBe('첫 상담 예약');
    expect(res.body.data.version).toBe(0);
    expect(res.body.data.syncStatus).toBe('NORMAL');
    expect(res.body.data.naverReservationId).toBeNull();

    const customer = await ctx.prisma.customer.findUnique({
      where: { phoneNormalized: '01033331111' },
    });
    expect(customer?.customerStatus).toBe('PROSPECT');
    expect(customer?.firstReservedAt).not.toBeNull();
  });

  it('기존 고객 전화번호로 예약하면 새 고객을 만들지 않고 기존 고객에 연결한다', async () => {
    const before = await ctx.prisma.customer.count();
    const res = await api(ctx)
      .post('/api/v1/appointments')
      .set(auth(ctx))
      .send({
        customerName: '이신규(다른표기)',
        phone: '010 3333 1111',
        purposeCode: 'FITTING',
        scheduledStart: '2026-08-05T14:00:00+09:00',
      })
      .expect(201);
    expect(res.body.data.customerName).toBe('이신규');
    expect(await ctx.prisma.customer.count()).toBe(before);
  });

  it('예약 목록은 기간·상태 필터와 purposeCodes·statuses 콤마 목록을 지원한다', async () => {
    const inRange = await api(ctx)
      .get('/api/v1/appointments?from=2026-08-01&to=2026-08-02&status=RESERVED')
      .set(auth(ctx))
      .expect(200);
    expect(inRange.body.data).toHaveLength(1);
    expect(inRange.body.data[0].purposeCode).toBe('INITIAL_CONSULTATION');

    const outRange = await api(ctx)
      .get('/api/v1/appointments?from=2026-09-01&to=2026-09-30')
      .set(auth(ctx))
      .expect(200);
    expect(outRange.body.data).toHaveLength(0);

    const byPurpose = await api(ctx)
      .get('/api/v1/appointments?purpose=FITTING')
      .set(auth(ctx))
      .expect(200);
    expect(byPurpose.body.data).toHaveLength(1);

    // 콤마 목록 (연동정합화 계약 §1)
    const byCodes = await api(ctx)
      .get('/api/v1/appointments?purposeCodes=FITTING,INITIAL_CONSULTATION&statuses=RESERVED,CONFIRMED')
      .set(auth(ctx))
      .expect(200);
    expect(byCodes.body.data).toHaveLength(2);

    const invalidStatuses = await api(ctx)
      .get('/api/v1/appointments?statuses=RESERVED,BOGUS')
      .set(auth(ctx))
      .expect(400);
    expect(invalidStatuses.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('예약 목적 목록(GET /appointment-purposes)은 active 목적만 반환한다', async () => {
    const res = await api(ctx).get('/api/v1/appointment-purposes').set(auth(ctx)).expect(200);
    const codes = res.body.data.map((p: { code: string }) => p.code);
    expect(codes).toEqual(expect.arrayContaining(['INITIAL_CONSULTATION', 'FITTING']));
    for (const purpose of res.body.data) {
      expect(purpose.id).toBeDefined();
      expect(purpose.name).toBeDefined();
      expect(purpose.sortOrder).toBeDefined();
    }
  });

  it('예약 수정은 낙관적 잠금을 적용하고 평면 뷰(version/memo)로 응답한다', async () => {
    const list = await api(ctx).get('/api/v1/appointments?purpose=FITTING').set(auth(ctx)).expect(200);
    const appt = list.body.data[0];

    const conflict = await api(ctx)
      .patch(`/api/v1/appointments/${appt.id}`)
      .set(auth(ctx))
      .send({ notes: '메모', version: appt.version + 5 })
      .expect(409);
    expect(conflict.body.error.code).toBe('VERSION_CONFLICT');

    const ok = await api(ctx)
      .patch(`/api/v1/appointments/${appt.id}`)
      .set(auth(ctx))
      .send({ notes: '메모', version: appt.version })
      .expect(200);
    expect(ok.body.data.memo).toBe('메모');
    expect(ok.body.data.version).toBe(appt.version + 1);
    expect(ok.body.data.syncStatus).toBe('NORMAL'); // CRM 예약은 localOverride 대상 아님
  });

  it('네이버 수집 예약을 CRM에서 수정하면 syncStatus=LOCAL_EDITED가 된다', async () => {
    const purpose = await ctx.prisma.appointmentPurpose.findUniqueOrThrow({
      where: { code: 'INITIAL_CONSULTATION' },
    });
    const customer = await ctx.prisma.customer.findFirstOrThrow();
    const naverAppt = await ctx.prisma.appointment.create({
      data: {
        id: randomUUID(),
        customerId: customer.id,
        source: 'NAVER',
        externalId: 'NAVER-TEST-001',
        purposeId: purpose.id,
        scheduledStart: new Date('2026-08-10T11:00:00+09:00'),
        status: 'RESERVED',
        syncedAt: new Date('2026-07-01T00:00:00+09:00'),
      },
    });

    const res = await api(ctx)
      .patch(`/api/v1/appointments/${naverAppt.id}`)
      .set(auth(ctx))
      .send({ scheduledStart: '2026-08-10T13:00:00+09:00', version: 0 })
      .expect(200);
    expect(res.body.data.syncStatus).toBe('LOCAL_EDITED');
    expect(res.body.data.naverReservationId).toBe('NAVER-TEST-001');
  });

  it('충돌(CONFLICT) 예약을 resolve-conflict로 해소한다 (CRM 유지 → NAVER 채택)', async () => {
    const appt = await ctx.prisma.appointment.findFirstOrThrow({
      where: { source: 'NAVER', externalId: 'NAVER-TEST-001' },
    });
    // 로컬 수정 이후 네이버 측도 변경됨 → CONFLICT
    await ctx.prisma.appointment.update({
      where: { id: appt.id },
      data: { naverUpdatedAt: new Date() },
    });
    const detail = await api(ctx).get(`/api/v1/appointments/${appt.id}`).set(auth(ctx)).expect(200);
    expect(detail.body.data.syncStatus).toBe('CONFLICT');

    // CRM 수정본 유지: 네이버 변경분 확인 처리 → LOCAL_EDITED
    const keptCrm = await api(ctx)
      .post(`/api/v1/appointments/${appt.id}/resolve-conflict`)
      .set(auth(ctx))
      .send({ resolution: 'CRM' })
      .expect(201);
    expect(keptCrm.body.data.syncStatus).toBe('LOCAL_EDITED');

    // 네이버 원본 채택: localOverride 해제 → NORMAL
    const tookNaver = await api(ctx)
      .post(`/api/v1/appointments/${appt.id}/resolve-conflict`)
      .set(auth(ctx))
      .send({ resolution: 'NAVER' })
      .expect(201);
    expect(tookNaver.body.data.syncStatus).toBe('NORMAL');

    // CRM 예약은 충돌 해소 대상이 아니다
    const crmAppt = await ctx.prisma.appointment.findFirstOrThrow({ where: { source: 'CRM' } });
    const invalid = await api(ctx)
      .post(`/api/v1/appointments/${crmAppt.id}/resolve-conflict`)
      .set(auth(ctx))
      .send({ resolution: 'NAVER' })
      .expect(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('확정(confirm)·노쇼(no-show) 액션과 허용 전이를 지원한다', async () => {
    const created = await api(ctx)
      .post('/api/v1/appointments')
      .set(auth(ctx))
      .send({
        customerName: '김노쇼',
        phone: '010-4444-2222',
        purposeCode: 'FITTING',
        scheduledStart: '2026-08-12T15:00:00+09:00',
      })
      .expect(201);
    const id = created.body.data.id;

    const confirmed = await api(ctx).post(`/api/v1/appointments/${id}/confirm`).set(auth(ctx)).expect(201);
    expect(confirmed.body.data.status).toBe('CONFIRMED');

    const noShow = await api(ctx).post(`/api/v1/appointments/${id}/no-show`).set(auth(ctx)).expect(201);
    expect(noShow.body.data.status).toBe('NO_SHOW');

    // NO_SHOW는 종결 상태 — 재확정 불가
    const again = await api(ctx).post(`/api/v1/appointments/${id}/confirm`).set(auth(ctx)).expect(409);
    expect(again.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('방문 완료 처리 후에는 재방문 처리가 INVALID_STATUS_TRANSITION으로 차단된다', async () => {
    const list = await api(ctx)
      .get('/api/v1/appointments?purpose=FITTING&statuses=RESERVED')
      .set(auth(ctx))
      .expect(200);
    const appt = list.body.data[0];

    const visited = await api(ctx)
      .post(`/api/v1/appointments/${appt.id}/visit`)
      .set(auth(ctx))
      .expect(201);
    expect(visited.body.data.status).toBe('VISITED');

    const again = await api(ctx)
      .post(`/api/v1/appointments/${appt.id}/visit`)
      .set(auth(ctx))
      .expect(409);
    expect(again.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    expect(again.body.error.details.currentStatus).toBe('VISITED');
  });

  it('예약 취소는 레코드를 삭제하지 않고 CANCELLED로 보존하며 사유를 감사로그에 남긴다', async () => {
    const list = await api(ctx)
      .get('/api/v1/appointments?purpose=INITIAL_CONSULTATION&source=CRM')
      .set(auth(ctx))
      .expect(200);
    const appt = list.body.data[0];

    // 사유 없는 취소는 검증 오류
    await api(ctx).post(`/api/v1/appointments/${appt.id}/cancel`).set(auth(ctx)).send({}).expect(400);

    const res = await api(ctx)
      .post(`/api/v1/appointments/${appt.id}/cancel`)
      .set(auth(ctx))
      .send({ reason: '고객 개인 사정' })
      .expect(201);
    expect(res.body.data.status).toBe('CANCELLED');

    // 레코드 보존 확인
    const detail = await api(ctx).get(`/api/v1/appointments/${appt.id}`).set(auth(ctx)).expect(200);
    expect(detail.body.data.status).toBe('CANCELLED');

    const logs = await ctx.prisma.auditLog.findMany({
      where: { entityType: 'APPOINTMENT', entityId: appt.id, action: 'CANCEL' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].reason).toBe('고객 개인 사정');
  });

  it('상담은 interests[]를 수용하고 상세 응답에 consultations가 포함된다', async () => {
    const purpose = await ctx.prisma.appointmentPurpose.findUniqueOrThrow({
      where: { code: 'INITIAL_CONSULTATION' },
    });
    const customer = await ctx.prisma.customer.findUniqueOrThrow({
      where: { phoneNormalized: '01033331111' },
    });
    const appt = await ctx.prisma.appointment.create({
      data: {
        id: randomUUID(),
        customerId: customer.id,
        source: 'CRM',
        purposeId: purpose.id,
        scheduledStart: new Date('2026-08-20T10:00:00+09:00'),
        status: 'RESERVED',
      },
    });

    const created = await api(ctx)
      .post(`/api/v1/appointments/${appt.id}/consultations`)
      .set(auth(ctx))
      .send({ interests: ['SUIT', 'SHIRT'], content: '9월 결혼식, 네이비 정장 희망' })
      .expect(201);
    // 상담 뷰 (연동정합화 계약 §1)
    expect(created.body.data.appointmentId).toBe(appt.id);
    expect(created.body.data.interests).toEqual(['SUIT', 'SHIRT']);
    expect(created.body.data.createdBy).toBeDefined();
    expect(created.body.data.createdAt).toBeDefined();

    // interests는 consultation_category에 콤마로 저장된다
    const row = await ctx.prisma.consultation.findUniqueOrThrow({ where: { id: created.body.data.id } });
    expect(row.consultationCategory).toBe('SUIT,SHIRT');

    // 상세 응답에 consultations 포함
    const detail = await api(ctx).get(`/api/v1/appointments/${appt.id}`).set(auth(ctx)).expect(200);
    expect(detail.body.data.consultations).toHaveLength(1);
    expect(detail.body.data.consultations[0].interests).toEqual(['SUIT', 'SHIRT']);

    // 고객 상담 이력 (미계약 고객 포함)
    const history = await api(ctx)
      .get(`/api/v1/customers/${customer.id}/consultations`)
      .set(auth(ctx))
      .expect(200);
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0].content).toContain('네이비 정장');
    expect(history.body.data[0].appointment.purposeCode).toBe('INITIAL_CONSULTATION');
    expect(customer.customerStatus).toBe('PROSPECT'); // 미계약 고객 상담 이력 보존
  });

  it('네이버 동기화(스텁)는 {fetched, created, updated, cancelled} 결과를 반환한다', async () => {
    const res = await api(ctx)
      .post('/api/v1/integrations/naver/reservations/sync')
      .set(auth(ctx))
      .expect(201);
    expect(res.body.data).toEqual({ fetched: 0, created: 0, updated: 0, cancelled: 0 });
  });
});
