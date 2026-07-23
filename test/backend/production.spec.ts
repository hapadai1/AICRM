import { randomUUID } from 'crypto';
import { ProductionModule } from '../../backend/src/modules/production/production.module';
import { PrismaService } from '../../backend/src/prisma/prisma.service';
import { api, auth, createTestContext, TestContext, truncateBusinessData } from './helpers';

/** 제작 테스트용 최소 데이터: 고객→계약→버전→라인→주문→품목(+구성품) */
async function seedOrderItem(
  prisma: PrismaService,
  opts: { itemStatus?: string; components?: { componentType: string; status?: string }[] } = {},
) {
  const admin = await prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
  const suffix = randomUUID().slice(0, 8);
  const customer = await prisma.customer.create({
    data: {
      id: randomUUID(),
      name: `제작고객-${suffix}`,
      phone: '010-1234-5678',
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
      status: opts.itemStatus ?? 'PRODUCTION_COMPLETED',
    },
  });
  const componentSpecs = opts.components ?? [
    { componentType: 'JACKET', status: 'PRODUCTION_COMPLETED' },
    { componentType: 'TROUSERS', status: 'PRODUCTION_COMPLETED' },
  ];
  const components = [];
  for (let i = 0; i < componentSpecs.length; i++) {
    components.push(
      await prisma.orderItemComponent.create({
        data: {
          id: randomUUID(),
          orderItemId: item.id,
          componentType: componentSpecs[i].componentType,
          sequenceNo: i + 1,
          status: componentSpecs[i].status ?? 'PRODUCTION_COMPLETED',
        },
      }),
    );
  }
  return { admin, customer, contract, order, item, components };
}

