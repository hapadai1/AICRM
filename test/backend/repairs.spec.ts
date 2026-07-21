import { randomUUID } from 'crypto';
import { RepairsModule } from '../../backend/src/modules/repairs/repairs.module';
import { PrismaService } from '../../backend/src/prisma/prisma.service';
import { api, auth, createTestContext, TestContext, truncateBusinessData } from './helpers';

/** 수선 테스트용 최소 데이터: 고객·맞춤 품목(+구성품)·렌탈 실물 */
async function seedRepairTargets(prisma: PrismaService) {
  const admin = await prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
  const suffix = randomUUID().slice(0, 8);
  const customer = await prisma.customer.create({
    data: {
      id: randomUUID(),
      name: `수선고객-${suffix}`,
      phone: '010-9876-5432',
      phoneNormalized: `${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(0, 20),
    },
  });
  const contract = await prisma.contract.create({
    data: { id: randomUUID(), contractNo: `CTR-${suffix}`, customerId: customer.id, status: 'CONFIRMED' },
  });
  const version = await prisma.contractVersion.create({
    data: { id: randomUUID(), contractId: contract.id, versionNo: 1, createdBy: admin.id },
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
    data: { id: randomUUID(), orderNo: `ORD-${suffix}`, contractId: contract.id, transactionType: 'CUSTOM' },
  });
  const item = await prisma.orderItem.create({
    data: {
      id: randomUUID(),
      orderId: order.id,
      sourceContractLineId: line.id,
      productCategory: 'SUIT',
      sequenceNo: 1,
      displayName: '정장 #1',
      status: 'RELEASED',
    },
  });
  const component = await prisma.orderItemComponent.create({
    data: {
      id: randomUUID(),
      orderItemId: item.id,
      componentType: 'JACKET',
      sequenceNo: 1,
      status: 'RELEASED',
    },
  });
  const sku = await prisma.rentalSku.create({
    data: {
      id: randomUUID(),
      componentType: 'JACKET',
      design: '클래식',
      color: '네이비',
      size: '100',
    },
  });
  const rentalItem = await prisma.rentalInventoryItem.create({
    data: { id: randomUUID(), managementCode: `JKT-${suffix}`, rentalSkuId: sku.id, status: 'AVAILABLE' },
  });
  return { admin, customer, line, order, item, component, rentalItem };
}

describe('수선 (RepairsModule)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext([RepairsModule]);
    await truncateBusinessData(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  /** 상태 흐름·연락 제안 테스트가 공유하는 일반 수선 1건 생성 */
  async function createGeneralRepair(customerId: string): Promise<string> {
    const res = await api(ctx)
      .post('/api/v1/repairs')
      .set(auth(ctx))
      .send({ customerId, repairType: 'GENERAL', requestDate: '2026-07-21', description: '수선 흐름 테스트' })
      .expect(201);
    return res.body.data.id;
  }

  describe('수선 접수 — 유형별 연결 검증', () => {
    it('CUSTOM 수선은 품목·구성품 연결 없이는 접수할 수 없다', async () => {
      const { customer } = await seedRepairTargets(ctx.prisma);
      const res = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({
          customerId: customer.id,
          repairType: 'CUSTOM_DURING',
          requestDate: '2026-07-21',
          description: '소매 수선',
        })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('CUSTOM 수선은 구성품 연결 시 품목·주문이 자동 연결된다', async () => {
      const { customer, order, item, component } = await seedRepairTargets(ctx.prisma);
      const res = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({
          customerId: customer.id,
          repairType: 'AFTER_SALE',
          requestDate: '2026-07-21',
          dueDate: '2026-07-30',
          description: '자켓 소매 길이 수선',
          componentId: component.id,
          cost: 30000,
        })
        .expect(201);
      expect(res.body.data.status).toBe('RECEIVED');
      expect(res.body.data.component.id).toBe(component.id);
      expect(res.body.data.orderItem.id).toBe(item.id);
      expect(res.body.data.order.id).toBe(order.id);
      // 접수 시 초기 상태 이벤트 생성
      expect(res.body.data.statusEvents.length).toBe(1);
      expect(res.body.data.statusEvents[0].newStatus).toBe('RECEIVED');
    });

    it('CUSTOM 수선에 렌탈 실물을 연결하면 거부된다', async () => {
      const { customer, item, rentalItem } = await seedRepairTargets(ctx.prisma);
      const res = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({
          customerId: customer.id,
          repairType: 'CUSTOM_DURING',
          requestDate: '2026-07-21',
          description: '수선',
          orderItemId: item.id,
          rentalInventoryItemId: rentalItem.id,
        })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('RENTAL 수선은 렌탈 실물 연결이 필수다', async () => {
      const { customer, rentalItem } = await seedRepairTargets(ctx.prisma);
      const missing = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({
          customerId: customer.id,
          repairType: 'RENTAL_PRE',
          requestDate: '2026-07-21',
          description: '단추 교체',
        })
        .expect(400);
      expect(missing.body.error.code).toBe('VALIDATION_ERROR');

      const ok = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({
          customerId: customer.id,
          repairType: 'RENTAL_PRE',
          requestDate: '2026-07-21',
          description: '단추 교체',
          rentalInventoryItemId: rentalItem.id,
        })
        .expect(201);
      expect(ok.body.data.rentalInventoryItem.id).toBe(rentalItem.id);
      expect(ok.body.data.orderItem).toBeNull();
    });

    it('GENERAL 수선은 고객만 연결하고 다른 대상 연결은 거부된다', async () => {
      const { customer, item } = await seedRepairTargets(ctx.prisma);
      const linked = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({
          customerId: customer.id,
          repairType: 'GENERAL',
          requestDate: '2026-07-21',
          description: '외부 구입 자켓 수선',
          orderItemId: item.id,
        })
        .expect(400);
      expect(linked.body.error.code).toBe('VALIDATION_ERROR');

      const ok = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({
          customerId: customer.id,
          repairType: 'GENERAL',
          requestDate: '2026-07-21',
          description: '외부 구입 자켓 소매 수선',
        })
        .expect(201);
      expect(ok.body.data.customer.id).toBe(customer.id);
      expect(ok.body.data.orderItem).toBeNull();
      expect(ok.body.data.rentalInventoryItem).toBeNull();
    });

    it('GENERAL 수선은 대상 설명(description)이 필수다', async () => {
      const { customer } = await seedRepairTargets(ctx.prisma);
      const res = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({ customerId: customer.id, repairType: 'GENERAL', requestDate: '2026-07-21' })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('수선 상태 흐름', () => {

    it('접수→요청→진행→입고→연락→출고 순서로만 진행된다', async () => {
      const { customer } = await seedRepairTargets(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);

      // 단계 건너뛰기 차단
      const skip = await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'IN_PROGRESS' })
        .expect(409);
      expect(skip.body.error.code).toBe('INVALID_STATUS_TRANSITION');

      for (const status of ['REQUESTED', 'IN_PROGRESS', 'RETURNED_TO_SHOP', 'CUSTOMER_NOTIFIED', 'RELEASED']) {
        const res = await api(ctx)
          .post(`/api/v1/repairs/${repairId}/status-events`)
          .set(auth(ctx))
          .send({ newStatus: status, eventDate: '2026-07-22' })
          .expect(201);
        expect(res.body.data.newStatus).toBe(status);
      }

      // 출고 완료 후 추가 전이 불가
      const after = await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'REQUESTED' })
        .expect(409);
      expect(after.body.error.code).toBe('INVALID_STATUS_TRANSITION');

      const detail = await api(ctx).get(`/api/v1/repairs/${repairId}`).set(auth(ctx)).expect(200);
      expect(detail.body.data.status).toBe('RELEASED');
      expect(detail.body.data.statusEvents.length).toBe(6); // 접수 + 5회 전이
    });

    it('CANCELLED는 어느 상태에서든 가능하고 이후 전이는 차단된다', async () => {
      const { customer } = await seedRepairTargets(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);
      await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'REQUESTED' })
        .expect(201);
      await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'CANCELLED', notes: '고객 취소' })
        .expect(201);
      const res = await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'IN_PROGRESS' })
        .expect(409);
      expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('상태 변경 시 감사로그가 남는다', async () => {
      const { customer } = await seedRepairTargets(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);
      await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'REQUESTED' })
        .expect(201);
      const logs = await ctx.prisma.auditLog.findMany({
        where: { entityType: 'REPAIR_REQUEST', entityId: repairId, action: 'STATUS_CHANGE' },
      });
      expect(logs.length).toBe(1);
    });
  });

  describe('수선 목록·수정', () => {
    it('상태·고객 필터로 페이지네이션 목록을 조회한다', async () => {
      const { customer, rentalItem } = await seedRepairTargets(ctx.prisma);
      await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({
          customerId: customer.id,
          repairType: 'RENTAL_POST',
          requestDate: '2026-07-21',
          description: '반납 후 얼룩 제거',
          rentalInventoryItemId: rentalItem.id,
        })
        .expect(201);

      const res = await api(ctx)
        .get(`/api/v1/repairs?status=RECEIVED&customerId=${customer.id}&page=1&size=10`)
        .set(auth(ctx))
        .expect(200);
      expect(res.body.page.totalElements).toBe(1);
      expect(res.body.data[0].customer.id).toBe(customer.id);
      expect(res.body.data[0].status).toBe('RECEIVED');

      const none = await api(ctx)
        .get(`/api/v1/repairs?status=RELEASED&customerId=${customer.id}`)
        .set(auth(ctx))
        .expect(200);
      expect(none.body.page.totalElements).toBe(0);
    });

    it('PATCH로 완료예정일·비용·내용을 수정한다', async () => {
      const { customer } = await seedRepairTargets(ctx.prisma);
      const created = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({ customerId: customer.id, repairType: 'GENERAL', requestDate: '2026-07-21', description: '수선' })
        .expect(201);

      const res = await api(ctx)
        .patch(`/api/v1/repairs/${created.body.data.id}`)
        .set(auth(ctx))
        .send({ dueDate: '2026-08-05', cost: 15000, description: '바지 기장 수선', notes: '급행' })
        .expect(200);
      expect(res.body.data.description).toBe('바지 기장 수선');
      expect(Number(res.body.data.cost)).toBe(15000);
      expect(res.body.data.dueDate).toContain('2026-08-05');
      expect(res.body.data.notes).toBe('급행');
    });

    it('없는 수선 요청 조회는 404', async () => {
      const res = await api(ctx).get(`/api/v1/repairs/${randomUUID()}`).set(auth(ctx)).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('연결 대상 조회 (link-targets, 연동정합화 계약 §8)', () => {
    it('고객의 맞춤 품목(구성품 포함)과 렌탈 실물 요약을 반환한다', async () => {
      const { admin, customer, line, order, item, component, rentalItem } = await seedRepairTargets(ctx.prisma);

      // 고객 렌탈 주문·구성품·배정 → 렌탈 실물 연결
      const rentalOrder = await ctx.prisma.order.create({
        data: {
          id: randomUUID(),
          orderNo: `${order.orderNo}-R`,
          contractId: order.contractId,
          transactionType: 'RENTAL',
        },
      });
      const rentalOrderItem = await ctx.prisma.orderItem.create({
        data: {
          id: randomUUID(),
          orderId: rentalOrder.id,
          sourceContractLineId: line.id,
          productCategory: 'SUIT',
          sequenceNo: 1,
          displayName: '렌탈 정장 #1',
        },
      });
      const rentalComponent = await ctx.prisma.orderItemComponent.create({
        data: { id: randomUUID(), orderItemId: rentalOrderItem.id, componentType: 'JACKET' },
      });
      await ctx.prisma.rentalAllocation.create({
        data: {
          id: randomUUID(),
          orderItemComponentId: rentalComponent.id,
          rentalInventoryItemId: rentalItem.id,
          pickupDate: new Date('2026-08-01'),
          returnDueDate: new Date('2026-08-03'),
          availabilityEndDate: new Date('2026-08-05'),
          status: 'RESERVED',
          assignedBy: admin.id,
          assignedAt: new Date(),
        },
      });

      const res = await api(ctx)
        .get(`/api/v1/repairs/link-targets?customerId=${customer.id}`)
        .set(auth(ctx))
        .expect(200);

      // 맞춤(CUSTOM) 주문 품목만 포함 — 렌탈 주문 품목은 제외
      expect(res.body.data.orderItems.map((i: { id: string }) => i.id)).toEqual([item.id]);
      const target = res.body.data.orderItems[0];
      expect(target.displayName).toBe('정장 #1');
      expect(target.orderNo).toBe(order.orderNo);
      expect(target.components.map((c: { id: string }) => c.id)).toEqual([component.id]);
      expect(target.components[0].componentType).toBe('JACKET');

      // 고객 배정 이력이 있는 렌탈 실물 요약
      expect(res.body.data.rentalItems.length).toBe(1);
      expect(res.body.data.rentalItems[0]).toMatchObject({
        id: rentalItem.id,
        managementCode: rentalItem.managementCode,
        componentType: 'JACKET',
        design: '클래식',
        allocationStatus: 'RESERVED',
      });
    });

    it('다른 고객의 대상은 포함하지 않고, 없는 고객은 404', async () => {
      const { customer, item } = await seedRepairTargets(ctx.prisma);
      const res = await api(ctx)
        .get(`/api/v1/repairs/link-targets?customerId=${customer.id}`)
        .set(auth(ctx))
        .expect(200);
      expect(res.body.data.orderItems.map((i: { id: string }) => i.id)).toEqual([item.id]);
      expect(res.body.data.rentalItems).toEqual([]); // 배정 이력 없는 렌탈 실물은 제외

      const notFound = await api(ctx)
        .get(`/api/v1/repairs/link-targets?customerId=${randomUUID()}`)
        .set(auth(ctx))
        .expect(404);
      expect(notFound.body.error.code).toBe('CUSTOMER_NOT_FOUND');

      // customerId 누락은 400 (:id 라우트로 오인되지 않는다)
      await api(ctx).get('/api/v1/repairs/link-targets').set(auth(ctx)).expect(400);
    });
  });
  /** 개발설계서 05 G-06 — 상태를 바꾸면 문구를 준비해 확인창 재료로 돌려준다. */
  describe('고객 연락 제안', () => {
    it('연락 대상 상태에서만 치환된 문구와 멱등키를 제안한다', async () => {
      const { customer } = await seedRepairTargets(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);

      // 접수(RECEIVED)는 생성 시점 상태다. 다음 전이 REQUESTED는 연락 대상이 아니다.
      const notTarget = await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'REQUESTED' })
        .expect(201);
      expect(notTarget.body.data.suggestedNotification).toBeNull();

      for (const status of ['IN_PROGRESS', 'RETURNED_TO_SHOP']) {
        await api(ctx)
          .post(`/api/v1/repairs/${repairId}/status-events`)
          .set(auth(ctx))
          .send({ newStatus: status })
          .expect(201);
      }

      const target = await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'CUSTOMER_NOTIFIED' })
        .expect(201);

      const s = target.body.data.suggestedNotification;
      expect(s).toMatchObject({
        templateCode: 'REPAIR_READY_NOTICE',
        channel: 'ALIMTALK',
        recipientPhone: customer.phone,
        customerId: customer.id,
        triggerKey: `repair:${repairId}:CUSTOMER_NOTIFIED`,
      });
      expect(s.renderedBody).toContain(customer.name);
      expect(s.renderedBody).not.toContain('#{');
      // 기존 응답 필드는 그대로 유지된다(하위호환).
      expect(target.body.data.newStatus).toBe('CUSTOMER_NOTIFIED');
    });

    it('연결된 규칙이 없으면 제안하지 않는다 (기존 동작 유지)', async () => {
      const { customer } = await seedRepairTargets(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);
      // 규칙을 끄면 연락 대상 상태여도 제안이 없어야 한다.
      await ctx.prisma.notificationRule.updateMany({
        where: { triggerType: 'REPAIR:CUSTOMER_NOTIFIED' },
        data: { active: false },
      });

      for (const status of ['REQUESTED', 'IN_PROGRESS', 'RETURNED_TO_SHOP']) {
        await api(ctx)
          .post(`/api/v1/repairs/${repairId}/status-events`)
          .set(auth(ctx))
          .send({ newStatus: status })
          .expect(201);
      }
      const res = await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'CUSTOMER_NOTIFIED' })
        .expect(201);
      expect(res.body.data.suggestedNotification).toBeNull();

      await ctx.prisma.notificationRule.updateMany({
        where: { triggerType: 'REPAIR:CUSTOMER_NOTIFIED' },
        data: { active: true },
      });
    });
  });
});
