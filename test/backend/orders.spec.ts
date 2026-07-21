import { randomUUID } from 'crypto';
import { ContractsModule } from '../../backend/src/modules/contracts/contracts.module';
import { OrdersModule } from '../../backend/src/modules/orders/orders.module';
import { api, auth, createTestContext, TestContext, truncateBusinessData } from './helpers';

describe('주문·품목·구성품 (Phase 2)', () => {
  let ctx: TestContext;
  let orderId: string;
  let suitItemId: string;

  beforeAll(async () => {
    ctx = await createTestContext([ContractsModule, OrdersModule]);
    await truncateBusinessData(ctx.prisma);

    // 고객 → 계약 초안 → 확정으로 주문·품목·구성품을 만든다
    const customer = await ctx.prisma.customer.create({
      data: {
        id: randomUUID(),
        name: '주문테스트고객',
        phone: '010-9999-0001',
        phoneNormalized: '01099990001',
        customerStatus: 'PROSPECT',
      },
    });
    const created = await api(ctx)
      .post('/api/v1/contracts')
      .set(auth(ctx))
      .send({
        customerId: customer.id,
        lines: [
          { transactionType: 'CUSTOM', productCategory: 'SUIT', quantity: 1 },
          { transactionType: 'CUSTOM', productCategory: 'SHIRT', quantity: 1 },
        ],
      })
      .expect(201);
    const confirmed = await api(ctx)
      .post(`/api/v1/contracts/${created.body.data.id}/confirm`)
      .set(auth(ctx))
      .send({ version: 0 })
      .expect(200);
    orderId = confirmed.body.data.orders.find((o: { tradeType: string }) => o.tradeType === 'CUSTOM').id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('주문 상세를 품목·구성품 포함으로 조회한다', async () => {
    const res = await api(ctx).get(`/api/v1/orders/${orderId}`).set(auth(ctx)).expect(200);
    const order = res.body.data;
    expect(order.orderNo).toMatch(/^ORD-\d{6}-\d{3}$/);
    expect(order.transactionType).toBe('CUSTOM');
    expect(order.contract.customer.name).toBe('주문테스트고객');
    expect(order.items).toHaveLength(2);

    const suit = order.items.find((i: { productCategory: string }) => i.productCategory === 'SUIT');
    suitItemId = suit.id;
    expect(suit.displayName).toBe('정장 #1');
    expect(suit.components.map((c: { componentType: string }) => c.componentType).sort()).toEqual([
      'JACKET',
      'TROUSERS',
    ]);
  });

  it('없는 주문은 404를 반환한다', async () => {
    await api(ctx).get(`/api/v1/orders/${randomUUID()}`).set(auth(ctx)).expect(404);
  });

  it('주문 품목 목록을 조회한다', async () => {
    const res = await api(ctx).get(`/api/v1/orders/${orderId}/items`).set(auth(ctx)).expect(200);
    expect(res.body.data.map((i: { displayName: string }) => i.displayName).sort()).toEqual(['셔츠 #1', '정장 #1']);
  });

  it('구성품 추가: 정장에 VEST를 추가한다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/order-items/${suitItemId}/components`)
      .set(auth(ctx))
      .send({ componentType: 'VEST', notes: '고객 요청 베스트 추가' })
      .expect(201);
    expect(res.body.data.componentType).toBe('VEST');
    expect(res.body.data.sequenceNo).toBe(1);

    const item = await ctx.prisma.orderItem.findUniqueOrThrow({
      where: { id: suitItemId },
      include: { components: true },
    });
    expect(item.components.map((c) => c.componentType).sort()).toEqual(['JACKET', 'TROUSERS', 'VEST']);

    // 동일 구성품 추가 시 순번 증가
    const second = await api(ctx)
      .post(`/api/v1/order-items/${suitItemId}/components`)
      .set(auth(ctx))
      .send({ componentType: 'VEST' })
      .expect(201);
    expect(second.body.data.sequenceNo).toBe(2);
  });

  it('구성품 수정: 메모와 입고 예정일을 갱신한다 (수량 개념 없음)', async () => {
    const component = await ctx.prisma.orderItemComponent.findFirstOrThrow({
      where: { orderItemId: suitItemId, componentType: 'JACKET' },
    });
    const res = await api(ctx)
      .patch(`/api/v1/components/${component.id}`)
      .set(auth(ctx))
      .send({ notes: '소매 기장 주의', expectedInboundDate: '2026-08-01' })
      .expect(200);
    expect(res.body.data.notes).toBe('소매 기장 주의');
    expect(res.body.data.expectedInboundDate).toContain('2026-08-01');
  });

  it('허용되지 않은 구성품 타입은 400을 반환한다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/order-items/${suitItemId}/components`)
      .set(auth(ctx))
      .send({ componentType: 'HAT' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('주문 경로의 품목 수량 변경 API는 존재하지 않는다 (계약 변경으로만 가능)', async () => {
    // PATCH /order-items/:id 자체를 제공하지 않으므로 404 — ORDER_ITEM_COUNT_LOCKED 원칙 충족
    await api(ctx)
      .patch(`/api/v1/order-items/${suitItemId}`)
      .set(auth(ctx))
      .send({ quantity: 5 })
      .expect(404);
  });

  it('취소된 품목에는 구성품을 추가할 수 없다', async () => {
    await ctx.prisma.orderItem.update({
      where: { id: suitItemId },
      data: { status: 'CANCELLED', cancelledReason: '테스트 취소', cancelledAt: new Date() },
    });
    const res = await api(ctx)
      .post(`/api/v1/order-items/${suitItemId}/components`)
      .set(auth(ctx))
      .send({ componentType: 'VEST' })
      .expect(409);
    expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });
});
