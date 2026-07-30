import { randomUUID } from 'crypto';
import { api, auth, createTestContext, TestContext, truncateBusinessData } from './helpers';

/**
 * AUDIT-001 조회 보강 — 상태 코드만 남은 로그도 "무엇을 다룬 기록인가"가 채워져야 한다.
 * 실제로 쌓여 있던 로그 형태(전/후에 status 하나, 또는 아예 비어 있음)를 그대로 재현해 확인한다.
 */
describe('감사로그 대상 보강 (AUDIT-001)', () => {
  let ctx: TestContext;
  let customerId: string;
  let contractId: string;
  let orderItemId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    await truncateBusinessData(ctx.prisma);

    customerId = randomUUID();
    await ctx.prisma.customer.create({
      data: { id: customerId, name: '감사보강 고객', phone: '010-7777-0001', phoneNormalized: '01077770001' },
    });
    contractId = randomUUID();
    await ctx.prisma.contract.create({
      data: { id: contractId, contractNo: 'C-AUDIT-0001', customerId, status: 'CONFIRMED' },
    });
    const versionId = randomUUID();
    await ctx.prisma.contractVersion.create({
      data: {
        id: versionId,
        contractId,
        versionNo: 1,
        versionStatus: 'CONFIRMED',
        createdBy: (await ctx.prisma.user.findFirstOrThrow({ where: { loginId: 'admin' } })).id,
      },
    });
    const contractLineId = randomUUID();
    await ctx.prisma.contractLine.create({
      data: {
        id: contractLineId,
        contractVersionId: versionId,
        transactionType: 'CUSTOM',
        productCategory: 'SUIT',
        quantity: 1,
      },
    });
    const orderId = randomUUID();
    await ctx.prisma.order.create({
      data: { id: orderId, orderNo: 'O-AUDIT-0001', contractId, transactionType: 'CUSTOM' },
    });
    orderItemId = randomUUID();
    // 주문품목은 계약 품목(계약 소유)의 물리화 결과다 → 앵커 품목을 먼저 만든다.
    const anchorItemId = randomUUID();
    await ctx.prisma.contractItem.create({
      data: {
        id: anchorItemId,
        contractId,
        sourceContractLineId: contractLineId,
        transactionType: 'CUSTOM',
        productCategory: 'SUIT',
        sequenceNo: 1,
        displayName: '정장 #1',
      },
    });

    await ctx.prisma.orderItem.create({
      data: {
        id: orderItemId,
        orderId,
        sourceContractItemId: anchorItemId,
        productCategory: 'SUIT',
        sequenceNo: 1,
        displayName: '정장 1벌',
      },
    });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  async function fetchLog(id: string) {
    const res = await api(ctx).get(`/api/v1/audit-logs/${id}`).set(auth(ctx)).expect(200);
    return res.body.data;
  }

  it('상태만 남은 계약 로그에 계약번호·고객명이 채워진다', async () => {
    const id = randomUUID();
    await ctx.prisma.auditLog.create({
      data: {
        id,
        action: 'CANCEL',
        entityType: 'CONTRACT',
        entityId: contractId,
        beforeJson: { status: 'CONFIRMED' },
        afterJson: { status: 'CANCELLED' },
      },
    });

    const log = await fetchLog(id);
    // 전/후 양쪽에 같은 값으로 들어가야 '변경된 항목'이 늘지 않는다.
    expect(log.beforeJson).toMatchObject({ contractNo: 'C-AUDIT-0001', customerName: '감사보강 고객' });
    expect(log.afterJson).toMatchObject({ contractNo: 'C-AUDIT-0001', customerName: '감사보강 고객' });
    expect(log.beforeJson.status).toBe('CONFIRMED');
    expect(log.afterJson.status).toBe('CANCELLED');
  });

  it('주문 품목 로그에 고객·계약·주문·품목명이 채워진다', async () => {
    const id = randomUUID();
    await ctx.prisma.auditLog.create({
      data: {
        id,
        action: 'STATUS_CHANGE',
        entityType: 'ORDER_ITEM',
        entityId: orderItemId,
        beforeJson: { status: 'CREATED' },
        afterJson: { status: 'RECEIVED' },
      },
    });

    const log = await fetchLog(id);
    expect(log.afterJson).toMatchObject({
      customerName: '감사보강 고객',
      contractNo: 'C-AUDIT-0001',
      orderNo: 'O-AUDIT-0001',
      displayName: '정장 1벌',
    });
  });

  it('전/후가 모두 비어 있던 로그에도 대상이 채워진다', async () => {
    const id = randomUUID();
    await ctx.prisma.auditLog.create({
      data: { id, action: 'EXPORT', entityType: 'ORDER_ITEM', entityId: orderItemId },
    });

    const log = await fetchLog(id);
    expect(log.beforeJson).toMatchObject({ customerName: '감사보강 고객' });
    expect(log.afterJson).toMatchObject({ customerName: '감사보강 고객' });
  });

  it('삭제 로그는 없는 쪽(after)을 만들지 않는다 — 수정으로 읽히면 안 된다', async () => {
    const id = randomUUID();
    await ctx.prisma.auditLog.create({
      data: {
        id,
        action: 'DELETE',
        entityType: 'ORDER_ITEM',
        entityId: orderItemId,
        beforeJson: { status: 'CREATED' },
      },
    });

    const log = await fetchLog(id);
    expect(log.beforeJson).toMatchObject({ customerName: '감사보강 고객' });
    expect(log.afterJson).toBeNull();
  });
});
