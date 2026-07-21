import { randomUUID } from 'crypto';
import { CustomersModule } from '../../backend/src/modules/customers/customers.module';
import { api, auth, createTestContext, TestContext, truncateBusinessData } from './helpers';

describe('고객 관리 (Phase 2)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext([CustomersModule]);
    await truncateBusinessData(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('고객 생성 시 전화번호를 숫자만 남겨 정규화하고 기본 상태는 PROSPECT다', async () => {
    const res = await api(ctx)
      .post('/api/v1/customers')
      .set(auth(ctx))
      .send({ name: '김철수', phone: '010-1234-5678' })
      .expect(201);
    expect(res.body.data.phoneNormalized).toBe('01012345678');
    expect(res.body.data.phone).toBe('010-1234-5678');
    expect(res.body.data.customerStatus).toBe('PROSPECT');
  });

  it('동일 정규화 전화번호 고객 생성은 CUSTOMER_PHONE_DUPLICATE와 기존 고객 정보를 반환한다', async () => {
    const res = await api(ctx)
      .post('/api/v1/customers')
      .set(auth(ctx))
      .send({ name: '다른사람', phone: '010 1234 5678' })
      .expect(409);
    expect(res.body.error.code).toBe('CUSTOMER_PHONE_DUPLICATE');
    expect(res.body.error.details.existingCustomer.name).toBe('김철수');
    expect(res.body.error.details.existingCustomer.id).toBeDefined();
  });

  it('고객 목록 기본 조회는 CONTRACTED만 반환하고 PROSPECT는 제외한다', async () => {
    await api(ctx)
      .post('/api/v1/customers')
      .set(auth(ctx))
      .send({ name: '박계약', phone: '010-2222-0001', customerStatus: 'CONTRACTED' })
      .expect(201);

    const base = await api(ctx).get('/api/v1/customers').set(auth(ctx)).expect(200);
    const names = base.body.data.map((c: { name: string }) => c.name);
    expect(names).toContain('박계약');
    expect(names).not.toContain('김철수');

    const all = await api(ctx).get('/api/v1/customers?status=ALL').set(auth(ctx)).expect(200);
    expect(all.body.data.map((c: { name: string }) => c.name)).toContain('김철수');
  });

  it('통합 검색 q는 이름과 전화번호 조각으로 고객을 찾는다', async () => {
    const byName = await api(ctx)
      .get('/api/v1/customers?status=ALL&q=철수')
      .set(auth(ctx))
      .expect(200);
    expect(byName.body.data).toHaveLength(1);
    expect(byName.body.data[0].name).toBe('김철수');

    const byPhone = await api(ctx)
      .get('/api/v1/customers?status=ALL&q=010-1234')
      .set(auth(ctx))
      .expect(200);
    expect(byPhone.body.data.map((c: { name: string }) => c.name)).toContain('김철수');
  });

  it('고객 상세는 { customer, summary, ...연관 목록 } 구조로 반환한다 (연동정합화 §2)', async () => {
    const list = await api(ctx).get('/api/v1/customers?status=ALL&q=철수').set(auth(ctx)).expect(200);
    const id = list.body.data[0].id;
    const res = await api(ctx).get(`/api/v1/customers/${id}`).set(auth(ctx)).expect(200);
    expect(res.body.data.customer.name).toBe('김철수');
    expect(res.body.data.summary).toEqual({
      contractCount: 0,
      totalAmount: 0,
      paidAmount: 0,
      balanceAmount: 0,
    });
    expect(res.body.data.contracts).toEqual([]);
    expect(res.body.data.orders).toEqual([]);
    expect(res.body.data.appointments).toEqual([]);
    expect(res.body.data.consultations).toEqual([]);
    expect(res.body.data.measurements).toEqual([]);
    expect(res.body.data.components).toEqual([]);
    expect(res.body.data.rentals).toEqual([]);
    expect(res.body.data.repairs).toEqual([]);
    expect(res.body.data.payments).toEqual([]);
  });

  it('고객 수정은 낙관적 잠금을 적용하고 버전 불일치 시 VERSION_CONFLICT를 반환한다', async () => {
    const list = await api(ctx).get('/api/v1/customers?q=박계약').set(auth(ctx)).expect(200);
    const customer = list.body.data[0];

    const conflict = await api(ctx)
      .patch(`/api/v1/customers/${customer.id}`)
      .set(auth(ctx))
      .send({ name: '박계약2', version: customer.rowVersion + 99 })
      .expect(409);
    expect(conflict.body.error.code).toBe('VERSION_CONFLICT');

    const ok = await api(ctx)
      .patch(`/api/v1/customers/${customer.id}`)
      .set(auth(ctx))
      .send({ name: '박계약2', version: customer.rowVersion })
      .expect(200);
    expect(ok.body.data.name).toBe('박계약2');
    expect(ok.body.data.rowVersion).toBe(customer.rowVersion + 1);
  });

  it('전화번호 변경 시 다른 고객과 중복이면 차단한다', async () => {
    const list = await api(ctx).get('/api/v1/customers?q=박계약2').set(auth(ctx)).expect(200);
    const customer = list.body.data[0];
    const res = await api(ctx)
      .patch(`/api/v1/customers/${customer.id}`)
      .set(auth(ctx))
      .send({ phone: '(010) 1234-5678', version: customer.rowVersion })
      .expect(409);
    expect(res.body.error.code).toBe('CUSTOMER_PHONE_DUPLICATE');
  });

  it('전화 중복 조회는 정규화된 번호로 기존 고객을 찾고 없으면 null을 반환한다', async () => {
    const found = await api(ctx)
      .get('/api/v1/customers/by-phone/010-1234-5678')
      .set(auth(ctx))
      .expect(200);
    expect(found.body.data.name).toBe('김철수');

    const none = await api(ctx)
      .get('/api/v1/customers/by-phone/010-9999-9999')
      .set(auth(ctx))
      .expect(200);
    expect(none.body.data).toBeNull();
  });

  it('고객 비활성 처리는 물리 삭제 없이 INACTIVE로 전환하고 감사로그를 남긴다', async () => {
    const list = await api(ctx).get('/api/v1/customers?q=박계약2').set(auth(ctx)).expect(200);
    const customer = list.body.data[0];

    const res = await api(ctx)
      .post(`/api/v1/customers/${customer.id}/deactivate`)
      .set(auth(ctx))
      .send({ reason: '고객 요청' })
      .expect(201);
    expect(res.body.data.customerStatus).toBe('INACTIVE');

    // 레코드 보존 확인
    const row = await ctx.prisma.customer.findUnique({ where: { id: customer.id } });
    expect(row?.customerStatus).toBe('INACTIVE');

    // 감사로그 확인
    const logs = await ctx.prisma.auditLog.findMany({
      where: { entityType: 'CUSTOMER', entityId: customer.id, action: 'STATUS_CHANGE' },
    });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].reason).toBe('고객 요청');

    // 이미 INACTIVE인 고객은 재비활성화 불가
    const again = await api(ctx)
      .post(`/api/v1/customers/${customer.id}/deactivate`)
      .set(auth(ctx))
      .send({})
      .expect(409);
    expect(again.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  describe('연동정합화 §2 확장', () => {
    let richCustomerId: string;
    let contractId: string;

    beforeAll(async () => {
      // 계약·주문·채촌·결제까지 갖춘 고객 (연관 목록·summary 검증용)
      const admin = await ctx.prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
      richCustomerId = randomUUID();
      await ctx.prisma.customer.create({
        data: {
          id: richCustomerId,
          name: '조계약',
          phone: '010-7777-0001',
          phoneNormalized: '01077770001',
          customerStatus: 'CONTRACTED',
          contractedAt: new Date(),
        },
      });
      contractId = randomUUID();
      const versionId = randomUUID();
      await ctx.prisma.contract.create({
        data: {
          id: contractId,
          contractNo: 'CTR-260721-901',
          customerId: richCustomerId,
          status: 'CONFIRMED',
          contractedAt: new Date(),
        },
      });
      await ctx.prisma.contractVersion.create({
        data: {
          id: versionId,
          contractId,
          versionNo: 1,
          versionStatus: 'CONFIRMED',
          totalAmount: 1_000_000,
          depositAmount: 300_000,
          balanceAmount: 700_000,
          createdBy: admin.id,
        },
      });
      await ctx.prisma.contract.update({
        where: { id: contractId },
        data: { currentVersionId: versionId },
      });
      const lineId = randomUUID();
      await ctx.prisma.contractLine.create({
        data: {
          id: lineId,
          contractVersionId: versionId,
          transactionType: 'CUSTOM',
          productCategory: 'SUIT',
          quantity: 1,
          lineAmount: 1_000_000,
        },
      });
      const orderId = randomUUID();
      await ctx.prisma.order.create({
        data: {
          id: orderId,
          orderNo: 'ORD-260721-901',
          contractId,
          transactionType: 'CUSTOM',
          status: 'CREATED',
        },
      });
      const orderItemId = randomUUID();
      await ctx.prisma.orderItem.create({
        data: {
          id: orderItemId,
          orderId,
          sourceContractLineId: lineId,
          productCategory: 'SUIT',
          sequenceNo: 1,
          displayName: '정장 #1',
          status: 'CREATED',
        },
      });
      await ctx.prisma.orderItemComponent.create({
        data: {
          id: randomUUID(),
          orderItemId,
          componentType: 'JACKET',
          sequenceNo: 1,
          status: 'CREATED',
        },
      });
      await ctx.prisma.measurementSession.create({
        data: {
          id: randomUUID(),
          customerId: richCustomerId,
          versionNo: 1,
          measurementDate: new Date(),
          createdBy: admin.id,
        },
      });
      await ctx.prisma.payment.create({
        data: {
          id: randomUUID(),
          contractId,
          paymentType: 'DEPOSIT',
          amount: 300_000,
          paymentDate: new Date(),
          status: 'COMPLETED',
          createdBy: admin.id,
        },
      });
    });

    it('includeProspect=true면 CONTRACTED 목록에 PROSPECT를 포함한다 (INACTIVE 제외)', async () => {
      const base = await api(ctx).get('/api/v1/customers').set(auth(ctx)).expect(200);
      expect(base.body.data.map((c: { name: string }) => c.name)).not.toContain('김철수');

      const withProspect = await api(ctx)
        .get('/api/v1/customers?includeProspect=true')
        .set(auth(ctx))
        .expect(200);
      const names = withProspect.body.data.map((c: { name: string }) => c.name);
      expect(names).toContain('김철수'); // PROSPECT
      expect(names).toContain('조계약'); // CONTRACTED
      expect(names).not.toContain('박계약2'); // INACTIVE
    });

    it('transactionType 필터는 해당 거래방식 주문 보유 고객만 반환한다', async () => {
      const custom = await api(ctx)
        .get('/api/v1/customers?status=ALL&transactionType=CUSTOM')
        .set(auth(ctx))
        .expect(200);
      expect(custom.body.data.map((c: { id: string }) => c.id)).toEqual([richCustomerId]);

      const rental = await api(ctx)
        .get('/api/v1/customers?status=ALL&transactionType=RENTAL')
        .set(auth(ctx))
        .expect(200);
      expect(rental.body.data).toHaveLength(0);
    });

    it('고객 상세 summary·계약 뷰·연관 목록을 반환한다', async () => {
      const res = await api(ctx).get(`/api/v1/customers/${richCustomerId}`).set(auth(ctx)).expect(200);
      const data = res.body.data;

      expect(data.customer.name).toBe('조계약');
      expect(data.summary).toEqual({
        contractCount: 1,
        totalAmount: 1_000_000,
        paidAmount: 300_000,
        balanceAmount: 700_000,
      });

      // 계약 뷰 (연동정합화 계약 §2)
      expect(data.contracts).toHaveLength(1);
      expect(data.contracts[0]).toMatchObject({
        id: contractId,
        contractNo: 'CTR-260721-901',
        contractTypeName: null,
        status: 'CONFIRMED',
        currentVersionNo: 1,
        totalAmount: 1_000_000,
        depositAmount: 300_000,
        balanceAmount: 700_000,
      });

      expect(data.orders).toHaveLength(1);
      expect(data.orders[0].orderNo).toBe('ORD-260721-901');
      expect(data.orders[0].contractNo).toBe('CTR-260721-901');

      expect(data.measurements).toHaveLength(1);
      expect(data.measurements[0].completed).toBe(false);
      expect(data.measurements[0].versionNo).toBe(1);

      expect(data.components).toHaveLength(1);
      expect(data.components[0]).toMatchObject({
        componentType: 'JACKET',
        orderItemName: '정장 #1',
        orderNo: 'ORD-260721-901',
        status: 'CREATED',
      });

      expect(data.payments).toHaveLength(1);
      expect(data.payments[0]).toMatchObject({
        contractNo: 'CTR-260721-901',
        paymentType: 'DEPOSIT',
        amount: 300_000,
        status: 'COMPLETED',
      });

      expect(data.rentals).toEqual([]);
      expect(data.repairs).toEqual([]);
    });
  });
});