describe('제작 상태·부분 입출고·가봉 (ProductionModule)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext([ProductionModule]);
    await truncateBusinessData(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe('구성품 입고·품목 집계', () => {
    it('상의만 입고하면 품목이 PARTIALLY_RECEIVED, 전체 입고하면 RECEIVED가 된다', async () => {
      const { item, components } = await seedOrderItem(ctx.prisma);
      const [jacket, trousers] = components;

      const res1 = await api(ctx)
        .post(`/api/v1/components/${jacket.id}/receive`)
        .set(auth(ctx))
        .send({ receivedAt: '2026-07-20' })
        .expect(201);
      expect(res1.body.data.component.status).toBe('RECEIVED');
      expect(res1.body.data.component.actualInboundAt).toBeTruthy();
      expect(res1.body.data.orderItemStatus).toBe('PARTIALLY_RECEIVED');

      const partial = await ctx.prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(partial.status).toBe('PARTIALLY_RECEIVED');

      const res2 = await api(ctx)
        .post(`/api/v1/components/${trousers.id}/receive`)
        .set(auth(ctx))
        .send({})
        .expect(201);
      expect(res2.body.data.orderItemStatus).toBe('RECEIVED');

      const full = await ctx.prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(full.status).toBe('RECEIVED');
    });

    it('이미 입고된 구성품 재입고는 INVALID_STATUS_TRANSITION', async () => {
      const { components } = await seedOrderItem(ctx.prisma);
      await api(ctx).post(`/api/v1/components/${components[0].id}/receive`).set(auth(ctx)).send({}).expect(201);
      const res = await api(ctx)
        .post(`/api/v1/components/${components[0].id}/receive`)
        .set(auth(ctx))
        .send({})
        .expect(409);
      expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    });
  });

  describe('구성품 출고·품목 집계', () => {
    it('미입고 구성품 출고는 차단된다 (INVALID_STATUS_TRANSITION)', async () => {
      const { components } = await seedOrderItem(ctx.prisma);
      const res = await api(ctx)
        .post(`/api/v1/components/${components[0].id}/release`)
        .set(auth(ctx))
        .send({})
        .expect(409);
      expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('일부 출고 시 PARTIALLY_RELEASED, 전체 출고 시 RELEASED로 집계된다', async () => {
      const { item, components } = await seedOrderItem(ctx.prisma);
      const [jacket, trousers] = components;
      await api(ctx).post(`/api/v1/components/${jacket.id}/receive`).set(auth(ctx)).send({}).expect(201);
      await api(ctx).post(`/api/v1/components/${trousers.id}/receive`).set(auth(ctx)).send({}).expect(201);

      const res1 = await api(ctx)
        .post(`/api/v1/components/${jacket.id}/release`)
        .set(auth(ctx))
        .send({ releasedAt: '2026-07-21' })
        .expect(201);
      expect(res1.body.data.component.status).toBe('RELEASED');
      expect(res1.body.data.component.actualOutboundAt).toBeTruthy();
      expect(res1.body.data.orderItemStatus).toBe('PARTIALLY_RELEASED');

      await api(ctx).post(`/api/v1/components/${trousers.id}/release`).set(auth(ctx)).send({}).expect(201);
      const full = await ctx.prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(full.status).toBe('RELEASED');
    });
  });

  describe('상태 전이 검증', () => {
    it('허용되지 않은 전이(동일 상태 재설정)는 INVALID_STATUS_TRANSITION', async () => {
      const { item } = await seedOrderItem(ctx.prisma);
      const res = await api(ctx)
        .post(`/api/v1/order-items/${item.id}/production-events`)
        .set(auth(ctx))
        .send({ newStatus: 'PRODUCTION_COMPLETED' })
        .expect(409);
      expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('취소된 품목은 상태를 변경할 수 없다', async () => {
      const { item } = await seedOrderItem(ctx.prisma, { itemStatus: 'CANCELLED' });
      const res = await api(ctx)
        .post(`/api/v1/order-items/${item.id}/production-events`)
        .set(auth(ctx))
        .send({ newStatus: 'PRODUCTION_IN_PROGRESS' })
        .expect(409);
      expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('집계 전용 상태(PARTIALLY_RECEIVED)는 품목 이벤트로 직접 설정할 수 없다', async () => {
      const { item } = await seedOrderItem(ctx.prisma);
      const res = await api(ctx)
        .post(`/api/v1/order-items/${item.id}/production-events`)
        .set(auth(ctx))
        .send({ newStatus: 'PARTIALLY_RECEIVED' })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('상태 역행은 사유 없이는 거부되고, 사유가 있으면 허용된다', async () => {
      const { item } = await seedOrderItem(ctx.prisma);
      const noReason = await api(ctx)
        .post(`/api/v1/order-items/${item.id}/production-events`)
        .set(auth(ctx))
        .send({ newStatus: 'PRODUCTION_IN_PROGRESS' })
        .expect(400);
      expect(noReason.body.error.code).toBe('VALIDATION_ERROR');

      const withReason = await api(ctx)
        .post(`/api/v1/order-items/${item.id}/production-events`)
        .set(auth(ctx))
        .send({ newStatus: 'PRODUCTION_IN_PROGRESS', reason: '공장 재작업 요청' })
        .expect(201);
      expect(withReason.body.data.previousStatus).toBe('PRODUCTION_COMPLETED');
      expect(withReason.body.data.newStatus).toBe('PRODUCTION_IN_PROGRESS');

      const after = await ctx.prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(after.status).toBe('PRODUCTION_IN_PROGRESS');
    });

    it('구성품 역행도 사유가 필요하다', async () => {
      const { components } = await seedOrderItem(ctx.prisma);
      const res = await api(ctx)
        .post(`/api/v1/components/${components[0].id}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'PRODUCTION_IN_PROGRESS' })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      await api(ctx)
        .post(`/api/v1/components/${components[0].id}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'PRODUCTION_IN_PROGRESS', reason: '가봉 수정 재제작' })
        .expect(201);
    });

    it('품목 순방향 전이는 허용되고 감사로그가 남는다', async () => {
      const { item } = await seedOrderItem(ctx.prisma, { itemStatus: 'READY_TO_ORDER' });
      await api(ctx)
        .post(`/api/v1/order-items/${item.id}/production-events`)
        .set(auth(ctx))
        .send({ newStatus: 'PRODUCTION_REQUESTED', eventDate: '2026-07-21', expectedDate: '2026-08-15' })
        .expect(201);
      const logs = await ctx.prisma.auditLog.findMany({
        where: { entityType: 'ORDER_ITEM', entityId: item.id, action: 'STATUS_CHANGE' },
      });
      expect(logs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('제작 이력·현황', () => {
    it('주문 제작 이력 타임라인을 반환한다', async () => {
      const { order, components } = await seedOrderItem(ctx.prisma);
      await api(ctx).post(`/api/v1/components/${components[0].id}/receive`).set(auth(ctx)).send({}).expect(201);

      const res = await api(ctx).get(`/api/v1/orders/${order.id}/production-history`).set(auth(ctx)).expect(200);
      expect(res.body.data.order.orderNo).toBe(order.orderNo);
      const types = res.body.data.events.map((e: { eventType: string }) => e.eventType);
      expect(types).toContain('RECEIVED');
      expect(types).toContain('ITEM_STATUS_AGGREGATED');
    });

    it('제작 현황 목록을 상태 필터와 페이지네이션으로 조회한다', async () => {
      const { item, components } = await seedOrderItem(ctx.prisma);
      await api(ctx).post(`/api/v1/components/${components[0].id}/receive`).set(auth(ctx)).send({}).expect(201);

      const res = await api(ctx)
        .get('/api/v1/production/items?status=PARTIALLY_RECEIVED&page=1&size=10')
        .set(auth(ctx))
        .expect(200);
      expect(res.body.page).toBeDefined();
      const found = res.body.data.find((i: { id: string }) => i.id === item.id);
      expect(found).toBeDefined();
      expect(found.status).toBe('PARTIALLY_RECEIVED');
      expect(found.components.length).toBe(2);
      expect(found.order.contract.customer.name).toBeTruthy();
      // 작업지시서 통합: 제작 목록 행에 작업지시서 뷰가 함께 온다 (제작 관리 코크핏용)
      expect(found.workOrder).toBeDefined();
      expect(['WAITING', 'UNORDERED', 'REPRINT_NEEDED', 'CURRENT']).toContain(found.workOrder.status);
      expect(typeof found.workOrder.canIssue).toBe('boolean');
    });
  });

  describe('가봉', () => {
    it('가봉 세션과 보정 목록을 저장하고 조회한다', async () => {
      const { item, components } = await seedOrderItem(ctx.prisma, { itemStatus: 'BASTING_RECEIVED' });
      const res = await api(ctx)
        .post(`/api/v1/order-items/${item.id}/fittings`)
        .set(auth(ctx))
        .send({
          fittingDate: '2026-07-21',
          notes: '전체 실루엣 양호',
          nextAppointmentDate: '2026-08-01',
          adjustments: [
            { componentId: components[0].id, area: '소매', instruction: '소매 길이 1cm 줄임' },
            { area: '허리', instruction: '허리 0.5cm 늘림' },
          ],
        })
        .expect(201);
      expect(res.body.data.adjustments.length).toBe(2);

      const list = await api(ctx).get(`/api/v1/order-items/${item.id}/fittings`).set(auth(ctx)).expect(200);
      expect(list.body.data.length).toBe(1);
      expect(list.body.data[0].nextAppointmentDate).toContain('2026-08-01');
      expect(list.body.data[0].adjustments.length).toBe(2);
    });

    it('다른 품목의 구성품으로 보정을 등록하면 VALIDATION_ERROR', async () => {
      const { item } = await seedOrderItem(ctx.prisma);
      const other = await seedOrderItem(ctx.prisma);
      const res = await api(ctx)
        .post(`/api/v1/order-items/${item.id}/fittings`)
        .set(auth(ctx))
        .send({
          fittingDate: '2026-07-21',
          adjustments: [{ componentId: other.components[0].id, area: '소매', instruction: '수선' }],
        })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
    /** 개발설계서 05 G-04 — 설계 PDF 1페이지 "실루엣·균형·여유분·길이 확인" */
    it('4대 표준 항목 기재 여부를 알려주되 막지는 않는다', async () => {
      const { item, components } = await seedOrderItem(ctx.prisma, {
        itemStatus: 'BASTING_RECEIVED',
      });
      const res = await api(ctx)
        .post(`/api/v1/order-items/${item.id}/fittings`)
        .set(auth(ctx))
        .send({
          fittingDate: '2026-07-21',
          adjustments: [
            {
              componentId: components[0].id,
              areaCode: 'LENGTH',
              area: '소매',
              instruction: '1cm 줄임',
            },
            { areaCode: 'BALANCE', area: '어깨', instruction: '좌우 균형 보정' },
            // 항목을 지정하지 않으면 기타로 저장된다.
            { area: '기타', instruction: '단추 위치 확인' },
          ],
        })
        .expect(201);

      // 일부만 기재해도 접수된다. 무엇이 빠졌는지만 알려준다.
      expect(res.body.data.coverage).toEqual({
        SILHOUETTE: false,
        BALANCE: true,
        EASE: false,
        LENGTH: true,
      });
      const codes = res.body.data.adjustments.map((a: { areaCode: string }) => a.areaCode);
      expect(codes).toContain('ETC');

      const list = await api(ctx)
        .get(`/api/v1/order-items/${item.id}/fittings`)
        .set(auth(ctx))
        .expect(200);
      expect(list.body.data[0].coverage.LENGTH).toBe(true);
    });

    it('허용하지 않은 확인 항목 코드는 거부한다', async () => {
      const { item } = await seedOrderItem(ctx.prisma);
      await api(ctx)
        .post(`/api/v1/order-items/${item.id}/fittings`)
        .set(auth(ctx))
        .send({
          fittingDate: '2026-07-21',
          adjustments: [{ areaCode: 'COLOR', area: '색상', instruction: '변경' }],
        })
        .expect(400);
    });

    it('가봉 수정지시서 Excel을 내려받는다 (공장에 메일로 첨부할 문서)', async () => {
      const { item, components } = await seedOrderItem(ctx.prisma, {
        itemStatus: 'BASTING_RECEIVED',
      });
      const created = await api(ctx)
        .post(`/api/v1/order-items/${item.id}/fittings`)
        .set(auth(ctx))
        .send({
          fittingDate: '2026-07-21',
          adjustments: [
            {
              componentId: components[0].id,
              areaCode: 'EASE',
              area: '가슴',
              instruction: '여유분 1cm 추가',
            },
          ],
        })
        .expect(201);

      const res = await api(ctx)
        .get(`/api/v1/fittings/${created.body.data.id}/sheet`)
        .set(auth(ctx))
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers['content-type']).toContain('spreadsheetml');
      expect(res.headers['content-disposition']).toContain('attachment');
      // xlsx는 zip이므로 PK 시그니처로 시작한다.
      expect((res.body as Buffer).subarray(0, 2).toString()).toBe('PK');

      // 출력은 감사로그에 남는다.
      const logs = await ctx.prisma.auditLog.findMany({
        where: { entityType: 'FITTING_SESSION', entityId: created.body.data.id, action: 'EXPORT' },
      });
      expect(logs).toHaveLength(1);
    });
  });
});
