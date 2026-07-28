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
    const seedCodes = [
      'BUSINESS_SUIT_CUSTOM',
      'SHOES_CUSTOM',
      'SUIT_SHOES_CUSTOM',
      'WEDDING_PACKAGE_RENTAL',
    ];
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

  /** 유효한 1x1 흰 PNG dataURL — 서명 게이팅(v2 D4) 충족용 */
  const SIGNATURE_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  /** 현재 DRAFT 버전에 서명을 저장한다 — 확정(계약완료) 전제조건. */
  async function signDraft(contractId: string): Promise<void> {
    const versions = await api(ctx)
      .get(`/api/v1/contracts/${contractId}/versions`)
      .set(auth(ctx))
      .expect(200);
    const draft = versions.body.data.find((v: { versionStatus: string }) => v.versionStatus === 'DRAFT');
    await api(ctx)
      .post(`/api/v1/contracts/${contractId}/versions/${draft.id}/signature`)
      .set(auth(ctx))
      .send({ imageDataUrl: SIGNATURE_PNG, signerName: '고객서명' })
      .expect(201);
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
      await signDraft(contractId);
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

    it('계약 확정은 주문별 진행(journey)을 CONTRACT_CONFIRMED 단계로 시작시킨다 (설계서 07 §7.1)', async () => {
      const orders = confirmBody.orders as Array<{ id: string; tradeType: string }>;
      const journeys = await ctx.prisma.customerJourney.findMany({
        where: { customerId, status: 'ACTIVE' },
        orderBy: { trackType: 'asc' },
      });
      // 주문 1건당 진행 1건 — CUSTOM·RENTAL 각각
      expect(journeys).toHaveLength(2);
      expect(journeys.map((j) => j.trackType)).toEqual(['CUSTOM', 'RENTAL']);
      for (const journey of journeys) {
        expect(journey.currentStageCode).toBe('CONTRACT_CONFIRMED');
        const order = orders.find((o) => o.tradeType === journey.trackType)!;
        expect(journey.orderId).toBe(order.id);
        // 시작 이력이 이벤트로 남는다
        const events = await ctx.prisma.journeyEvent.findMany({ where: { journeyId: journey.id } });
        expect(events.some((e) => e.toStageCode === 'CONTRACT_CONFIRMED')).toBe(true);
      }
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

      await signDraft(contractId);
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
      await signDraft(contractId);
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
      await signDraft(contractId);
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

      // 라인은 주문품목(정장 #1 …) × 부위 계층을 함께 싣는다 (v2 계약관리)
      const suitLine = doc.body.data.lines.find(
        (l: { productCategory: string }) => l.productCategory === 'SUIT',
      );
      expect(suitLine.items.length).toBeGreaterThan(0);
      const item = suitLine.items[0];
      expect(item.displayName).toMatch(/#\d+$/);
      expect(item.components.map((c: { groupLabel: string }) => c.groupLabel)).toEqual(
        expect.arrayContaining(['상의(자켓)', '하의(바지)']),
      );
      // 옵션 미선택이면 부위 행은 남고 옵션은 비어 있다
      expect(item.components.every((c: { options: unknown[] }) => Array.isArray(c.options))).toBe(true);
      expect(item.optionTotal).toBe(0);
      // 추가금액 0원 옵션은 계약서에 싣지 않는다
      expect(
        (doc.body.data.options as { extraPrice: number }[]).every((o) => Number(o.extraPrice) > 0),
      ).toBe(true);
    });

    it('변경확정 body의 changeReason·금액·lines를 확정 직전 revision에 반영한다 (연동정합화 §3)', async () => {
      // 앞선 테스트에서 만들어진 v4 DRAFT(정장 2벌, 사유 없음)를 body 값으로 보정해 확정한다
      const versions = await api(ctx).get(`/api/v1/contracts/${contractId}/versions`).set(auth(ctx)).expect(200);
      const draft = versions.body.data.find((v: { versionStatus: string }) => v.versionStatus === 'DRAFT');
      expect(draft.versionNo).toBe(4);

      await signDraft(contractId);
      const version = await currentRowVersion(contractId);
      const res = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/revisions/${draft.id}/confirm`)
        .set(auth(ctx))
        .send({
          version,
          changeReason: '금액·구성 최종 조정',
          totalAmount: 2500000,
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
      await signDraft(contractId);
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

  // ---------------------------------------------------------------------------
  // 계약 삭제 (임시저장·취소 한정)
  // ---------------------------------------------------------------------------

  describe('계약 삭제', () => {
    it('임시저장 계약은 버전·라인까지 삭제된다', async () => {
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

      await api(ctx).delete(`/api/v1/contracts/${contractId}`).set(auth(ctx)).expect(200);

      expect(await ctx.prisma.contract.findUnique({ where: { id: contractId } })).toBeNull();
      expect(await ctx.prisma.contractVersion.count({ where: { contractId } })).toBe(0);
      const logs = await ctx.prisma.auditLog.findMany({
        where: { entityType: 'CONTRACT', entityId: contractId, action: 'DELETE' },
      });
      expect(logs).toHaveLength(1);
      await api(ctx).get(`/api/v1/contracts/${contractId}`).set(auth(ctx)).expect(404);
    });

    it('확정된 계약은 삭제할 수 없고, 취소하면 주문까지 함께 삭제된다', async () => {
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
      await signDraft(contractId);
      await api(ctx)
        .post(`/api/v1/contracts/${contractId}/confirm`)
        .set(auth(ctx))
        .send({ version: await currentRowVersion(contractId) })
        .expect(200);

      // 확정 상태 → 거부
      const denied = await api(ctx).delete(`/api/v1/contracts/${contractId}`).set(auth(ctx)).expect(409);
      expect(denied.body.error.code).toBe('CONTRACT_NOT_DELETABLE');

      await api(ctx)
        .post(`/api/v1/contracts/${contractId}/cancel`)
        .set(auth(ctx))
        .send({ reason: '중복 계약' })
        .expect(200);

      await api(ctx).delete(`/api/v1/contracts/${contractId}`).set(auth(ctx)).expect(200);
      expect(await ctx.prisma.contract.findUnique({ where: { id: contractId } })).toBeNull();
      expect(await ctx.prisma.order.count({ where: { contractId } })).toBe(0);
    });

    it('진행 이력(채촌 연결)이 있는 취소 계약은 삭제를 거부한다', async () => {
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
      await signDraft(contractId);
      await api(ctx)
        .post(`/api/v1/contracts/${contractId}/confirm`)
        .set(auth(ctx))
        .send({ version: await currentRowVersion(contractId) })
        .expect(200);
      await api(ctx)
        .post(`/api/v1/contracts/${contractId}/cancel`)
        .set(auth(ctx))
        .send({ reason: '고객 변심' })
        .expect(200);

      // 채촌 세션을 품목에 연결해 '진행 이력'을 만든다.
      const item = await ctx.prisma.orderItem.findFirstOrThrow({ where: { order: { contractId } } });
      const admin = await ctx.prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
      const session = await ctx.prisma.measurementSession.create({
        data: {
          id: randomUUID(),
          customerId,
          versionNo: 1,
          measurementDate: new Date(),
          createdBy: admin.id,
        },
      });
      await ctx.prisma.orderItemMeasurement.create({
        data: {
          id: randomUUID(),
          orderItemId: item.id,
          measurementSessionId: session.id,
          linkedBy: admin.id,
          linkedAt: new Date(),
        },
      });

      const res = await api(ctx).delete(`/api/v1/contracts/${contractId}`).set(auth(ctx)).expect(409);
      expect(res.body.error.code).toBe('CONTRACT_NOT_DELETABLE');
      expect(res.body.error.message).toContain('채촌 연결');
      expect(await ctx.prisma.contract.findUnique({ where: { id: contractId } })).not.toBeNull();
    });
  });
});

/** v2 계약 서명·엑셀 (설계서 03 / D4·D7) */
describe('계약 서명·엑셀 (v2)', () => {
  let ctx: TestContext;
  const SIGN_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  beforeAll(async () => {
    ctx = await createTestContext([ContractsModule, OrdersModule]);
    await truncateBusinessData(ctx.prisma);
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  async function newCustomer(): Promise<string> {
    const c = await ctx.prisma.customer.create({
      data: {
        id: randomUUID(),
        name: `서명고객-${randomUUID().slice(0, 6)}`,
        phone: '010-2222-3333',
        phoneNormalized: `${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(0, 20),
      },
    });
    return c.id;
  }

  async function draftContract(): Promise<{ contractId: string; versionId: string }> {
    const customerId = await newCustomer();
    const created = await api(ctx)
      .post('/api/v1/contracts')
      .set(auth(ctx))
      .send({
        customerId,
        totalAmount: 1_500_000,
        lines: [{ transactionType: 'CUSTOM', productCategory: 'SUIT', quantity: 1 }],
      })
      .expect(201);
    const contractId = created.body.data.id as string;
    const draft = await ctx.prisma.contractVersion.findFirstOrThrow({
      where: { contractId, versionStatus: 'DRAFT' },
    });
    return { contractId, versionId: draft.id };
  }

  it('서명 없이 확정하면 CONTRACT_SIGNATURE_REQUIRED(409)로 막는다', async () => {
    const { contractId } = await draftContract();
    const version = (await ctx.prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).rowVersion;
    const res = await api(ctx)
      .post(`/api/v1/contracts/${contractId}/confirm`)
      .set(auth(ctx))
      .send({ version })
      .expect(409);
    expect(res.body.error.code).toBe('CONTRACT_SIGNATURE_REQUIRED');
  });

  it('서명 저장 후 확정에 성공하고, 비PNG는 거부한다', async () => {
    const { contractId, versionId } = await draftContract();

    const badType = await api(ctx)
      .post(`/api/v1/contracts/${contractId}/versions/${versionId}/signature`)
      .set(auth(ctx))
      .send({ imageDataUrl: 'data:image/jpeg;base64,AAAA', signerName: '홍길동' });
    expect(badType.status).toBe(400);

    const saved = await api(ctx)
      .post(`/api/v1/contracts/${contractId}/versions/${versionId}/signature`)
      .set(auth(ctx))
      .send({ imageDataUrl: SIGN_PNG, signerName: '홍길동' })
      .expect(201);
    expect(saved.body.data).toMatchObject({ versionId, signerName: '홍길동' });
    expect(saved.body.data.signatureFileId).toBeTruthy();

    const version = (await ctx.prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).rowVersion;
    await api(ctx).post(`/api/v1/contracts/${contractId}/confirm`).set(auth(ctx)).send({ version }).expect(200);

    // 감사로그에 SIGN이 남는다
    const signLogs = await ctx.prisma.auditLog.findMany({
      where: { entityType: 'CONTRACT_VERSION', action: 'SIGN', entityId: versionId },
    });
    expect(signLogs).toHaveLength(1);
  });

  it('서명 있는 초안을 수정하면 서명이 무효화된다', async () => {
    const { contractId, versionId } = await draftContract();
    await api(ctx)
      .post(`/api/v1/contracts/${contractId}/versions/${versionId}/signature`)
      .set(auth(ctx))
      .send({ imageDataUrl: SIGN_PNG, signerName: '홍길동' })
      .expect(201);

    await api(ctx)
      .patch(`/api/v1/contracts/${contractId}`)
      .set(auth(ctx))
      .send({ totalAmount: 1_600_000 })
      .expect(200);

    const v = await ctx.prisma.contractVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(v.signatureFileId).toBeNull();
    expect(v.signedAt).toBeNull();
  });

  it('계약서 엑셀을 다운로드한다 (xlsx)', async () => {
    const { contractId, versionId } = await draftContract();
    await api(ctx)
      .post(`/api/v1/contracts/${contractId}/versions/${versionId}/signature`)
      .set(auth(ctx))
      .send({ imageDataUrl: SIGN_PNG, signerName: '홍길동' })
      .expect(201);
    const version = (await ctx.prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).rowVersion;
    await api(ctx).post(`/api/v1/contracts/${contractId}/confirm`).set(auth(ctx)).send({ version }).expect(200);

    const res = await api(ctx).get(`/api/v1/contracts/${contractId}/excel`).set(auth(ctx)).expect(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(Number(res.headers['content-length'])).toBeGreaterThan(0);

    const logs = await ctx.prisma.auditLog.findMany({
      where: { entityType: 'CONTRACT', action: 'EXPORT', entityId: contractId },
    });
    expect(logs.length).toBeGreaterThanOrEqual(1);
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
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('기본 정렬은 계약일 내림차순이다', async () => {
    const res = await api(ctx).get('/api/v1/contracts').set(auth(ctx)).expect(200);
    expect(res.body.data.map((c: { contractNo: string }) => c.contractNo)).toEqual([
      'CTR-260715-003',
      'CTR-260610-001',
      'CTR-260501-002',
    ]);
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

  it('contractTypeId 필터가 동작한다', async () => {
    const byType = await api(ctx)
      .get('/api/v1/contracts')
      .query({ contractTypeId: rentalTypeId })
      .set(auth(ctx))
      .expect(200);
    expect(byType.body.data.map((c: { id: string }) => c.id)).toEqual([leeId2]);
  });

  it('totals는 페이지가 아니라 필터 전체 기준이다', async () => {
    const res = await api(ctx).get('/api/v1/contracts').query({ page: 1, size: 1 }).set(auth(ctx)).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.page.totalElements).toBe(3);
    expect(res.body.totals).toEqual({
      count: 3,
      totalAmount: 4_500_000,
    });
  });

  it('sort로 계약일 오름차순 정렬을 지원한다', async () => {
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
  });

  it('임시저장 초안(계약일 없음)도 기간 조회에 작성일 기준으로 잡힌다', async () => {
    const draftId = randomUUID();
    await ctx.prisma.contract.create({
      data: {
        id: draftId,
        contractNo: 'CTR-DRAFT-009',
        customerId: hongId,
        contractTypeId: suitTypeId,
        status: 'DRAFT',
        contractedAt: null,
      },
    });
    const day = (offset: number) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return d.toISOString().slice(0, 10);
    };

    try {
      const res = await api(ctx)
        .get('/api/v1/contracts')
        .query({ dateFrom: day(-1), dateTo: day(1) })
        .set(auth(ctx))
        .expect(200);
      expect(res.body.data.map((c: { id: string }) => c.id)).toContain(draftId);

      // 기간 + 검색어를 함께 걸어도 조건이 서로 덮이지 않는다.
      const withSearch = await api(ctx)
        .get('/api/v1/contracts')
        .query({ dateFrom: day(-1), dateTo: day(1), q: 'CTR-DRAFT-009' })
        .set(auth(ctx))
        .expect(200);
      expect(withSearch.body.data.map((c: { id: string }) => c.id)).toEqual([draftId]);

      // 작성일 밖의 기간에는 잡히지 않는다.
      const outside = await api(ctx)
        .get('/api/v1/contracts')
        .query({ dateFrom: '2026-05-01', dateTo: '2026-05-02' })
        .set(auth(ctx))
        .expect(200);
      expect(outside.body.data.map((c: { id: string }) => c.id)).not.toContain(draftId);
    } finally {
      await ctx.prisma.contract.delete({ where: { id: draftId } });
    }
  });

  it('잘못된 기간 형식과 정렬 형식은 VALIDATION_ERROR를 반환한다', async () => {
    await api(ctx).get('/api/v1/contracts').query({ dateFrom: '2026/06/01' }).set(auth(ctx)).expect(400);
    await api(ctx).get('/api/v1/contracts').query({ sort: 'contractedAt;drop' }).set(auth(ctx)).expect(400);
  });
});
