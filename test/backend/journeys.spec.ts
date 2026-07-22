import { randomUUID } from 'crypto';
import { JourneysModule } from '../../backend/src/modules/journeys/journeys.module';
import { PrismaService } from '../../backend/src/prisma/prisma.service';
import { api, auth, createTestContext, TestContext, truncateBusinessData } from './helpers';

/**
 * 진행 단계 테스트용 최소 데이터. 진행은 주문 1건당 1개만 허용되므로
 * 주문이 필요한 테스트는 매번 새 주문을 만들어 쓴다.
 */
async function seedCustomer(prisma: PrismaService) {
  const admin = await prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
  const suffix = randomUUID().slice(0, 8);
  const customer = await prisma.customer.create({
    data: {
      id: randomUUID(),
      name: `진행고객-${suffix}`,
      phone: '010-1111-2222',
      phoneNormalized: `${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(0, 20),
    },
  });
  return { admin, customer };
}

/** 맞춤 주문 1건 + 품목 1건 (연락 문구의 `품목` 변수 확인용) */
async function createOrderWithItem(prisma: PrismaService, customerId: string, adminId: string) {
  const suffix = randomUUID().slice(0, 8);
  const contract = await prisma.contract.create({
    data: {
      id: randomUUID(),
      contractNo: `CTR-J-${suffix}`,
      customerId,
      status: 'CONFIRMED',
    },
  });
  const version = await prisma.contractVersion.create({
    data: { id: randomUUID(), contractId: contract.id, versionNo: 1, createdBy: adminId },
  });
  const line = await prisma.contractLine.create({
    data: {
      id: randomUUID(),
      contractVersionId: version.id,
      transactionType: 'CUSTOM',
      productCategory: 'SUIT',
      quantity: 1,
    },
  });
  const order = await prisma.order.create({
    data: {
      id: randomUUID(),
      orderNo: `ORD-J-${suffix}`,
      contractId: contract.id,
      transactionType: 'CUSTOM',
    },
  });
  await prisma.orderItem.create({
    data: {
      id: randomUUID(),
      orderId: order.id,
      sourceContractLineId: line.id,
      productCategory: 'SUIT',
      sequenceNo: 1,
      displayName: '정장 #1',
      status: 'CREATED',
    },
  });
  return order;
}

describe('진행 단계 (JOURNEY)', () => {
  let ctx: TestContext;
  let customerId: string;
  let adminId: string;

  beforeAll(async () => {
    ctx = await createTestContext([JourneysModule]);
    await truncateBusinessData(ctx.prisma);
    const seeded = await seedCustomer(ctx.prisma);
    customerId = seeded.customer.id;
    adminId = seeded.admin.id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  /** 매 테스트가 독립적으로 쓰도록 새 진행을 만든다. */
  async function createJourney(body: Record<string, unknown> = {}) {
    const res = await api(ctx)
      .post(`/api/v1/customers/${customerId}/journeys`)
      .set(auth(ctx))
      .send({ trackType: 'CUSTOM', ...body });
    return res;
  }

  it('단계 마스터를 트랙별로 조회한다 (맞춤 9 / 렌탈 7)', async () => {
    const custom = await api(ctx)
      .get('/api/v1/journey-stages?trackType=CUSTOM')
      .set(auth(ctx))
      .expect(200);
    const rental = await api(ctx)
      .get('/api/v1/journey-stages?trackType=RENTAL')
      .set(auth(ctx))
      .expect(200);

    expect(custom.body.data).toHaveLength(9);
    expect(custom.body.data[0]).toMatchObject({ code: 'CONSULT_RESERVED', sequenceNo: 1 });
    expect(rental.body.data).toHaveLength(7);
    expect(rental.body.data.at(-1)).toMatchObject({ code: 'RENTAL_RETURNED' });

    // 연락 대상 단계에만 템플릿이 붙어 있다.
    const withTemplate = custom.body.data.filter((s: { templateId: string | null }) => s.templateId);
    expect(withTemplate.map((s: { code: string }) => s.code)).toEqual([
      'BASTING_RECEIVED',
      'PRODUCT_RECEIVED',
      'RELEASED',
    ]);
  });

  it('진행을 시작하면 트랙의 첫 단계에서 출발한다', async () => {
    const res = await createJourney();
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      trackType: 'CUSTOM',
      currentStageCode: 'CONSULT_RESERVED',
      currentStageSequenceNo: 1,
      totalStages: 9,
      status: 'ACTIVE',
      version: 0,
      customerId,
    });
  });

  it('같은 주문에 진행을 중복 생성할 수 없다', async () => {
    const order = await createOrderWithItem(ctx.prisma, customerId, adminId);
    const first = await createJourney({ orderId: order.id });
    expect(first.status).toBe(201);

    const second = await createJourney({ orderId: order.id });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('VALIDATION_ERROR');
    expect(second.body.error.fieldErrors?.[0]).toMatchObject({ field: 'orderId' });
  });

  it('다음 단계로 전진한다', async () => {
    const created = await createJourney();
    const res = await api(ctx)
      .post(`/api/v1/journeys/${created.body.data.id}/stage`)
      .set(auth(ctx))
      .send({ toStageCode: 'CONSULT_DONE', version: 0 })
      .expect(201);

    expect(res.body.data.journey).toMatchObject({
      currentStageCode: 'CONSULT_DONE',
      version: 1,
    });
    expect(res.body.data.event).toMatchObject({
      fromStageCode: 'CONSULT_RESERVED',
      toStageCode: 'CONSULT_DONE',
      notificationOutcome: 'NONE',
    });
    // 연락 대상 단계가 아니므로 발송 제안이 없다.
    expect(res.body.data.suggestedNotification).toBeNull();
  });

  it('단계 건너뛰기를 허용한다 (현장에서 단계가 생략되는 경우)', async () => {
    const created = await createJourney();
    const res = await api(ctx)
      .post(`/api/v1/journeys/${created.body.data.id}/stage`)
      .set(auth(ctx))
      .send({ toStageCode: 'ORDER_REQUESTED', version: 0 })
      .expect(201);

    expect(res.body.data.journey.currentStageCode).toBe('ORDER_REQUESTED');
    expect(res.body.data.event.fromStageCode).toBe('CONSULT_RESERVED');
  });

  it('되돌리기는 사유가 없으면 거부한다', async () => {
    const created = await createJourney();
    const id = created.body.data.id;
    await api(ctx)
      .post(`/api/v1/journeys/${id}/stage`)
      .set(auth(ctx))
      .send({ toStageCode: 'ORDER_REQUESTED', version: 0 })
      .expect(201);

    const noReason = await api(ctx)
      .post(`/api/v1/journeys/${id}/stage`)
      .set(auth(ctx))
      .send({ toStageCode: 'CONSULT_DONE', version: 1 });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.fieldErrors?.[0]).toMatchObject({
      field: 'reason',
      reason: 'REQUIRED_FOR_BACKWARD',
    });

    const withReason = await api(ctx)
      .post(`/api/v1/journeys/${id}/stage`)
      .set(auth(ctx))
      .send({ toStageCode: 'CONSULT_DONE', version: 1, reason: '고객 요청으로 재상담' })
      .expect(201);
    expect(withReason.body.data.journey.currentStageCode).toBe('CONSULT_DONE');
    expect(withReason.body.data.event.reason).toBe('고객 요청으로 재상담');
  });

  it('버전이 어긋나면 409로 막는다', async () => {
    const created = await createJourney();
    const res = await api(ctx)
      .post(`/api/v1/journeys/${created.body.data.id}/stage`)
      .set(auth(ctx))
      .send({ toStageCode: 'CONSULT_DONE', version: 99 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('트랙에 없는 단계 코드와 같은 단계 재지정을 거부한다', async () => {
    const created = await createJourney();
    const id = created.body.data.id;

    const unknown = await api(ctx)
      .post(`/api/v1/journeys/${id}/stage`)
      .set(auth(ctx))
      .send({ toStageCode: 'RENTAL_RETURNED', version: 0 });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.fieldErrors?.[0]).toMatchObject({ reason: 'UNKNOWN_STAGE' });

    const same = await api(ctx)
      .post(`/api/v1/journeys/${id}/stage`)
      .set(auth(ctx))
      .send({ toStageCode: 'CONSULT_RESERVED', version: 0 });
    expect(same.status).toBe(400);
    expect(same.body.error.fieldErrors?.[0]).toMatchObject({ reason: 'SAME_STAGE' });
  });

  it('연락 대상 단계에서는 치환된 문구와 멱등키를 제안한다', async () => {
    const order = await createOrderWithItem(ctx.prisma, customerId, adminId);
    const orderId = order.id;
    const created = await createJourney({ orderId });
    const res = await api(ctx)
      .post(`/api/v1/journeys/${created.body.data.id}/stage`)
      .set(auth(ctx))
      .send({ toStageCode: 'PRODUCT_RECEIVED', version: 0 })
      .expect(201);

    const s = res.body.data.suggestedNotification;
    expect(s).toMatchObject({
      templateCode: 'JOURNEY_PRODUCT_RECEIVED',
      channel: 'ALIMTALK',
      recipientPhone: '010-1111-2222',
      customerId,
      orderId,
      triggerKey: `journey:${created.body.data.id}:PRODUCT_RECEIVED`,
    });
    // 고객명·품목이 실제 값으로 치환되고 미치환 자리표시자가 남지 않는다.
    expect(s.renderedBody).toContain('정장 #1');
    expect(s.renderedBody).toContain(res.body.data.journey.customerName);
    expect(s.renderedBody).not.toContain('#{');
    expect(s.eventId).toBe(res.body.data.event.id);
  });

  it('주문 없이 시작한 진행은 품목 자리를 기본 문구로 채운다 (자리표시자 미노출)', async () => {
    // 주문을 연결하지 않고 진행 시작 → PRODUCT_RECEIVED로 이동
    const created = await createJourney();
    const res = await api(ctx)
      .post(`/api/v1/journeys/${created.body.data.id}/stage`)
      .set(auth(ctx))
      .send({ toStageCode: 'PRODUCT_RECEIVED', version: 0 })
      .expect(201);

    const s = res.body.data.suggestedNotification;
    expect(s).not.toBeNull();
    // #{품목} 자리표시자가 그대로 남지 않고 기본 문구로 치환된다.
    expect(s.renderedBody).not.toContain('#{');
    expect(s.renderedBody).toContain('주문하신 상품');
    expect(s.variables['품목']).toBe('주문하신 상품');
  });

  it('발송 확인창의 처리 결과를 이력에 봉합한다', async () => {
    const created = await createJourney();
    const changed = await api(ctx)
      .post(`/api/v1/journeys/${created.body.data.id}/stage`)
      .set(auth(ctx))
      .send({ toStageCode: 'BASTING_RECEIVED', version: 0 })
      .expect(201);
    const eventId = changed.body.data.event.id;

    // "나중에" — 대시보드 연락 대기로 남는다.
    const deferred = await api(ctx)
      .post(`/api/v1/journeys/${created.body.data.id}/events/${eventId}/notification-outcome`)
      .set(auth(ctx))
      .send({ outcome: 'DEFERRED' })
      .expect(201);
    expect(deferred.body.data.notificationOutcome).toBe('DEFERRED');

    // SENT인데 발송 이력 ID가 없으면 거부한다.
    const missingHistory = await api(ctx)
      .post(`/api/v1/journeys/${created.body.data.id}/events/${eventId}/notification-outcome`)
      .set(auth(ctx))
      .send({ outcome: 'SENT' });
    expect(missingHistory.status).toBe(400);
    expect(missingHistory.body.error.fieldErrors?.[0]).toMatchObject({
      field: 'notificationHistoryId',
    });
  });

  it('상세에 단계 목록과 변경 이력이 함께 담긴다', async () => {
    const created = await createJourney();
    const id = created.body.data.id;
    await api(ctx)
      .post(`/api/v1/journeys/${id}/stage`)
      .set(auth(ctx))
      .send({ toStageCode: 'CONSULT_DONE', version: 0 })
      .expect(201);

    const res = await api(ctx).get(`/api/v1/journeys/${id}`).set(auth(ctx)).expect(200);
    expect(res.body.data.stages).toHaveLength(9);
    expect(res.body.data.stages[5]).toMatchObject({ code: 'BASTING_RECEIVED', hasTemplate: true });
    expect(res.body.data.events).toHaveLength(1);
    expect(res.body.data.events[0].toStageCode).toBe('CONSULT_DONE');
  });

  it('완료 처리하면 단계를 더 바꿀 수 없다', async () => {
    const created = await createJourney();
    const id = created.body.data.id;

    const completed = await api(ctx)
      .post(`/api/v1/journeys/${id}/complete`)
      .set(auth(ctx))
      .send({ version: 0 })
      .expect(201);
    expect(completed.body.data.status).toBe('COMPLETED');
    expect(completed.body.data.completedAt).toBeTruthy();

    const blocked = await api(ctx)
      .post(`/api/v1/journeys/${id}/stage`)
      .set(auth(ctx))
      .send({ toStageCode: 'CONSULT_DONE', version: 1 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('진행 현황을 단계로 거르고 머문 일수를 함께 돌려준다', async () => {
    const created = await createJourney();
    await api(ctx)
      .post(`/api/v1/journeys/${created.body.data.id}/stage`)
      .set(auth(ctx))
      .send({ toStageCode: 'STYLE_CONSULTING', version: 0 })
      .expect(201);

    const res = await api(ctx)
      .get('/api/v1/journeys?stageCodes=STYLE_CONSULTING')
      .set(auth(ctx))
      .expect(200);

    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.every((j: { currentStageCode: string }) => j.currentStageCode === 'STYLE_CONSULTING')).toBe(true);
    expect(res.body.data[0]).toHaveProperty('daysInStage');
    expect(res.body.page.totalElements).toBeGreaterThanOrEqual(1);

    // 방금 만든 진행은 정체 대상이 아니다.
    const stalled = await api(ctx)
      .get('/api/v1/journeys?stageCodes=STYLE_CONSULTING&stalledDays=7')
      .set(auth(ctx))
      .expect(200);
    expect(stalled.body.data).toHaveLength(0);
  });

  it('고객 상세용 진행 목록을 최신순으로 돌려준다', async () => {
    const res = await api(ctx)
      .get(`/api/v1/customers/${customerId}/journeys`)
      .set(auth(ctx))
      .expect(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0]).toHaveProperty('currentStageName');
    expect(res.body.data[0].customerId).toBe(customerId);
  });
});
