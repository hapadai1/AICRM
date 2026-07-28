import { randomUUID } from 'crypto';
import { computeGating } from '../../backend/src/modules/journeys/journey-gating';
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

/** 맞춤 주문 1건 + 품목 N건 */
async function createOrderWithItems(
  prisma: PrismaService,
  customerId: string,
  adminId: string,
  itemCount = 1,
) {
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
      quantity: itemCount,
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
  const items = [];
  for (let i = 1; i <= itemCount; i += 1) {
    items.push(
      await prisma.orderItem.create({
        data: {
          id: randomUUID(),
          orderId: order.id,
          sourceContractLineId: line.id,
          productCategory: 'SUIT',
          sequenceNo: i,
          displayName: `정장 #${i}`,
          status: 'CREATED',
        },
      }),
    );
  }
  return { order, items };
}

describe('진행 단계 (JOURNEY) — v2 재정의', () => {
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

  async function createJourney(body: Record<string, unknown> = {}) {
    const res = await api(ctx)
      .post(`/api/v1/customers/${customerId}/journeys`)
      .set(auth(ctx))
      .send({ trackType: 'CUSTOM', ...body });
    return res;
  }

  function changeStage(id: string, body: Record<string, unknown>) {
    return api(ctx).post(`/api/v1/journeys/${id}/stage`).set(auth(ctx)).send(body);
  }

  // ---------------------------------------------------------------------------
  // computeGating 규칙 함수 (구현표준 4 — 규칙 함수 우선)
  // ---------------------------------------------------------------------------

  describe('computeGating', () => {
    it('GATED는 전 품목 완료 시에만 canComplete=true', () => {
      const g = computeGating('S', 'GATED', ['a', 'b'], [
        { targetId: 'a', revokedAt: null },
        { targetId: 'b', revokedAt: null },
      ]);
      expect(g).toMatchObject({ targetCount: 2, completedCount: 2, canComplete: true });
    });

    it('일부만 완료면 canComplete=false', () => {
      const g = computeGating('S', 'GATED', ['a', 'b'], [{ targetId: 'a', revokedAt: null }]);
      expect(g.canComplete).toBe(false);
    });

    it('취소(revokedAt)된 완료는 집계하지 않는다', () => {
      const g = computeGating('S', 'GATED', ['a'], [{ targetId: 'a', revokedAt: new Date() }]);
      expect(g).toMatchObject({ completedCount: 0, canComplete: false });
    });

    it('대상 0건이면 canComplete=false', () => {
      expect(computeGating('S', 'GATED', [], []).canComplete).toBe(false);
    });

    it('AUTO 단계는 canComplete=false', () => {
      const g = computeGating('S', 'AUTO', ['a'], [{ targetId: 'a', revokedAt: null }]);
      expect(g.canComplete).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 단계 마스터 / 기본 전이
  // ---------------------------------------------------------------------------

  it('단계 마스터를 트랙별로 조회한다 (맞춤 8 / 렌탈 7 / 수선 4)', async () => {
    const custom = await api(ctx).get('/api/v1/journey-stages?trackType=CUSTOM').set(auth(ctx)).expect(200);
    const rental = await api(ctx).get('/api/v1/journey-stages?trackType=RENTAL').set(auth(ctx)).expect(200);
    const repair = await api(ctx).get('/api/v1/journey-stages?trackType=REPAIR').set(auth(ctx)).expect(200);

    expect(custom.body.data).toHaveLength(8);
    expect(custom.body.data[0]).toMatchObject({ code: 'CONSULT_RESERVED', sequenceNo: 1 });
    expect(custom.body.data.at(-1)).toMatchObject({ code: 'RELEASED' });
    expect(rental.body.data).toHaveLength(7);
    expect(rental.body.data.at(-1)).toMatchObject({ code: 'RENTAL_RETURNED' });
    expect(repair.body.data).toHaveLength(4);
    expect(repair.body.data[0]).toMatchObject({ code: 'REPAIR_RECEIVED' });

    // 은퇴 단계는 노출되지 않는다.
    expect(custom.body.data.map((s: { code: string }) => s.code)).not.toContain('CONSULT_DONE');

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
      totalStages: 8,
      status: 'ACTIVE',
      version: 0,
      customerId,
    });
  });

  it('같은 주문에 진행을 중복 생성할 수 없다', async () => {
    const { order } = await createOrderWithItems(ctx.prisma, customerId, adminId);
    const first = await createJourney({ orderId: order.id });
    expect(first.status).toBe(201);

    const second = await createJourney({ orderId: order.id });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('VALIDATION_ERROR');
    expect(second.body.error.fieldErrors?.[0]).toMatchObject({ field: 'orderId' });
  });

  it('AUTO 단계에서는 게이팅 없이 다음 단계로 전진한다', async () => {
    const created = await createJourney();
    const res = await changeStage(created.body.data.id, {
      toStageCode: 'CONTRACT_CONFIRMED',
      version: 0,
    }).expect(201);

    expect(res.body.data.journey).toMatchObject({ currentStageCode: 'CONTRACT_CONFIRMED', version: 1 });
    expect(res.body.data.event).toMatchObject({
      fromStageCode: 'CONSULT_RESERVED',
      toStageCode: 'CONTRACT_CONFIRMED',
    });
    expect(res.body.data.suggestedNotification).toBeNull();
  });

  it('AUTO 단계에서 단계 건너뛰기를 허용한다', async () => {
    const created = await createJourney();
    const res = await changeStage(created.body.data.id, {
      toStageCode: 'ORDER_REQUESTED',
      version: 0,
    }).expect(201);
    expect(res.body.data.journey.currentStageCode).toBe('ORDER_REQUESTED');
    expect(res.body.data.event.fromStageCode).toBe('CONSULT_RESERVED');
  });

  it('되돌리기는 사유가 없으면 거부한다', async () => {
    const created = await createJourney();
    const id = created.body.data.id;
    await changeStage(id, { toStageCode: 'ORDER_REQUESTED', version: 0 }).expect(201);

    const noReason = await changeStage(id, { toStageCode: 'CONTRACT_CONFIRMED', version: 1 });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.fieldErrors?.[0]).toMatchObject({
      field: 'reason',
      reason: 'REQUIRED_FOR_BACKWARD',
    });

    const withReason = await changeStage(id, {
      toStageCode: 'CONTRACT_CONFIRMED',
      version: 1,
      reason: '고객 요청으로 재상담',
    }).expect(201);
    expect(withReason.body.data.journey.currentStageCode).toBe('CONTRACT_CONFIRMED');
    expect(withReason.body.data.event.reason).toBe('고객 요청으로 재상담');
  });

  it('버전이 어긋나면 409로 막는다', async () => {
    const created = await createJourney();
    const res = await changeStage(created.body.data.id, {
      toStageCode: 'CONTRACT_CONFIRMED',
      version: 99,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('트랙에 없는 단계 코드와 같은 단계 재지정을 거부한다', async () => {
    const created = await createJourney();
    const id = created.body.data.id;

    const unknown = await changeStage(id, { toStageCode: 'RENTAL_RETURNED', version: 0 });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.fieldErrors?.[0]).toMatchObject({ reason: 'UNKNOWN_STAGE' });

    const same = await changeStage(id, { toStageCode: 'CONSULT_RESERVED', version: 0 });
    expect(same.status).toBe(400);
    expect(same.body.error.fieldErrors?.[0]).toMatchObject({ reason: 'SAME_STAGE' });
  });

  // ---------------------------------------------------------------------------
  // 품목별 완료 + 게이팅 (v2 D2)
  // ---------------------------------------------------------------------------

  it('GATED 단계는 전 품목 완료 전 전진을 422로 막고, 완료 후 전진한다', async () => {
    const { order } = await createOrderWithItems(ctx.prisma, customerId, adminId, 2);
    const created = await createJourney({ orderId: order.id });
    const id = created.body.data.id;
    // AUTO(CONSULT_RESERVED)에서 GATED(STYLE_CONSULTING)로 진입
    await changeStage(id, { toStageCode: 'STYLE_CONSULTING', version: 0 }).expect(201);

    // 대상 품목 조회 — 2건, 아직 미완료
    const items = await api(ctx)
      .get(`/api/v1/journeys/${id}/stages/STYLE_CONSULTING/items`)
      .set(auth(ctx))
      .expect(200);
    expect(items.body.data.items).toHaveLength(2);
    expect(items.body.data.gating).toMatchObject({ targetCount: 2, completedCount: 0, canComplete: false });

    // 미완료 상태 전진 → 422
    const blocked = await changeStage(id, { toStageCode: 'ORDER_REQUESTED', version: 1 });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('STAGE_NOT_COMPLETE');

    // 품목 1건 완료 — 아직 부족
    const t0 = items.body.data.items[0].targetId;
    const t1 = items.body.data.items[1].targetId;
    const c1 = await api(ctx)
      .post(`/api/v1/journeys/${id}/stages/STYLE_CONSULTING/items/${t0}/complete`)
      .set(auth(ctx))
      .send({})
      .expect(201);
    expect(c1.body.data.gating).toMatchObject({ completedCount: 1, canComplete: false });

    // 두 번째 완료 — canComplete=true
    const c2 = await api(ctx)
      .post(`/api/v1/journeys/${id}/stages/STYLE_CONSULTING/items/${t1}/complete`)
      .set(auth(ctx))
      .send({})
      .expect(201);
    expect(c2.body.data.gating).toMatchObject({ completedCount: 2, canComplete: true });

    // 이제 전진 성공, 비고 저장
    const advanced = await changeStage(id, {
      toStageCode: 'ORDER_REQUESTED',
      version: 1,
      notes: '전 품목 컨설팅 완료',
    }).expect(201);
    expect(advanced.body.data.journey.currentStageCode).toBe('ORDER_REQUESTED');
  });

  it('품목 완료는 멱등이고, 취소하면 게이팅이 다시 닫힌다', async () => {
    const { order } = await createOrderWithItems(ctx.prisma, customerId, adminId, 1);
    const created = await createJourney({ orderId: order.id });
    const id = created.body.data.id;
    await changeStage(id, { toStageCode: 'STYLE_CONSULTING', version: 0 }).expect(201);
    const items = await api(ctx)
      .get(`/api/v1/journeys/${id}/stages/STYLE_CONSULTING/items`)
      .set(auth(ctx))
      .expect(200);
    const t = items.body.data.items[0].targetId;
    const url = `/api/v1/journeys/${id}/stages/STYLE_CONSULTING/items/${t}`;

    await api(ctx).post(`${url}/complete`).set(auth(ctx)).send({}).expect(201);
    const again = await api(ctx).post(`${url}/complete`).set(auth(ctx)).send({}).expect(201);
    expect(again.body.data.gating).toMatchObject({ completedCount: 1, canComplete: true });

    const undone = await api(ctx).post(`${url}/uncomplete`).set(auth(ctx)).send({}).expect(201);
    expect(undone.body.data.gating).toMatchObject({ completedCount: 0, canComplete: false });
  });

  it('[전체 완료] 비고가 진행상태 출력(상태·완료일·비고)에 노출된다', async () => {
    const { order } = await createOrderWithItems(ctx.prisma, customerId, adminId, 1);
    const created = await createJourney({ orderId: order.id });
    const id = created.body.data.id;
    await changeStage(id, { toStageCode: 'STYLE_CONSULTING', version: 0 }).expect(201);
    const items = await api(ctx)
      .get(`/api/v1/journeys/${id}/stages/STYLE_CONSULTING/items`)
      .set(auth(ctx))
      .expect(200);
    const t = items.body.data.items[0].targetId;
    await api(ctx)
      .post(`/api/v1/journeys/${id}/stages/STYLE_CONSULTING/items/${t}/complete`)
      .set(auth(ctx))
      .send({})
      .expect(201);
    await changeStage(id, {
      toStageCode: 'ORDER_REQUESTED',
      version: 1,
      notes: '컨설팅 확정',
    }).expect(201);

    const detail = await api(ctx).get(`/api/v1/journeys/${id}`).set(auth(ctx)).expect(200);
    const style = detail.body.data.stages.find((s: { code: string }) => s.code === 'STYLE_CONSULTING');
    expect(style).toMatchObject({ completed: true, notes: '컨설팅 확정' });
    expect(style.completedAt).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // 연락 제안 (회귀)
  // ---------------------------------------------------------------------------

  it('연락 대상 단계에서는 치환된 문구와 멱등키를 제안한다', async () => {
    const { order } = await createOrderWithItems(ctx.prisma, customerId, adminId, 1);
    const created = await createJourney({ orderId: order.id });
    const res = await changeStage(created.body.data.id, {
      toStageCode: 'PRODUCT_RECEIVED',
      version: 0,
    }).expect(201);

    const s = res.body.data.suggestedNotification;
    expect(s).toMatchObject({
      templateCode: 'JOURNEY_PRODUCT_RECEIVED',
      // 단계 연락 템플릿은 벤더 승인 전(PENDING)이라 알림톡이 아닌 SMS로 나간다.
      channel: 'SMS',
      recipientPhone: '010-1111-2222',
      customerId,
      orderId: order.id,
      triggerKey: `journey:${created.body.data.id}:PRODUCT_RECEIVED`,
    });
    expect(s.renderedBody).toContain('정장 #1');
    expect(s.renderedBody).not.toContain('#{');
    expect(s.eventId).toBe(res.body.data.event.id);
  });

  it('발송 확인창의 처리 결과를 이력에 봉합한다', async () => {
    const created = await createJourney();
    const changed = await changeStage(created.body.data.id, {
      toStageCode: 'BASTING_RECEIVED',
      version: 0,
    }).expect(201);
    const eventId = changed.body.data.event.id;

    const deferred = await api(ctx)
      .post(`/api/v1/journeys/${created.body.data.id}/events/${eventId}/notification-outcome`)
      .set(auth(ctx))
      .send({ outcome: 'DEFERRED' })
      .expect(201);
    expect(deferred.body.data.notificationOutcome).toBe('DEFERRED');

    const missingHistory = await api(ctx)
      .post(`/api/v1/journeys/${created.body.data.id}/events/${eventId}/notification-outcome`)
      .set(auth(ctx))
      .send({ outcome: 'SENT' });
    expect(missingHistory.status).toBe(400);
    expect(missingHistory.body.error.fieldErrors?.[0]).toMatchObject({
      field: 'notificationHistoryId',
    });
  });

  it('상세에 단계 목록(8)과 변경 이력이 함께 담긴다', async () => {
    const created = await createJourney();
    const id = created.body.data.id;
    await changeStage(id, { toStageCode: 'CONTRACT_CONFIRMED', version: 0 }).expect(201);

    const res = await api(ctx).get(`/api/v1/journeys/${id}`).set(auth(ctx)).expect(200);
    expect(res.body.data.stages).toHaveLength(8);
    expect(res.body.data.stages[4]).toMatchObject({ code: 'BASTING_RECEIVED', hasTemplate: true });
    expect(res.body.data.events).toHaveLength(1);
    expect(res.body.data.events[0].toStageCode).toBe('CONTRACT_CONFIRMED');
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

    const blocked = await changeStage(id, { toStageCode: 'CONTRACT_CONFIRMED', version: 1 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('진행 현황을 단계로 거르고 머문 일수를 함께 돌려준다', async () => {
    const created = await createJourney();
    await changeStage(created.body.data.id, { toStageCode: 'STYLE_CONSULTING', version: 0 }).expect(201);

    const res = await api(ctx)
      .get('/api/v1/journeys?stageCodes=STYLE_CONSULTING')
      .set(auth(ctx))
      .expect(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(
      res.body.data.every((j: { currentStageCode: string }) => j.currentStageCode === 'STYLE_CONSULTING'),
    ).toBe(true);
    expect(res.body.data[0]).toHaveProperty('daysInStage');

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

  // ---------------------------------------------------------------------------
  // REPAIR 트랙 — 수선 진행 (설계서 02 §7.2·§9.2)
  // ---------------------------------------------------------------------------

  describe('REPAIR 트랙', () => {
    /** 수선 접수 → REPAIR 진행 자동생성. 접수건 id와 자동생성된 진행 id를 돌려준다. */
    async function createRepairJourney() {
      const repair = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({ customerId, repairType: 'GENERAL', requestDate: '2026-07-21', description: '바지 기장 수선' })
        .expect(201);
      const repairId = repair.body.data.id;
      const journey = await ctx.prisma.customerJourney.findFirstOrThrow({
        where: { sourceRepairRequestId: repairId },
      });
      return { repairId, journeyId: journey.id };
    }

    it('접수 자동완료 → 요청 단계 품목완료 → 게이팅 통과로 전진한다', async () => {
      const { repairId, journeyId } = await createRepairJourney();

      // AUTO(REPAIR_RECEIVED)에서 GATED(REPAIR_REQUESTED)로 게이팅 없이 진입
      await changeStage(journeyId, { toStageCode: 'REPAIR_REQUESTED', version: 0 }).expect(201);

      // 대상 = 그 수선요청 1건 (RepairRequest 1건 = journey 1건, 기본안)
      const items = await api(ctx)
        .get(`/api/v1/journeys/${journeyId}/stages/REPAIR_REQUESTED/items`)
        .set(auth(ctx))
        .expect(200);
      expect(items.body.data.items).toHaveLength(1);
      expect(items.body.data.items[0]).toMatchObject({ targetId: repairId, targetType: 'REPAIR_ITEM' });
      expect(items.body.data.gating).toMatchObject({ targetCount: 1, completedCount: 0, canComplete: false });

      // 미완료 전진 → 422
      const blocked = await changeStage(journeyId, { toStageCode: 'REPAIR_CHECKED_IN', version: 1 });
      expect(blocked.status).toBe(422);
      expect(blocked.body.error.code).toBe('STAGE_NOT_COMPLETE');

      // 수선요청 품목 완료 → 게이팅 개방
      const done = await api(ctx)
        .post(`/api/v1/journeys/${journeyId}/stages/REPAIR_REQUESTED/items/${repairId}/complete`)
        .set(auth(ctx))
        .send({})
        .expect(201);
      expect(done.body.data.gating).toMatchObject({ completedCount: 1, canComplete: true });

      // 전진 성공
      const advanced = await changeStage(journeyId, {
        toStageCode: 'REPAIR_CHECKED_IN',
        version: 1,
      }).expect(201);
      expect(advanced.body.data.journey.currentStageCode).toBe('REPAIR_CHECKED_IN');
      // D8 일원화(설계서 02 §8·§10.3 #5): 수선 고객 연락 제안은 이 진행(journey) 경로에서만 만든다.
      // repairs 상태변경 경로의 자동 제안은 제거됐다(repairs.spec.ts 참조).
      const s = advanced.body.data.suggestedNotification;
      expect(s).toMatchObject({
        templateCode: 'JOURNEY_REPAIR_CHECKED_IN',
        triggerKey: `journey:${journeyId}:REPAIR_CHECKED_IN`,
      });
    });

    /** 수선 입고 단계까지 전진시키고 그 단계의 연락 제안을 돌려준다. */
    async function advanceToCheckedIn() {
      const { repairId, journeyId } = await createRepairJourney();
      await changeStage(journeyId, { toStageCode: 'REPAIR_REQUESTED', version: 0 }).expect(201);
      await api(ctx)
        .post(`/api/v1/journeys/${journeyId}/stages/REPAIR_REQUESTED/items/${repairId}/complete`)
        .set(auth(ctx))
        .send({})
        .expect(201);
      const advanced = await changeStage(journeyId, {
        toStageCode: 'REPAIR_CHECKED_IN',
        version: 1,
      }).expect(201);
      return {
        repairId,
        journeyId,
        eventId: advanced.body.data.event.id,
        suggestion: advanced.body.data.suggestedNotification,
      };
    }

    /** 수선 상태를 흐름대로 목표 상태까지 밀어올린다. */
    async function pushRepairStatus(repairId: string, ...statuses: string[]) {
      for (const newStatus of statuses) {
        await api(ctx)
          .post(`/api/v1/repairs/${repairId}/status-events`)
          .set(auth(ctx))
          .send({ newStatus })
          .expect(201);
      }
    }

    it('수선 입고 안내를 발송하면 수선 상태가 고객 연락으로 함께 넘어간다', async () => {
      const { repairId, journeyId, eventId, suggestion } = await advanceToCheckedIn();
      // 진행과 별개로 수선 건은 6단계 흐름을 따라 '수선 입고'까지 와 있다.
      await pushRepairStatus(repairId, 'REQUESTED', 'IN_PROGRESS', 'RETURNED_TO_SHOP');

      const sent = await api(ctx)
        .post('/api/v1/notifications/send')
        .set(auth(ctx))
        .send({
          templateId: suggestion.templateId,
          customerId: suggestion.customerId,
          variables: suggestion.variables,
          triggerKey: suggestion.triggerKey,
        })
        .expect(201);

      await api(ctx)
        .post(`/api/v1/journeys/${journeyId}/events/${eventId}/notification-outcome`)
        .set(auth(ctx))
        .send({ outcome: 'SENT', notificationHistoryId: sent.body.data.id })
        .expect(201);

      // 담당자가 수선 화면에서 '고객 연락'을 또 누르지 않아도 상태가 옮겨진다.
      const repair = await api(ctx).get(`/api/v1/repairs/${repairId}`).set(auth(ctx)).expect(200);
      expect(repair.body.data.status).toBe('CUSTOMER_NOTIFIED');
      // 이력에도 남는다 — 누가·언제 옮겼는지 추적 가능해야 한다.
      expect(repair.body.data.statusEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            previousStatus: 'RETURNED_TO_SHOP',
            newStatus: 'CUSTOMER_NOTIFIED',
          }),
        ]),
      );
    });

    it('수선 입고 전이거나 발송하지 않았으면 수선 상태를 건드리지 않는다', async () => {
      // (1) 발송하지 않고 보류 → 상태 유지
      const deferredCase = await advanceToCheckedIn();
      await pushRepairStatus(deferredCase.repairId, 'REQUESTED', 'IN_PROGRESS', 'RETURNED_TO_SHOP');
      await api(ctx)
        .post(`/api/v1/journeys/${deferredCase.journeyId}/events/${deferredCase.eventId}/notification-outcome`)
        .set(auth(ctx))
        .send({ outcome: 'DEFERRED' })
        .expect(201);
      const deferred = await api(ctx)
        .get(`/api/v1/repairs/${deferredCase.repairId}`)
        .set(auth(ctx))
        .expect(200);
      expect(deferred.body.data.status).toBe('RETURNED_TO_SHOP');

      // (2) 보냈지만 수선 건이 아직 '수선 중' → 한 칸씩 전진 규칙을 깨지 않도록 건너뛴다
      const earlyCase = await advanceToCheckedIn();
      await pushRepairStatus(earlyCase.repairId, 'REQUESTED', 'IN_PROGRESS');
      const sent = await api(ctx)
        .post('/api/v1/notifications/send')
        .set(auth(ctx))
        .send({
          templateId: earlyCase.suggestion.templateId,
          customerId: earlyCase.suggestion.customerId,
          variables: earlyCase.suggestion.variables,
          triggerKey: earlyCase.suggestion.triggerKey,
        })
        .expect(201);
      await api(ctx)
        .post(`/api/v1/journeys/${earlyCase.journeyId}/events/${earlyCase.eventId}/notification-outcome`)
        .set(auth(ctx))
        .send({ outcome: 'SENT', notificationHistoryId: sent.body.data.id })
        .expect(201);
      const early = await api(ctx)
        .get(`/api/v1/repairs/${earlyCase.repairId}`)
        .set(auth(ctx))
        .expect(200);
      expect(early.body.data.status).toBe('IN_PROGRESS');
    });

    it('상세 응답의 REPAIR_ITEMS 단계에도 게이팅 대상이 해석된다 (4단계)', async () => {
      const { journeyId } = await createRepairJourney();
      const detail = await api(ctx).get(`/api/v1/journeys/${journeyId}`).set(auth(ctx)).expect(200);
      expect(detail.body.data.stages).toHaveLength(4);
      const requested = detail.body.data.stages.find((s: { code: string }) => s.code === 'REPAIR_REQUESTED');
      expect(requested).toMatchObject({ targetCount: 1, completedCount: 0, canComplete: false });
    });
  });

  // ---------------------------------------------------------------------------
  // CONSULT_RESERVED 자동종료 지연평가 힌트 (설계서 02 §9.2·§10.3)
  // ---------------------------------------------------------------------------

  describe('CONSULT_RESERVED 자동종료(expired) 힌트', () => {
    it('예약 후 임계 일수가 지나고 계약이 없으면 expired 힌트가 붙는다 (get·list)', async () => {
      const created = await createJourney(); // CONSULT_RESERVED, orderId 없음
      const id = created.body.data.id;

      // 최근 시작 → 아직 만료 아님
      const fresh = await api(ctx).get(`/api/v1/journeys/${id}`).set(auth(ctx)).expect(200);
      expect(fresh.body.data.expired).toBe(false);

      // 예약(시작)일을 임계 일수 이전으로 되돌려 지연평가를 시뮬레이션한다.
      await ctx.prisma.customerJourney.update({
        where: { id },
        data: { startedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      });
      const stale = await api(ctx).get(`/api/v1/journeys/${id}`).set(auth(ctx)).expect(200);
      expect(stale.body.data.expired).toBe(true);

      const list = await api(ctx)
        .get(`/api/v1/journeys?customerId=${customerId}&stageCodes=CONSULT_RESERVED`)
        .set(auth(ctx))
        .expect(200);
      const listed = list.body.data.find((j: { id: string }) => j.id === id);
      expect(listed.expired).toBe(true);
    });

    it('계약(주문)이 연결되면 오래되어도 만료로 보지 않는다', async () => {
      const { order } = await createOrderWithItems(ctx.prisma, customerId, adminId, 1);
      const created = await createJourney({ orderId: order.id });
      const id = created.body.data.id;
      await ctx.prisma.customerJourney.update({
        where: { id },
        data: { startedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      });
      const detail = await api(ctx).get(`/api/v1/journeys/${id}`).set(auth(ctx)).expect(200);
      expect(detail.body.data.expired).toBe(false);
    });
  });
});
