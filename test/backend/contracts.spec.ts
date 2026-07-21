import { randomUUID } from 'crypto';
import { ContractsModule } from '../../backend/src/modules/contracts/contracts.module';
import { OrdersModule } from '../../backend/src/modules/orders/orders.module';
import { api, auth, createTestContext, TestContext, truncateBusinessData } from './helpers';

describe('계약 구분·계약·확정·변경 (Phase 2)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext([ContractsModule, OrdersModule]);
    await truncateBusinessData(ctx.prisma);
    // contract_types는 시드 보존 대상이므로 이 스위트가 만든 비시드 항목만 정리한다 (재실행 안전)
    const seedCodes = ['BUSINESS_SUIT_CUSTOM', 'WEDDING_PACKAGE_RENTAL'];
    await ctx.prisma.contractTypeLine.deleteMany({
      where: { contractType: { code: { notIn: seedCodes } } },
    });
    await ctx.prisma.contractType.deleteMany({ where: { code: { notIn: seedCodes } } });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  let phoneSeq = 0;
  async function newCustomer(): Promise<string> {
    phoneSeq += 1;
    const digits = String(10000000 + phoneSeq).slice(-8);
    const customer = await ctx.prisma.customer.create({
      data: {
        id: randomUUID(),
        name: `테스트고객${phoneSeq}`,
        phone: `010-${digits.slice(0, 4)}-${digits.slice(4)}`,
        phoneNormalized: `010${digits}`,
        customerStatus: 'PROSPECT',
      },
    });
    return customer.id;
  }

  async function currentRowVersion(contractId: string): Promise<number> {
    const row = await ctx.prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
    return row.rowVersion;
  }

  // ---------------------------------------------------------------------------
  // 계약 구분 마스터
  // ---------------------------------------------------------------------------

  describe('계약 구분 마스터', () => {
    it('시드된 계약 구분을 기본 품목 라인과 함께 조회한다', async () => {
      const res = await api(ctx).get('/api/v1/contract-types?active=true').set(auth(ctx)).expect(200);
      const codes = res.body.data.map((t: { code: string }) => t.code);
      expect(codes).toEqual(expect.arrayContaining(['BUSINESS_SUIT_CUSTOM', 'WEDDING_PACKAGE_RENTAL']));
      const wedding = res.body.data.find((t: { code: string }) => t.code === 'WEDDING_PACKAGE_RENTAL');
      expect(wedding.lines).toHaveLength(2);
      expect(wedding.lines[0].transactionType).toBe('RENTAL');
    });

    it('생성·수정·복제·사용중지 수명주기를 지원한다', async () => {
      const created = await api(ctx)
        .post('/api/v1/contract-types')
        .set(auth(ctx))
        .send({
          code: 'TUXEDO_CUSTOM',
          name: '턱시도 맞춤',
          lines: [{ transactionType: 'CUSTOM', productCategory: 'SUIT', defaultQuantity: 1 }],
        })
        .expect(201);
      expect(created.body.data.lines).toHaveLength(1);

      const patched = await api(ctx)
        .patch(`/api/v1/contract-types/${created.body.data.id}`)
        .set(auth(ctx))
        .send({
          name: '턱시도 맞춤(개정)',
          lines: [
            { transactionType: 'CUSTOM', productCategory: 'SUIT', defaultQuantity: 1 },
            { transactionType: 'CUSTOM', productCategory: 'SHIRT', defaultQuantity: 2 },
          ],
        })
        .expect(200);
      expect(patched.body.data.name).toBe('턱시도 맞춤(개정)');
      expect(patched.body.data.lines).toHaveLength(2);

      const cloned = await api(ctx)
        .post(`/api/v1/contract-types/${created.body.data.id}/clone`)
        .set(auth(ctx))
        .send({ code: 'TUXEDO_CUSTOM_V2' })
        .expect(201);
      expect(cloned.body.data.code).toBe('TUXEDO_CUSTOM_V2');
      expect(cloned.body.data.lines).toHaveLength(2);

      const retired = await api(ctx)
        .post(`/api/v1/contract-types/${cloned.body.data.id}/retire`)
        .set(auth(ctx))
        .expect(200);
      expect(retired.body.data.active).toBe(false);

      const activeList = await api(ctx).get('/api/v1/contract-types?active=true').set(auth(ctx)).expect(200);
      const activeCodes = activeList.body.data.map((t: { code: string }) => t.code);
      expect(activeCodes).not.toContain('TUXEDO_CUSTOM_V2');
      expect(activeCodes).toContain('TUXEDO_CUSTOM');
    });

    it('중복 코드는 VALIDATION_ERROR를 반환한다', async () => {
      const res = await api(ctx)
        .post('/api/v1/contract-types')
        .set(auth(ctx))
        .send({ code: 'BUSINESS_SUIT_CUSTOM', name: '중복' })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ---------------------------------------------------------------------------
  // 계약 초안
  // ---------------------------------------------------------------------------

  describe('계약 초안', () => {
    it('customerId 없이 계약을 생성할 수 없다', async () => {
      const res = await api(ctx).post('/api/v1/contracts').set(auth(ctx)).send({}).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('계약 구분 선택 시 기본 품목 라인을 복사하고 CTR 번호를 채번한다', async () => {
      const customerId = await newCustomer();
      const wedding = await ctx.prisma.contractType.findUniqueOrThrow({ where: { code: 'WEDDING_PACKAGE_RENTAL' } });
      const res = await api(ctx)
        .post('/api/v1/contracts')
        .set(auth(ctx))
        .send({ customerId, contractTypeId: wedding.id })
        .expect(201);
      const contract = res.body.data;
      expect(contract.status).toBe('DRAFT');
      expect(contract.contractNo).toMatch(/^CTR-\d{6}-\d{3}$/);
      expect(contract.currentVersion.versionNo).toBe(1);
      expect(contract.currentVersion.versionStatus).toBe('DRAFT');
      expect(contract.currentVersion.lines).toHaveLength(2);
      const categories = contract.currentVersion.lines.map((l: { productCategory: string }) => l.productCategory);
      expect(categories).toEqual(expect.arrayContaining(['SUIT', 'SHOES']));
    });

    it('계약 구분 마스터 변경은 이미 생성된 계약 라인에 영향을 주지 않는다 (복사 방식)', async () => {
      const customerId = await newCustomer();
      const type = await api(ctx)
        .post('/api/v1/contract-types')
        .set(auth(ctx))
        .send({
          code: `SNAPSHOT_${Date.now()}`,
          name: '스냅샷 검증용',
          lines: [{ transactionType: 'CUSTOM', productCategory: 'SUIT', defaultQuantity: 2 }],
        })
        .expect(201);
      const contract = await api(ctx)
        .post('/api/v1/contracts')
        .set(auth(ctx))
        .send({ customerId, contractTypeId: type.body.data.id })
        .expect(201);
      expect(contract.body.data.currentVersion.lines[0].quantity).toBe(2);

      // 마스터 라인 변경 후에도 기존 계약 라인은 그대로
      await api(ctx)
        .patch(`/api/v1/contract-types/${type.body.data.id}`)
        .set(auth(ctx))
        .send({ lines: [{ transactionType: 'CUSTOM', productCategory: 'SUIT', defaultQuantity: 5 }] })
        .expect(200);
      const detail = await api(ctx).get(`/api/v1/contracts/${contract.body.data.id}`).set(auth(ctx)).expect(200);
      expect(detail.body.data.currentVersion.lines[0].quantity).toBe(2);
    });

    it('초안 PATCH로 라인·금액을 수정한다', async () => {
      const customerId = await newCustomer();
      const created = await api(ctx).post('/api/v1/contracts').set(auth(ctx)).send({ customerId }).expect(201);
      const res = await api(ctx)
        .patch(`/api/v1/contracts/${created.body.data.id}`)
        .set(auth(ctx))
        .send({
          totalAmount: 3000000,
          depositAmount: 1000000,
          balanceAmount: 2000000,
          lines: [
            { transactionType: 'CUSTOM', productCategory: 'SUIT', quantity: 2, lineAmount: 2400000 },
            { transactionType: 'CUSTOM', productCategory: 'SHIRT', quantity: 1, lineAmount: 200000 },
            { transactionType: 'RENTAL', productCategory: 'SHOES', quantity: 1, lineAmount: 400000 },
          ],
        })
        .expect(200);
      expect(res.body.data.currentVersion.lines).toHaveLength(3);
      expect(Number(res.body.data.currentVersion.totalAmount)).toBe(3000000);
    });
  });

  // ---------------------------------------------------------------------------
  // 계약 확정 (단일 트랜잭션·멱등성·낙관적 잠금)
  // ---------------------------------------------------------------------------

  describe('계약 확정', () => {
    let contractId: string;
    let customerId: string;
    let confirmBody: Record<string, unknown>;
    const idemKey = `contract-confirm-${randomUUID()}`;

    beforeAll(async () => {
      customerId = await newCustomer();
      const created = await api(ctx).post('/api/v1/contracts').set(auth(ctx)).send({ customerId }).expect(201);
      contractId = created.body.data.id;
      await api(ctx)
        .patch(`/api/v1/contracts/${contractId}`)
        .set(auth(ctx))
        .send({
          totalAmount: 3000000,
          lines: [
            { transactionType: 'CUSTOM', productCategory: 'SUIT', quantity: 2 },
            { transactionType: 'CUSTOM', productCategory: 'SHIRT', quantity: 1 },
            { transactionType: 'RENTAL', productCategory: 'SHOES', quantity: 1 },
          ],
        })
        .expect(200);
    });

    it('version 불일치 시 409 CONTRACT_VERSION_CONFLICT를 반환한다', async () => {
      const res = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/confirm`)
        .set(auth(ctx))
        .send({ version: 999 })
        .expect(409);
      expect(res.body.error.code).toBe('CONTRACT_VERSION_CONFLICT');
    });

    it('확정 시 CUSTOM/RENTAL 주문 분리·수량만큼 품목 펼침·고객 CONTRACTED 전환이 한 번에 처리된다', async () => {
      const version = await currentRowVersion(contractId);
      const res = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/confirm`)
        .set(auth(ctx))
        .set('Idempotency-Key', idemKey)
        .send({ version })
        .expect(200);
      confirmBody = res.body.data;

      // 문서 14.1 응답 형태
      expect(confirmBody.contractId).toBe(contractId);
      expect(confirmBody.status).toBe('CONFIRMED');
      expect(confirmBody.customerStatus).toBe('CONTRACTED');
      const orders = confirmBody.orders as Array<{ id: string; orderNo: string; tradeType: string }>;
      expect(orders).toHaveLength(2);
      expect(orders.map((o) => o.tradeType).sort()).toEqual(['CUSTOM', 'RENTAL']);
      for (const order of orders) expect(order.orderNo).toMatch(/^ORD-\d{6}-\d{3}$/);

      // 고객 전환
      const customer = await ctx.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
      expect(customer.customerStatus).toBe('CONTRACTED');
      expect(customer.contractedAt).not.toBeNull();

      // 품목 펼침: 정장 #1·#2, 셔츠 #1 (CUSTOM) / 렌탈 구두 #1 (RENTAL)
      const customOrder = orders.find((o) => o.tradeType === 'CUSTOM')!;
      const customItems = await ctx.prisma.orderItem.findMany({
        where: { orderId: customOrder.id },
        include: { components: true },
        orderBy: [{ productCategory: 'asc' }, { sequenceNo: 'asc' }],
      });
      expect(customItems.map((i) => i.displayName).sort()).toEqual(['셔츠 #1', '정장 #1', '정장 #2']);
      const suit1 = customItems.find((i) => i.displayName === '정장 #1')!;
      expect(suit1.components.map((c) => c.componentType).sort()).toEqual(['JACKET', 'TROUSERS']);
      const shirt = customItems.find((i) => i.displayName === '셔츠 #1')!;
      expect(shirt.components.map((c) => c.componentType)).toEqual(['SHIRT']);

      const rentalOrder = orders.find((o) => o.tradeType === 'RENTAL')!;
      const rentalItems = await ctx.prisma.orderItem.findMany({
        where: { orderId: rentalOrder.id },
        include: { components: true },
      });
      expect(rentalItems).toHaveLength(1);
      expect(rentalItems[0].displayName).toBe('렌탈 구두 #1');
      expect(rentalItems[0].components.map((c) => c.componentType)).toEqual(['SHOES']);

      // 계약·버전 상태
      const detail = await api(ctx).get(`/api/v1/contracts/${contractId}`).set(auth(ctx)).expect(200);
      expect(detail.body.data.status).toBe('CONFIRMED');
      expect(detail.body.data.currentVersion.versionStatus).toBe('CONFIRMED');
    });

    it('동일 Idempotency-Key 재요청은 저장된 최초 응답을 그대로 반환한다', async () => {
      const res = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/confirm`)
        .set(auth(ctx))
        .set('Idempotency-Key', idemKey)
        .send({ version: 12345 }) // 이미 확정됐어도 동일 키면 저장 응답 반환
        .expect(200);
      expect(res.body.data).toEqual(confirmBody);

      // 주문이 중복 생성되지 않았다
      const orderCount = await ctx.prisma.order.count({ where: { contractId } });
      expect(orderCount).toBe(2);
    });

    it('확정본 직접 수정은 CONTRACT_NOT_DRAFT로 차단된다', async () => {
      const res = await api(ctx)
        .patch(`/api/v1/contracts/${contractId}`)
        .set(auth(ctx))
        .send({ totalAmount: 999 })
        .expect(409);
      expect(res.body.error.code).toBe('CONTRACT_NOT_DRAFT');
    });

    it('새 키로 재확정을 시도하면 CONTRACT_NOT_DRAFT를 반환한다', async () => {
      const version = await currentRowVersion(contractId);
      const res = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/confirm`)
        .set(auth(ctx))
        .set('Idempotency-Key', `contract-confirm-${randomUUID()}`)
        .send({ version })
        .expect(409);
      expect(res.body.error.code).toBe('CONTRACT_NOT_DRAFT');
    });

    // -------------------------------------------------------------------------
    // 변경계약
    // -------------------------------------------------------------------------

    it('변경계약 수량 증가: 다음 순번으로 정장 #3을 생성하고 이전 버전은 SUPERSEDED 처리한다', async () => {
      const revision = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/revisions`)
        .set(auth(ctx))
        .send({
          changeReason: '정장 1벌 추가 주문',
          lines: [
            { transactionType: 'CUSTOM', productCategory: 'SUIT', quantity: 3 },
            { transactionType: 'CUSTOM', productCategory: 'SHIRT', quantity: 1 },
            { transactionType: 'RENTAL', productCategory: 'SHOES', quantity: 1 },
          ],
        })
        .expect(201);
      expect(revision.body.data.versionNo).toBe(2);
      expect(revision.body.data.versionStatus).toBe('DRAFT');

      // 낙관적 잠금: 잘못된 version → 409
      const conflict = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/revisions/${revision.body.data.id}/confirm`)
        .set(auth(ctx))
        .send({ version: 999 })
        .expect(409);
      expect(conflict.body.error.code).toBe('CONTRACT_VERSION_CONFLICT');

      const version = await currentRowVersion(contractId);
      const res = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/revisions/${revision.body.data.id}/confirm`)
        .set(auth(ctx))
        .send({ version })
        .expect(200);
      expect(res.body.data.status).toBe('CHANGED');
      expect(res.body.data.versionNo).toBe(2);

      const orders = confirmBody.orders as Array<{ id: string; tradeType: string }>;
      const customOrder = orders.find((o) => o.tradeType === 'CUSTOM')!;
      const suits = await ctx.prisma.orderItem.findMany({
        where: { orderId: customOrder.id, productCategory: 'SUIT' },
        orderBy: { sequenceNo: 'asc' },
      });
      expect(suits.map((s) => s.displayName)).toEqual(['정장 #1', '정장 #2', '정장 #3']);
      expect(suits.every((s) => s.status !== 'CANCELLED')).toBe(true);

      const versions = await api(ctx).get(`/api/v1/contracts/${contractId}/versions`).set(auth(ctx)).expect(200);
      const v1 = versions.body.data.find((v: { versionNo: number }) => v.versionNo === 1);
      const v2 = versions.body.data.find((v: { versionNo: number }) => v.versionNo === 2);
      expect(v1.versionStatus).toBe('SUPERSEDED');
      expect(v2.versionStatus).toBe('CONFIRMED');
    });

    it('변경계약 수량 감소: 뒤 순번부터 CANCELLED 처리하고 물리 삭제하지 않는다', async () => {
      const revision = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/revisions`)
        .set(auth(ctx))
        .send({
          changeReason: '고객 요청으로 정장 2벌 축소',
          lines: [
            { transactionType: 'CUSTOM', productCategory: 'SUIT', quantity: 1 },
            { transactionType: 'CUSTOM', productCategory: 'SHIRT', quantity: 1 },
            { transactionType: 'RENTAL', productCategory: 'SHOES', quantity: 1 },
          ],
        })
        .expect(201);
      const version = await currentRowVersion(contractId);
      await api(ctx)
        .post(`/api/v1/contracts/${contractId}/revisions/${revision.body.data.id}/confirm`)
        .set(auth(ctx))
        .send({ version })
        .expect(200);

      const orders = confirmBody.orders as Array<{ id: string; tradeType: string }>;
      const customOrder = orders.find((o) => o.tradeType === 'CUSTOM')!;
      const suits = await ctx.prisma.orderItem.findMany({
        where: { orderId: customOrder.id, productCategory: 'SUIT' },
        orderBy: { sequenceNo: 'asc' },
      });
      // 물리 삭제 금지: 3건 모두 보존
      expect(suits).toHaveLength(3);
      expect(suits[0].status).not.toBe('CANCELLED');
      expect(suits[1].status).toBe('CANCELLED');
      expect(suits[2].status).toBe('CANCELLED');
      expect(suits[1].cancelledReason).toBe('고객 요청으로 정장 2벌 축소');
      expect(suits[2].cancelledAt).not.toBeNull();
    });

    it('변경 사유 없이 변경계약을 확정할 수 없다', async () => {
      const revision = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/revisions`)
        .set(auth(ctx))
        .send({ lines: [{ transactionType: 'CUSTOM', productCategory: 'SUIT', quantity: 2 }] })
        .expect(201);
      const version = await currentRowVersion(contractId);
      const res = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/revisions/${revision.body.data.id}/confirm`)
        .set(auth(ctx))
        .send({ version })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('작성 중인 변경계약 초안이 있으면 새 변경계약을 만들 수 없다', async () => {
      const res = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/revisions`)
        .set(auth(ctx))
        .send({ changeReason: '중복 시도' })
        .expect(409);
      expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('버전 목록을 이력 순서로 반환한다', async () => {
      const res = await api(ctx).get(`/api/v1/contracts/${contractId}/versions`).set(auth(ctx)).expect(200);
      expect(res.body.data.map((v: { versionNo: number }) => v.versionNo)).toEqual([1, 2, 3, 4]);
      expect(res.body.data.map((v: { versionStatus: string }) => v.versionStatus)).toEqual([
        'SUPERSEDED',
        'SUPERSEDED',
        'CONFIRMED',
        'DRAFT',
      ]);
    });

    it('계약 목록(customerId·검색)과 계약서 출력용 JSON을 제공한다', async () => {
      const list = await api(ctx)
        .get(`/api/v1/contracts?customerId=${customerId}`)
        .set(auth(ctx))
        .expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.page.totalElements).toBe(1);

      const contractNo = list.body.data[0].contractNo as string;
      const searched = await api(ctx).get(`/api/v1/contracts?search=${contractNo}`).set(auth(ctx)).expect(200);
      expect(searched.body.data.map((c: { id: string }) => c.id)).toContain(contractId);

      // q는 search 별칭, status 필터 지원 (연동정합화 계약 §3)
      const byAlias = await api(ctx).get(`/api/v1/contracts?q=${contractNo}`).set(auth(ctx)).expect(200);
      expect(byAlias.body.data.map((c: { id: string }) => c.id)).toContain(contractId);

      const byStatus = await api(ctx)
        .get(`/api/v1/contracts?customerId=${customerId}&status=CHANGED`)
        .set(auth(ctx))
        .expect(200);
      expect(byStatus.body.data).toHaveLength(1);
      const cancelled = await api(ctx)
        .get(`/api/v1/contracts?customerId=${customerId}&status=CANCELLED`)
        .set(auth(ctx))
        .expect(200);
      expect(cancelled.body.data).toHaveLength(0);

      const doc = await api(ctx).get(`/api/v1/contracts/${contractId}/document`).set(auth(ctx)).expect(200);
      expect(doc.body.data.contractNo).toBe(contractNo);
      expect(doc.body.data.customer.name).toBeDefined();
      expect(doc.body.data.version.versionNo).toBe(3);
      expect(doc.body.data.lines.length).toBeGreaterThan(0);
    });

    it('변경확정 body의 changeReason·금액·lines를 확정 직전 revision에 반영한다 (연동정합화 §3)', async () => {
      // 앞선 테스트에서 만들어진 v4 DRAFT(정장 2벌, 사유 없음)를 body 값으로 보정해 확정한다
      const versions = await api(ctx).get(`/api/v1/contracts/${contractId}/versions`).set(auth(ctx)).expect(200);
      const draft = versions.body.data.find((v: { versionStatus: string }) => v.versionStatus === 'DRAFT');
      expect(draft.versionNo).toBe(4);

      const version = await currentRowVersion(contractId);
      const res = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/revisions/${draft.id}/confirm`)
        .set(auth(ctx))
        .send({
          version,
          changeReason: '금액·구성 최종 조정',
          totalAmount: 2500000,
          depositAmount: 500000,
          lines: [
            { transactionType: 'CUSTOM', productCategory: 'SUIT', quantity: 2, lineAmount: 2000000 },
            { transactionType: 'CUSTOM', productCategory: 'SHIRT', quantity: 1, lineAmount: 200000 },
            { transactionType: 'RENTAL', productCategory: 'SHOES', quantity: 1, lineAmount: 300000 },
          ],
        })
        .expect(200);
      expect(res.body.data.status).toBe('CHANGED');
      expect(res.body.data.versionNo).toBe(4);
      expect(res.body.data.changeReason).toBe('금액·구성 최종 조정');

      const detail = await api(ctx).get(`/api/v1/contracts/${contractId}`).set(auth(ctx)).expect(200);
      const current = detail.body.data.currentVersion;
      expect(current.versionNo).toBe(4);
      expect(current.versionStatus).toBe('CONFIRMED');
      expect(Number(current.totalAmount)).toBe(2500000);
      expect(Number(current.depositAmount)).toBe(500000);
      expect(Number(current.balanceAmount)).toBe(2000000);
      expect(current.lines).toHaveLength(3);

      // 라인 반영 결과로 품목이 동기화된다: 정장 2벌(#4 신규), 셔츠·렌탈 구두 유지
      const orders = confirmBody.orders as Array<{ id: string; tradeType: string }>;
      const customOrder = orders.find((o) => o.tradeType === 'CUSTOM')!;
      const suits = await ctx.prisma.orderItem.findMany({
        where: { orderId: customOrder.id, productCategory: 'SUIT', status: { not: 'CANCELLED' } },
        orderBy: { sequenceNo: 'asc' },
      });
      expect(suits).toHaveLength(2);
      const shirts = await ctx.prisma.orderItem.findMany({
        where: { orderId: customOrder.id, productCategory: 'SHIRT', status: { not: 'CANCELLED' } },
      });
      expect(shirts).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 계약 취소
  // ---------------------------------------------------------------------------

  describe('계약 취소', () => {
    it('사유 필수, 미진행 품목을 CANCELLED 처리하고 물리 삭제하지 않는다', async () => {
      const customerId = await newCustomer();
      const created = await api(ctx)
        .post('/api/v1/contracts')
        .set(auth(ctx))
        .send({
          customerId,
          lines: [{ transactionType: 'CUSTOM', productCategory: 'SUIT', quantity: 1 }],
        })
        .expect(201);
      const contractId = created.body.data.id as string;
      const version = await currentRowVersion(contractId);
      await api(ctx).post(`/api/v1/contracts/${contractId}/confirm`).set(auth(ctx)).send({ version }).expect(200);

      // 사유 누락 → 400
      const noReason = await api(ctx).post(`/api/v1/contracts/${contractId}/cancel`).set(auth(ctx)).send({}).expect(400);
      expect(noReason.body.error.code).toBe('VALIDATION_ERROR');

      const res = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/cancel`)
        .set(auth(ctx))
        .send({ reason: '고객 단순 변심' })
        .expect(200);
      expect(res.body.data.status).toBe('CANCELLED');

      const items = await ctx.prisma.orderItem.findMany({
        where: { order: { contractId } },
        include: { components: true },
      });
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('CANCELLED');
      expect(items[0].cancelledReason).toBe('고객 단순 변심');
      expect(items[0].components.every((c) => c.status === 'CANCELLED')).toBe(true);

      // 감사로그에 사유가 남는다
      const logs = await ctx.prisma.auditLog.findMany({
        where: { entityType: 'CONTRACT', entityId: contractId, action: 'CANCEL' },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0].reason).toBe('고객 단순 변심');
    });
  });
});

/** 계약 목록 개편(06): 기간·고객·수납액 필터와 요약 */
describe('계약 목록 검색 (GET /contracts 확장)', () => {
  let ctx: TestContext;
  let hongId: string;
  let leeId: string;
  let suitTypeId: string;
  let suitTypeName: string;
  let rentalTypeId: string;
  /** 홍길동 3,000,000 계약(2026-06-10) / 홍길동 500,000 계약(2026-05-01) / 이순신 1,000,000 계약(2026-07-15) */
  let hongMainId: string;
  let hongOldId: string;
  let leeId2: string;

  /** 계약 + 확정 버전 생성 후 계약 id 반환 */
  async function seedContract(params: {
    contractNo: string;
    customerId: string;
    contractTypeId: string;
    contractedAt: string;
    totalAmount: number;
    completionDueDate?: string;
  }): Promise<string> {
    const admin = await ctx.prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
    const contractId = randomUUID();
    await ctx.prisma.contract.create({
      data: {
        id: contractId,
        contractNo: params.contractNo,
        customerId: params.customerId,
        contractTypeId: params.contractTypeId,
        status: 'CONFIRMED',
        contractedAt: new Date(params.contractedAt),
      },
    });
    const versionId = randomUUID();
    await ctx.prisma.contractVersion.create({
      data: {
        id: versionId,
        contractId,
        versionNo: 1,
        versionStatus: 'CONFIRMED',
        totalAmount: params.totalAmount,
        completionDueDate: params.completionDueDate ? new Date(params.completionDueDate) : null,
        createdBy: admin.id,
      },
    });
    await ctx.prisma.contract.update({ where: { id: contractId }, data: { currentVersionId: versionId } });
    return contractId;
  }

  async function seedPayment(
    contractId: string,
    paymentType: string,
    amount: number,
    paymentDate: string,
    status = 'COMPLETED',
  ): Promise<void> {
    const admin = await ctx.prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
    await ctx.prisma.payment.create({
      data: {
        id: randomUUID(),
        contractId,
        paymentType,
        amount,
        paymentDate: new Date(paymentDate),
        status,
        createdBy: admin.id,
      },
    });
  }

  beforeAll(async () => {
    ctx = await createTestContext([ContractsModule]);
    await truncateBusinessData(ctx.prisma);

    const suitType = await ctx.prisma.contractType.findFirstOrThrow({
      where: { code: 'BUSINESS_SUIT_CUSTOM' },
    });
    const rentalType = await ctx.prisma.contractType.findFirstOrThrow({
      where: { code: 'WEDDING_PACKAGE_RENTAL' },
    });
    suitTypeId = suitType.id;
    suitTypeName = suitType.name;
    rentalTypeId = rentalType.id;

    hongId = randomUUID();
    leeId = randomUUID();
    await ctx.prisma.customer.createMany({
      data: [
        { id: hongId, name: '홍길동', phone: '010-1111-2222', phoneNormalized: '01011112222' },
        { id: leeId, name: '이순신', phone: '010-3333-4444', phoneNormalized: '01033334444' },
      ],
    });

    hongMainId = await seedContract({
      contractNo: 'CTR-260610-001',
      customerId: hongId,
      contractTypeId: suitTypeId,
      contractedAt: '2026-06-10',
      totalAmount: 3_000_000,
      completionDueDate: '2026-09-01',
    });
    hongOldId = await seedContract({
      contractNo: 'CTR-260501-002',
      customerId: hongId,
      contractTypeId: suitTypeId,
      contractedAt: '2026-05-01',
      totalAmount: 500_000,
    });
    leeId2 = await seedContract({
      contractNo: 'CTR-260715-003',
      customerId: leeId,
      contractTypeId: rentalTypeId,
      contractedAt: '2026-07-15',
      totalAmount: 1_000_000,
    });

    // 홍길동 주계약: 수납 500,000 + 300,000 − 환불 100,000 = 700,000 (취소 200,000은 제외)
    await seedPayment(hongMainId, 'DEPOSIT', 500_000, '2026-06-10');
    await seedPayment(hongMainId, 'BALANCE', 300_000, '2026-07-05');
    await seedPayment(hongMainId, 'REFUND', 100_000, '2026-07-06');
    await seedPayment(hongMainId, 'ETC', 200_000, '2026-07-07', 'CANCELLED');
    // 이순신: 전액 수납
    await seedPayment(leeId2, 'DEPOSIT', 1_000_000, '2026-07-15');
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('기본 정렬은 계약일 내림차순이고 수납액·미수금·최근 결제일을 함께 반환한다', async () => {
    const res = await api(ctx).get('/api/v1/contracts').set(auth(ctx)).expect(200);
    expect(res.body.data.map((c: { contractNo: string }) => c.contractNo)).toEqual([
      'CTR-260715-003',
      'CTR-260610-001',
      'CTR-260501-002',
    ]);

    const main = res.body.data.find((c: { id: string }) => c.id === hongMainId);
    expect(main.paidAmount).toBe(700_000);
    expect(main.unpaidAmount).toBe(2_300_000);
    expect(main.lastPaymentDate).toBe('2026-07-06');

    const old = res.body.data.find((c: { id: string }) => c.id === hongOldId);
    expect(old.paidAmount).toBe(0);
    expect(old.lastPaymentDate).toBeNull();
  });

  it('계약일 범위는 경계일을 포함한다', async () => {
    const res = await api(ctx)
      .get('/api/v1/contracts')
      .query({ dateFrom: '2026-06-10', dateTo: '2026-07-15' })
      .set(auth(ctx))
      .expect(200);
    expect(res.body.data.map((c: { contractNo: string }) => c.contractNo)).toEqual([
      'CTR-260715-003',
      'CTR-260610-001',
    ]);
  });

  it('dateField=paymentDate는 해당 기간에 결제가 있는 계약만 반환한다', async () => {
    const res = await api(ctx)
      .get('/api/v1/contracts')
      .query({ dateField: 'paymentDate', dateFrom: '2026-07-01', dateTo: '2026-07-31' })
      .set(auth(ctx))
      .expect(200);
    const ids = res.body.data.map((c: { id: string }) => c.id);
    expect(ids).toHaveLength(2);
    expect(ids).toEqual(expect.arrayContaining([hongMainId, leeId2]));
    expect(ids).not.toContain(hongOldId);
  });

  it('q로 고객 전화번호(하이픈 무관)와 계약 구분명을 검색한다', async () => {
    const byPhone = await api(ctx)
      .get('/api/v1/contracts')
      .query({ q: '010-3333-4444' })
      .set(auth(ctx))
      .expect(200);
    expect(byPhone.body.data.map((c: { id: string }) => c.id)).toEqual([leeId2]);

    const byDigits = await api(ctx).get('/api/v1/contracts').query({ q: '33334444' }).set(auth(ctx)).expect(200);
    expect(byDigits.body.data.map((c: { id: string }) => c.id)).toEqual([leeId2]);

    const byTypeName = await api(ctx)
      .get('/api/v1/contracts')
      .query({ q: suitTypeName })
      .set(auth(ctx))
      .expect(200);
    expect(byTypeName.body.data.map((c: { id: string }) => c.id)).toEqual(
      expect.arrayContaining([hongMainId, hongOldId]),
    );
  });

  it('contractTypeId 필터와 unpaidOnly가 동작한다', async () => {
    const byType = await api(ctx)
      .get('/api/v1/contracts')
      .query({ contractTypeId: rentalTypeId })
      .set(auth(ctx))
      .expect(200);
    expect(byType.body.data.map((c: { id: string }) => c.id)).toEqual([leeId2]);

    // 전액 수납된 이순신 계약은 제외된다
    const unpaid = await api(ctx).get('/api/v1/contracts').query({ unpaidOnly: true }).set(auth(ctx)).expect(200);
    const ids = unpaid.body.data.map((c: { id: string }) => c.id);
    expect(ids).toEqual(expect.arrayContaining([hongMainId, hongOldId]));
    expect(ids).not.toContain(leeId2);
  });

  it('totals는 페이지가 아니라 필터 전체 기준이다', async () => {
    const res = await api(ctx).get('/api/v1/contracts').query({ page: 1, size: 1 }).set(auth(ctx)).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.page.totalElements).toBe(3);
    expect(res.body.totals).toEqual({
      count: 3,
      totalAmount: 4_500_000,
      paidAmount: 1_700_000,
      unpaidAmount: 2_800_000,
    });
  });

  it('sort로 계약일 오름차순·미수금 내림차순 정렬을 지원한다', async () => {
    const asc = await api(ctx)
      .get('/api/v1/contracts')
      .query({ sort: 'contractedAt,asc' })
      .set(auth(ctx))
      .expect(200);
    expect(asc.body.data.map((c: { contractNo: string }) => c.contractNo)).toEqual([
      'CTR-260501-002',
      'CTR-260610-001',
      'CTR-260715-003',
    ]);

    const byUnpaid = await api(ctx)
      .get('/api/v1/contracts')
      .query({ sort: 'unpaidAmount,desc' })
      .set(auth(ctx))
      .expect(200);
    expect(byUnpaid.body.data.map((c: { id: string }) => c.id)).toEqual([hongMainId, hongOldId, leeId2]);
  });

  it('잘못된 기간 형식과 정렬 형식은 VALIDATION_ERROR를 반환한다', async () => {
    await api(ctx).get('/api/v1/contracts').query({ dateFrom: '2026/06/01' }).set(auth(ctx)).expect(400);
    await api(ctx).get('/api/v1/contracts').query({ sort: 'contractedAt;drop' }).set(auth(ctx)).expect(400);
  });
});
