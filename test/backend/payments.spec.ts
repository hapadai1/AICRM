import { randomUUID } from 'crypto';
import { PaymentsModule } from '../../backend/src/modules/payments/payments.module';
import { api, auth, createTestContext, TestContext, truncateBusinessData } from './helpers';

describe('결제 (payments)', () => {
  let ctx: TestContext;
  let contractId: string;
  let depositId: string;
  let overPaymentId: string;

  beforeAll(async () => {
    ctx = await createTestContext([PaymentsModule]);
    await truncateBusinessData(ctx.prisma);

    const admin = await ctx.prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
    const customerId = randomUUID();
    await ctx.prisma.customer.create({
      data: { id: customerId, name: '홍길동', phone: '010-1234-5678', phoneNormalized: '01012345678' },
    });
    contractId = randomUUID();
    await ctx.prisma.contract.create({
      data: { id: contractId, contractNo: 'CTR-260721-001', customerId, status: 'CONFIRMED' },
    });
    const versionId = randomUUID();
    await ctx.prisma.contractVersion.create({
      data: {
        id: versionId,
        contractId,
        versionNo: 1,
        versionStatus: 'CONFIRMED',
        totalAmount: 1_000_000,
        createdBy: admin.id,
      },
    });
    await ctx.prisma.contract.update({ where: { id: contractId }, data: { currentVersionId: versionId } });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('결제 등록 시 COMPLETED 합계로 수금액과 잔액을 계산한다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/contracts/${contractId}/payments`)
      .set(auth(ctx))
      .send({ paymentType: 'DEPOSIT', amount: 300_000, paymentDate: '2026-07-01', paymentMethod: 'CARD' })
      .expect(201);
    depositId = res.body.data.payment.id;
    expect(res.body.data.payment.status).toBe('COMPLETED');
    expect(res.body.data.summary).toMatchObject({
      contractNo: 'CTR-260721-001',
      customerName: '홍길동',
      contractTypeName: null,
      contractAmount: 1_000_000,
      paidAmount: 300_000,
      collectedAmount: 300_000,
      balanceAmount: 700_000,
      balanceDueDate: null,
    });
    expect(res.body.data.warning).toBeUndefined();

    const list = await api(ctx).get(`/api/v1/contracts/${contractId}/payments`).set(auth(ctx)).expect(200);
    expect(list.body.data.payments).toHaveLength(1);
    expect(list.body.data.summary.balanceAmount).toBe(700_000);
  });

  it('초과 수금은 경고를 담아 응답하되 저장은 허용한다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/contracts/${contractId}/payments`)
      .set(auth(ctx))
      .send({ paymentType: 'BALANCE', amount: 800_000, paymentDate: '2026-07-10', memo: '잔금 과입금' })
      .expect(201);
    overPaymentId = res.body.data.payment.id;
    expect(res.body.data.warning).toBeDefined();
    expect(res.body.data.warning.code).toBe('OVER_COLLECTION');
    expect(res.body.data.summary.paidAmount).toBe(1_100_000);
    expect(res.body.data.summary.collectedAmount).toBe(1_100_000);
    expect(res.body.data.summary.balanceAmount).toBe(-100_000);

    const saved = await ctx.prisma.payment.findUnique({ where: { id: overPaymentId } });
    expect(saved).not.toBeNull();
  });

  it('결제 취소 시 레코드를 보존하고 합계를 재계산한다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/payments/${overPaymentId}/cancel`)
      .set(auth(ctx))
      .send({ reason: '이중 입금 취소' })
      .expect(201);
    expect(res.body.data.payment.status).toBe('CANCELLED');
    expect(res.body.data.summary.collectedAmount).toBe(300_000);
    expect(res.body.data.summary.balanceAmount).toBe(700_000);

    // 삭제 금지: 취소된 레코드가 목록에 남는다
    const list = await api(ctx).get(`/api/v1/contracts/${contractId}/payments`).set(auth(ctx)).expect(200);
    expect(list.body.data.payments).toHaveLength(2);
    const cancelled = list.body.data.payments.find((p: { id: string }) => p.id === overPaymentId);
    expect(cancelled.status).toBe('CANCELLED');

    // 취소 사유는 감사로그에 남는다
    const logs = await ctx.prisma.auditLog.findMany({
      where: { entityType: 'PAYMENT', entityId: overPaymentId, action: 'CANCEL' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].reason).toBe('이중 입금 취소');
  });

  it('이미 취소된 결제는 다시 취소할 수 없다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/payments/${overPaymentId}/cancel`)
      .set(auth(ctx))
      .send({ reason: '재시도' })
      .expect(409);
    expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('취소 사유가 없으면 VALIDATION_ERROR를 반환한다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/payments/${depositId}/cancel`)
      .set(auth(ctx))
      .send({})
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('금액 0원 결제는 등록할 수 없다', async () => {
    await api(ctx)
      .post(`/api/v1/contracts/${contractId}/payments`)
      .set(auth(ctx))
      .send({ paymentType: 'OTHER', amount: 0, paymentDate: '2026-07-11' })
      .expect(400);
  });

  it('없는 계약의 결제 목록은 404를 반환한다', async () => {
    await api(ctx).get(`/api/v1/contracts/${randomUUID()}/payments`).set(auth(ctx)).expect(404);
  });

  it('신규 결제 유형(INTERIM/REPAIR_FEE)을 수용하고 OTHER는 ETC로 통합 저장한다', async () => {
    const interim = await api(ctx)
      .post(`/api/v1/contracts/${contractId}/payments`)
      .set(auth(ctx))
      .send({ paymentType: 'INTERIM', amount: 100_000, paymentDate: '2026-07-12' })
      .expect(201);
    expect(interim.body.data.payment.paymentType).toBe('INTERIM');

    const repairFee = await api(ctx)
      .post(`/api/v1/contracts/${contractId}/payments`)
      .set(auth(ctx))
      .send({ paymentType: 'REPAIR_FEE', amount: 30_000, paymentDate: '2026-07-13' })
      .expect(201);
    expect(repairFee.body.data.payment.paymentType).toBe('REPAIR_FEE');

    // 하위호환: OTHER 입력은 ETC로 저장된다
    const other = await api(ctx)
      .post(`/api/v1/contracts/${contractId}/payments`)
      .set(auth(ctx))
      .send({ paymentType: 'OTHER', amount: 10_000, paymentDate: '2026-07-13' })
      .expect(201);
    expect(other.body.data.payment.paymentType).toBe('ETC');
    const saved = await ctx.prisma.payment.findUnique({ where: { id: other.body.data.payment.id } });
    expect(saved!.paymentType).toBe('ETC');

    // 정의 밖 유형은 400
    await api(ctx)
      .post(`/api/v1/contracts/${contractId}/payments`)
      .set(auth(ctx))
      .send({ paymentType: 'UNKNOWN', amount: 10_000, paymentDate: '2026-07-13' })
      .expect(400);
  });

  it('payerName은 memo에 "입금자: {이름}" 형태로 병합된다', async () => {
    const withMemo = await api(ctx)
      .post(`/api/v1/contracts/${contractId}/payments`)
      .set(auth(ctx))
      .send({
        paymentType: 'ETC',
        amount: 5_000,
        paymentDate: '2026-07-14',
        payerName: '김입금',
        memo: '기타 비용',
      })
      .expect(201);
    expect(withMemo.body.data.payment.memo).toBe('입금자: 김입금 / 기타 비용');

    const withoutMemo = await api(ctx)
      .post(`/api/v1/contracts/${contractId}/payments`)
      .set(auth(ctx))
      .send({ paymentType: 'ETC', amount: 5_000, paymentDate: '2026-07-14', payerName: '박입금' })
      .expect(201);
    expect(withoutMemo.body.data.payment.memo).toBe('입금자: 박입금');
  });

  it('payment-schedule PATCH로 잔금 예정일을 설정·해제하고 감사로그를 남긴다', async () => {
    const set = await api(ctx)
      .patch(`/api/v1/contracts/${contractId}/payment-schedule`)
      .set(auth(ctx))
      .send({ balanceDueDate: '2026-08-15' })
      .expect(200);
    expect(set.body.data).toEqual({ contractId, balanceDueDate: '2026-08-15' });

    const row = await ctx.prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(row.balanceDueDate).not.toBeNull();

    // 목록 summary에 반영
    const list = await api(ctx).get(`/api/v1/contracts/${contractId}/payments`).set(auth(ctx)).expect(200);
    expect(list.body.data.summary.balanceDueDate).toBe('2026-08-15');

    // 감사로그 기록
    const audits = await ctx.prisma.auditLog.findMany({
      where: { entityType: 'CONTRACT', entityId: contractId, action: 'UPDATE' },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);

    // null로 해제
    const clear = await api(ctx)
      .patch(`/api/v1/contracts/${contractId}/payment-schedule`)
      .set(auth(ctx))
      .send({ balanceDueDate: null })
      .expect(200);
    expect(clear.body.data.balanceDueDate).toBeNull();
    const cleared = await ctx.prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(cleared.balanceDueDate).toBeNull();
  });

  it('payment-schedule 날짜 형식 오류는 VALIDATION_ERROR를 반환한다', async () => {
    await api(ctx)
      .patch(`/api/v1/contracts/${contractId}/payment-schedule`)
      .set(auth(ctx))
      .send({ balanceDueDate: '2026/08/15' })
      .expect(400);
  });

  it('없는 계약의 payment-schedule 변경은 404를 반환한다', async () => {
    await api(ctx)
      .patch(`/api/v1/contracts/${randomUUID()}/payment-schedule`)
      .set(auth(ctx))
      .send({ balanceDueDate: '2026-08-15' })
      .expect(404);
  });
});

/** GET /payments — 날짜 범위·고객 기준 통합 검색 (개편계획 05 §3.1) */
describe('결제 통합 검색 (GET /payments)', () => {
  let ctx: TestContext;
  let hongContractId: string;
  let leeContractId: string;

  /** 결제 1건 생성 후 id 반환 */
  async function seedPayment(
    contractId: string,
    paymentType: string,
    amount: number,
    paymentDate: string,
    extra: { status?: string; paymentMethod?: string } = {},
  ): Promise<string> {
    const admin = await ctx.prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
    const id = randomUUID();
    await ctx.prisma.payment.create({
      data: {
        id,
        contractId,
        paymentType,
        amount,
        paymentDate: new Date(paymentDate),
        paymentMethod: extra.paymentMethod ?? null,
        status: extra.status ?? 'COMPLETED',
        createdBy: admin.id,
      },
    });
    return id;
  }

  beforeAll(async () => {
    ctx = await createTestContext([PaymentsModule]);
    await truncateBusinessData(ctx.prisma);

    const hongCustomerId = randomUUID();
    const leeCustomerId = randomUUID();
    await ctx.prisma.customer.createMany({
      data: [
        { id: hongCustomerId, name: '홍길동', phone: '010-1234-5678', phoneNormalized: '01012345678' },
        { id: leeCustomerId, name: '이순신', phone: '010-9999-0000', phoneNormalized: '01099990000' },
      ],
    });
    hongContractId = randomUUID();
    leeContractId = randomUUID();
    await ctx.prisma.contract.createMany({
      data: [
        {
          id: hongContractId,
          contractNo: 'CTR-260601-001',
          customerId: hongCustomerId,
          status: 'CONFIRMED',
        },
        {
          id: leeContractId,
          contractNo: 'CTR-260602-002',
          customerId: leeCustomerId,
          status: 'CONFIRMED',
        },
      ],
    });

    await seedPayment(hongContractId, 'DEPOSIT', 300_000, '2026-06-01', { paymentMethod: '카드' });
    await seedPayment(hongContractId, 'BALANCE', 700_000, '2026-06-30', { paymentMethod: '계좌이체' });
    await seedPayment(hongContractId, 'REFUND', 50_000, '2026-07-05');
    await seedPayment(hongContractId, 'ETC', 10_000, '2026-06-15', { status: 'CANCELLED' });
    await seedPayment(leeContractId, 'DEPOSIT', 200_000, '2026-07-10', { paymentMethod: '현금' });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('행마다 고객·계약 기본정보를 함께 반환하고 결제일 내림차순으로 정렬한다', async () => {
    const res = await api(ctx).get('/api/v1/payments').set(auth(ctx)).expect(200);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.data[0].paymentDate).toBe('2026-07-10');
    expect(res.body.data[0]).toMatchObject({
      contractNo: 'CTR-260602-002',
      customerName: '이순신',
      customerPhone: '010-9999-0000',
      contractTypeName: null,
      paymentType: 'DEPOSIT',
      amount: 200_000,
    });
    expect(res.body.page.totalElements).toBe(5);
  });

  it('결제일 범위는 경계일을 포함한다', async () => {
    const res = await api(ctx)
      .get('/api/v1/payments')
      .query({ dateFrom: '2026-06-01', dateTo: '2026-06-30' })
      .set(auth(ctx))
      .expect(200);
    const dates = res.body.data.map((p: { paymentDate: string }) => p.paymentDate);
    expect(dates).toEqual(['2026-06-30', '2026-06-15', '2026-06-01']);
  });

  it('q로 고객명·전화번호(하이픈 무관)·계약번호를 검색한다', async () => {
    const byName = await api(ctx).get('/api/v1/payments').query({ q: '이순신' }).set(auth(ctx)).expect(200);
    expect(byName.body.data).toHaveLength(1);
    expect(byName.body.data[0].customerName).toBe('이순신');

    const byPhone = await api(ctx)
      .get('/api/v1/payments')
      .query({ q: '010-9999-0000' })
      .set(auth(ctx))
      .expect(200);
    expect(byPhone.body.data).toHaveLength(1);

    const byPhoneDigits = await api(ctx)
      .get('/api/v1/payments')
      .query({ q: '99990000' })
      .set(auth(ctx))
      .expect(200);
    expect(byPhoneDigits.body.data).toHaveLength(1);

    const byContractNo = await api(ctx)
      .get('/api/v1/payments')
      .query({ q: 'CTR-260601' })
      .set(auth(ctx))
      .expect(200);
    expect(byContractNo.body.data).toHaveLength(4);
  });

  it('totals는 취소 결제를 제외하고 환불을 분리 집계한다', async () => {
    const res = await api(ctx)
      .get('/api/v1/payments')
      .query({ contractId: hongContractId })
      .set(auth(ctx))
      .expect(200);
    // 취소된 ETC 10,000은 목록에는 남지만 합계에서는 빠진다
    expect(res.body.data).toHaveLength(4);
    expect(res.body.totals).toEqual({
      count: 3,
      paidAmount: 1_000_000,
      refundAmount: 50_000,
      netAmount: 950_000,
    });
  });

  it('유형·상태·결제수단 필터가 동작한다', async () => {
    const byType = await api(ctx)
      .get('/api/v1/payments')
      .query({ paymentType: 'REFUND' })
      .set(auth(ctx))
      .expect(200);
    expect(byType.body.data).toHaveLength(1);
    expect(byType.body.totals.refundAmount).toBe(50_000);

    const cancelled = await api(ctx)
      .get('/api/v1/payments')
      .query({ status: 'CANCELLED' })
      .set(auth(ctx))
      .expect(200);
    expect(cancelled.body.data).toHaveLength(1);
    // 취소분만 조회할 때 수금 합계는 0이다
    expect(cancelled.body.totals).toEqual({ count: 0, paidAmount: 0, refundAmount: 0, netAmount: 0 });

    const byMethod = await api(ctx)
      .get('/api/v1/payments')
      .query({ paymentMethod: '카드' })
      .set(auth(ctx))
      .expect(200);
    expect(byMethod.body.data).toHaveLength(1);
  });

  it('페이지네이션과 totals가 함께 동작한다(합계는 페이지가 아닌 필터 전체 기준)', async () => {
    const res = await api(ctx)
      .get('/api/v1/payments')
      .query({ contractId: hongContractId, page: 2, size: 2 })
      .set(auth(ctx))
      .expect(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.page).toMatchObject({ number: 2, size: 2, totalElements: 4, totalPages: 2 });
    expect(res.body.totals.netAmount).toBe(950_000);
  });

  it('잘못된 날짜 형식은 VALIDATION_ERROR를 반환한다', async () => {
    await api(ctx).get('/api/v1/payments').query({ dateFrom: '2026/06/01' }).set(auth(ctx)).expect(400);
  });
});
