import { randomUUID } from 'crypto';
import { ContractsModule } from '../../backend/src/modules/contracts/contracts.module';
import { OrdersModule } from '../../backend/src/modules/orders/orders.module';
import {
  api,
  auth,
  createTestContext,
  signAndCompleteContract,
  SIGN_PNG,
  TestContext,
  truncateBusinessData,
} from './helpers';

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

  describe('계약완료·수정하기(버전업)', () => {
    let contractId: string;
    let customerId: string;
    let orders: { id: string; orderNo: string; tradeType: string }[];
    let customOrderId: string;

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

    it('작성중 계약은 완료할 수 없다 — 서명이 먼저다', async () => {
      const version = await currentRowVersion(contractId);
      const res = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/complete`)
        .set(auth(ctx))
        .send({ version })
        .expect(409);
      expect(res.body.error.code).toBe('CONTRACT_NOT_COMPLETABLE');
    });

    it('계약완료 시 CUSTOM/RENTAL 주문 분리·수량만큼 품목 펼침·고객 CONTRACTED 전환이 한 번에 처리된다', async () => {
      const result = await signAndCompleteContract(ctx, contractId);
      orders = result.orders;
      expect(orders).toHaveLength(2);
      expect(orders.map((o) => o.tradeType).sort()).toEqual(['CUSTOM', 'RENTAL']);
      customOrderId = orders.find((o) => o.tradeType === 'CUSTOM')!.id;

      // 수량만큼 벌 단위로 펼쳐진다
      const customItems = await ctx.prisma.orderItem.findMany({
        where: { orderId: customOrderId },
        orderBy: [{ productCategory: 'asc' }, { sequenceNo: 'asc' }],
      });
      expect(customItems.map((i) => i.displayName)).toEqual(['셔츠 #1', '정장 #1', '정장 #2']);

      const detail = await api(ctx).get(`/api/v1/contracts/${contractId}`).set(auth(ctx)).expect(200);
      expect(detail.body.data.status).toBe('COMPLETED');
      expect(detail.body.data.currentVersion.versionStatus).toBe('CONFIRMED');
      // 계약일은 완료 시점에 정해진다
      expect(detail.body.data.contractedAt).toBeTruthy();

      const customer = await ctx.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
      expect(customer.customerStatus).toBe('CONTRACTED');
    });

    it('계약완료는 주문별 진행(journey)을 CONTRACT_CONFIRMED 단계로 시작시킨다 (설계서 07 §7.1)', async () => {
      const journeys = await ctx.prisma.customerJourney.findMany({
        where: { customerId, status: 'ACTIVE' },
        orderBy: { trackType: 'asc' },
      });
      expect(journeys).toHaveLength(2);
      expect(journeys.map((j) => j.trackType)).toEqual(['CUSTOM', 'RENTAL']);
      for (const journey of journeys) {
        expect(journey.currentStageCode).toBe('CONTRACT_CONFIRMED');
        const order = orders.find((o) => o.tradeType === journey.trackType)!;
        expect(journey.orderId).toBe(order.id);
        const events = await ctx.prisma.journeyEvent.findMany({ where: { journeyId: journey.id } });
        expect(events.some((e) => e.toStageCode === 'CONTRACT_CONFIRMED')).toBe(true);
      }
    });

    it('완료된 계약의 직접 수정은 CONTRACT_NOT_DRAFT로 차단된다 (수정하기를 거쳐야 한다)', async () => {
      const res = await api(ctx)
        .patch(`/api/v1/contracts/${contractId}`)
        .set(auth(ctx))
        .send({ totalAmount: 999 })
        .expect(409);
      expect(res.body.error.code).toBe('CONTRACT_NOT_DRAFT');
    });

    it('완료된 계약을 다시 완료할 수 없다', async () => {
      const version = await currentRowVersion(contractId);
      const res = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/complete`)
        .set(auth(ctx))
        .send({ version })
        .expect(409);
      expect(res.body.error.code).toBe('CONTRACT_NOT_COMPLETABLE');
    });

    it('완료된 계약은 취소할 수 없다 — 취소는 작성중에서만', async () => {
      const version = await currentRowVersion(contractId);
      const res = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/cancel`)
        .set(auth(ctx))
        .send({ reason: '고객 변심', version })
        .expect(409);
      expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    });

    // -------------------------------------------------------------------------
    // 수정하기(버전업) — 계약서 문서의 버전업. 하위 데이터는 이어진다.
    // -------------------------------------------------------------------------

    it('수정하기는 새 버전을 만들고 상태를 작성중으로 되돌린다', async () => {
      const res = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/revisions`)
        .set(auth(ctx))
        .send({ changeReason: '정장 1벌 추가 요청' })
        .expect(201);
      expect(res.body.data.versionNo).toBe(2);
      expect(res.body.data.versionStatus).toBe('DRAFT');

      const detail = await api(ctx).get(`/api/v1/contracts/${contractId}`).set(auth(ctx)).expect(200);
      expect(detail.body.data.status).toBe('DRAFT');
      expect(detail.body.data.currentVersion.versionNo).toBe(2);
      // 라인은 그대로 복사된다
      expect(detail.body.data.currentVersion.lines).toHaveLength(3);
    });

    it('수정하기는 계약 품목·컨설팅 선택·주문품목을 그대로 이어간다 (취소·재계약이 아니다)', async () => {
      // 계약 품목은 계약 소유이므로 버전업으로 새로 생기지 않는다
      const items = await ctx.prisma.contractItem.findMany({
        where: { contractId, status: { not: 'CANCELLED' } },
      });
      expect(items).toHaveLength(4); // 정장 2 + 셔츠 1 + 렌탈 구두 1

      // 컨설팅 선택(확정 세션)이 살아 있다
      const confirmedSessions = await ctx.prisma.optionSelectionSession.count({
        where: { contractItem: { contractId }, isCurrent: true, status: 'CONFIRMED' },
      });
      expect(confirmedSessions).toBe(3); // 맞춤 품목 3건

      // 주문품목도 그대로 — 중복 생성되지 않는다
      const orderItems = await ctx.prisma.orderItem.findMany({ where: { orderId: customOrderId } });
      expect(orderItems).toHaveLength(3);
    });

    it('수량을 늘리면 늘어난 품목만 새로 생기고 기존 품목·주문품목은 유지된다', async () => {
      await api(ctx)
        .patch(`/api/v1/contracts/${contractId}`)
        .set(auth(ctx))
        .send({
          lines: [
            { transactionType: 'CUSTOM', productCategory: 'SUIT', quantity: 3 },
            { transactionType: 'CUSTOM', productCategory: 'SHIRT', quantity: 1 },
            { transactionType: 'RENTAL', productCategory: 'SHOES', quantity: 1 },
          ],
        })
        .expect(200);

      const suits = await ctx.prisma.contractItem.findMany({
        where: { contractId, productCategory: 'SUIT', transactionType: 'CUSTOM' },
        orderBy: { sequenceNo: 'asc' },
      });
      expect(suits.map((i) => i.displayName)).toEqual(['정장 #1', '정장 #2', '정장 #3']);
      // 새로 생긴 정장 #3만 컨설팅 미선택이다
      const fresh = suits[2];
      const freshSessions = await ctx.prisma.optionSelectionSession.count({
        where: { contractItemId: fresh.id },
      });
      expect(freshSessions).toBe(0);

      // 주문품목은 아직 그대로 — 물리화는 계약완료 시점이다
      const orderItems = await ctx.prisma.orderItem.findMany({ where: { orderId: customOrderId } });
      expect(orderItems).toHaveLength(3);
    });

    it('다시 서명·완료하면 늘어난 품목만 주문품목으로 추가된다 (중복 생성 없음)', async () => {
      const result = await signAndCompleteContract(ctx, contractId);
      expect(result.versionNo).toBe(2);
      // 주문은 새로 생기지 않는다 (계약당 거래방식별 1건)
      expect(await ctx.prisma.order.count({ where: { contractId } })).toBe(2);

      const suits = await ctx.prisma.orderItem.findMany({
        where: { orderId: customOrderId, productCategory: 'SUIT' },
        orderBy: { sequenceNo: 'asc' },
      });
      expect(suits.map((s) => s.displayName)).toEqual(['정장 #1', '정장 #2', '정장 #3']);
      expect(suits.every((s) => s.status !== 'CANCELLED')).toBe(true);

      // 이전 버전은 SUPERSEDED로 보존된다
      const versions = await api(ctx).get(`/api/v1/contracts/${contractId}/versions`).set(auth(ctx)).expect(200);
      const v1 = versions.body.data.find((v: { versionNo: number }) => v.versionNo === 1);
      const v2 = versions.body.data.find((v: { versionNo: number }) => v.versionNo === 2);
      expect(v1.versionStatus).toBe('SUPERSEDED');
      expect(v2.versionStatus).toBe('CONFIRMED');
    });

    it('주문으로 물리화된 품목은 수량을 줄일 수 없다 — 수정하기는 품목 추가 전용 (현업 확정 2026-07-31)', async () => {
      await api(ctx)
        .post(`/api/v1/contracts/${contractId}/revisions`)
        .set(auth(ctx))
        .send({ changeReason: '고객 요청으로 정장 2벌 축소' })
        .expect(201);
      const res = await api(ctx)
        .patch(`/api/v1/contracts/${contractId}`)
        .set(auth(ctx))
        .send({
          lines: [
            { transactionType: 'CUSTOM', productCategory: 'SUIT', quantity: 1 },
            { transactionType: 'CUSTOM', productCategory: 'SHIRT', quantity: 1 },
            { transactionType: 'RENTAL', productCategory: 'SHOES', quantity: 1 },
          ],
        })
        .expect(409);
      expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');

      // 품목은 그대로 보존된다 — 정리가 필요하면 계약 취소(주문 전) 또는 오프라인으로 처리한다.
      const suits = await ctx.prisma.contractItem.findMany({
        where: { contractId, productCategory: 'SUIT', transactionType: 'CUSTOM' },
        orderBy: { sequenceNo: 'asc' },
      });
      expect(suits).toHaveLength(3);
      expect(suits.every((s) => s.status !== 'CANCELLED')).toBe(true);
    });

    it('사유 없이 수정할 수 없고, 수정 중이면 새 수정을 시작할 수 없다', async () => {
      // 지금은 v3 작성중 — 수정 중이므로 새 수정 거부
      const dup = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/revisions`)
        .set(auth(ctx))
        .send({ changeReason: '중복 수정' })
        .expect(409);
      expect(dup.body.error.code).toBe('INVALID_STATUS_TRANSITION');

      // 완료 상태로 되돌린 뒤 사유 없이 시도하면 검증 오류
      await signAndCompleteContract(ctx, contractId);
      const noReason = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/revisions`)
        .set(auth(ctx))
        .send({})
        .expect(400);
      expect(noReason.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('버전 목록을 이력 순서로 반환한다', async () => {
      const res = await api(ctx).get(`/api/v1/contracts/${contractId}/versions`).set(auth(ctx)).expect(200);
      expect(res.body.data.map((v: { versionNo: number }) => v.versionNo)).toEqual([1, 2, 3]);
      expect(res.body.data.map((v: { versionStatus: string }) => v.versionStatus)).toEqual([
        'SUPERSEDED',
        'SUPERSEDED',
        'CONFIRMED',
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
        .get(`/api/v1/contracts?customerId=${customerId}&status=COMPLETED`)
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

      // 사유 누락 → 400
      const noReason = await api(ctx).post(`/api/v1/contracts/${contractId}/cancel`).set(auth(ctx)).send({}).expect(400);
      expect(noReason.body.error.code).toBe('VALIDATION_ERROR');

      const res = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/cancel`)
        .set(auth(ctx))
        .send({ reason: '고객 단순 변심' })
        .expect(200);
      expect(res.body.data.status).toBe('CANCELLED');

      // 작성중 취소이므로 주문은 없고, 계약 품목이 취소된다
      expect(await ctx.prisma.order.count({ where: { contractId } })).toBe(0);
      const items = await ctx.prisma.contractItem.findMany({
        where: { contractId },
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
      await signAndCompleteContract(ctx, contractId);

      // 완료 상태 → 거부
      const denied = await api(ctx).delete(`/api/v1/contracts/${contractId}`).set(auth(ctx)).expect(409);
      expect(denied.body.error.code).toBe('CONTRACT_NOT_DELETABLE');

      // 완료 계약은 취소도 막힌다 — 정리는 수정하기로 한다
      const cancelDenied = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/cancel`)
        .set(auth(ctx))
        .send({ reason: '중복 계약', version: await currentRowVersion(contractId) })
        .expect(409);
      expect(cancelDenied.body.error.code).toBe('INVALID_STATUS_TRANSITION');
      expect(await ctx.prisma.order.count({ where: { contractId } })).toBe(1);
    });

    it('취소한 계약은 버전·품목까지 삭제된다', async () => {
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
      await api(ctx)
        .post(`/api/v1/contracts/${contractId}/cancel`)
        .set(auth(ctx))
        .send({ reason: '중복 계약' })
        .expect(200);

      await api(ctx).delete(`/api/v1/contracts/${contractId}`).set(auth(ctx)).expect(200);
      expect(await ctx.prisma.contract.findUnique({ where: { id: contractId } })).toBeNull();
      expect(await ctx.prisma.contractItem.count({ where: { contractId } })).toBe(0);
    });

    it('주문이 생성된 계약은 수정하기로 작성중이 돼도 취소·삭제할 수 없다 (현업 확정 2026-07-31)', async () => {
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
      await signAndCompleteContract(ctx, contractId);
      // 완료 → 수정하기로 작성중으로 되돌린다 (주문은 살아 있다).
      await api(ctx)
        .post(`/api/v1/contracts/${contractId}/revisions`)
        .set(auth(ctx))
        .send({ changeReason: '고객 변심으로 정리' })
        .expect(201);

      // 작성중이지만 주문이 있으므로 취소가 막힌다 — 실물 정리는 오프라인·렌탈 메뉴에서.
      const cancelDenied = await api(ctx)
        .post(`/api/v1/contracts/${contractId}/cancel`)
        .set(auth(ctx))
        .send({ reason: '고객 변심', version: await currentRowVersion(contractId) })
        .expect(409);
      expect(cancelDenied.body.error.code).toBe('INVALID_STATUS_TRANSITION');
      expect(cancelDenied.body.error.message).toContain('주문');

      // 삭제도 막힌다 — 작성중이 "완료 후 재작성"을 겸하므로 주문 존재로 가른다.
      const res = await api(ctx).delete(`/api/v1/contracts/${contractId}`).set(auth(ctx)).expect(409);
      expect(res.body.error.code).toBe('CONTRACT_NOT_DELETABLE');
      expect(res.body.error.message).toContain('주문');
      expect(await ctx.prisma.contract.findUnique({ where: { id: contractId } })).not.toBeNull();
    });
  });
});

/** v2 계약 서명·엑셀 (설계서 03 / D4·D7) */
describe('계약 흐름 — 작성중→컨설팅→서명완료→계약완료 (현업 확정 2026-07-30)', () => {
  let ctx: TestContext;
  let adminId: string;
  let optionSetVersionId: string;

  beforeAll(async () => {
    ctx = await createTestContext([ContractsModule, OrdersModule]);
    await truncateBusinessData(ctx.prisma);
    const admin = await ctx.prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
    adminId = admin.id;
    const optionSet = await ctx.prisma.optionSet.findUniqueOrThrow({ where: { productCategory: 'SUIT' } });
    optionSetVersionId = randomUUID();
    await ctx.prisma.optionSetVersion.create({
      data: { id: optionSetVersionId, optionSetId: optionSet.id, versionNo: 1, status: 'ACTIVE', createdBy: adminId },
    });
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

  const rowVersion = async (contractId: string): Promise<number> =>
    (await ctx.prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).rowVersion;

  /**
   * 스타일 컨설팅 확정 — 계약 품목마다 확정된 옵션 선택 세션을 만든다.
   * 컨설팅은 작성중 단계의 계약 품목(ContractItem)에서 한다.
   */
  async function confirmConsulting(contractId: string): Promise<void> {
    const items = await ctx.prisma.contractItem.findMany({
      where: { contractId, status: { not: 'CANCELLED' } },
    });
    for (const item of items) {
      await ctx.prisma.optionSelectionSession.create({
        data: {
          id: randomUUID(),
          contractItemId: item.id,
          optionSetVersionId,
          selectionVersionNo: 1,
          status: 'CONFIRMED',
          confirmedAt: new Date(),
          isCurrent: true,
        },
      });
    }
  }

  /** 작성중 → 컨설팅 확정 → 서명(서명완료) */
  async function signedContract(): Promise<{ contractId: string; currentVersionId: string }> {
    const { contractId, versionId } = await draftContract();
    await confirmConsulting(contractId);
    await sign(contractId, versionId).expect(201);
    return { contractId, currentVersionId: versionId };
  }

  /** supertest 요청을 그대로 돌려준다 — 호출부가 .expect(...)로 상태를 못 박는다. */
  function sign(contractId: string, versionId: string) {
    return api(ctx)
      .post(`/api/v1/contracts/${contractId}/versions/${versionId}/signature`)
      .set(auth(ctx))
      .send({ imageDataUrl: SIGN_PNG, signerName: '홍길동' });
  }

  const flowOf = async (contractId: string) =>
    (await api(ctx).get(`/api/v1/contracts/${contractId}/flow`).set(auth(ctx)).expect(200)).body.data;

  it('서명 전에는 주문이 없다 — 물리화는 계약완료 시점이다', async () => {
    const { contractId } = await draftContract();
    expect(await ctx.prisma.order.count({ where: { contractId } })).toBe(0);
    // 컨설팅 대상 품목은 작성중에도 있다
    expect(await ctx.prisma.contractItem.count({ where: { contractId } })).toBe(1);
  });

  it('스타일 컨설팅이 끝나기 전에는 서명이 422 CONSULTING_NOT_CONFIRMED로 막힌다', async () => {
    const { contractId, versionId } = await draftContract();

    const flow = await flowOf(contractId);
    expect(flow.status).toBe('DRAFT');
    expect(flow.consulting.ready).toBe(false);
    expect(flow.consulting.pending).toHaveLength(1);
    expect(flow.canSign).toBe(false);

    const res = await sign(contractId, versionId).expect(422);
    expect(res.body.error.code).toBe('CONSULTING_NOT_CONFIRMED');
  });

  it('서명완료 계약에는 다시 서명할 수 없다', async () => {
    const { contractId, currentVersionId } = await signedContract();
    const res = await sign(contractId, currentVersionId).expect(409);
    expect(res.body.error.code).toBe('CONTRACT_NOT_DRAFT');
  });

  it('컨설팅을 전 품목 확정하면 서명할 수 있고, 비PNG는 거부한다', async () => {
    const { contractId, versionId: currentVersionId } = await draftContract();
    await confirmConsulting(contractId);

    const flowBefore = await flowOf(contractId);
    expect(flowBefore.consulting.ready).toBe(true);
    expect(flowBefore.canSign).toBe(true);
    expect(flowBefore.canComplete).toBe(false);

    const badType = await api(ctx)
      .post(`/api/v1/contracts/${contractId}/versions/${currentVersionId}/signature`)
      .set(auth(ctx))
      .send({ imageDataUrl: 'data:image/jpeg;base64,AAAA', signerName: '홍길동' });
    expect(badType.status).toBe(400);

    const saved = await sign(contractId, currentVersionId).expect(201);
    expect(saved.body.data).toMatchObject({ versionId: currentVersionId, signerName: '홍길동' });
    expect(saved.body.data.signatureFileId).toBeTruthy();

    const signLogs = await ctx.prisma.auditLog.findMany({
      where: { entityType: 'CONTRACT_VERSION', action: 'SIGN', entityId: currentVersionId },
    });
    expect(signLogs).toHaveLength(1);

    const flowAfter = await flowOf(contractId);
    expect(flowAfter.status).toBe('SIGNED');
    expect(flowAfter.signed).toBe(true);
    expect(flowAfter.canComplete).toBe(true);
  });

  it('서명 없이 완료하면 CONTRACT_NOT_COMPLETABLE(409)로 막는다', async () => {
    const { contractId } = await draftContract();
    await confirmConsulting(contractId);
    const res = await api(ctx)
      .post(`/api/v1/contracts/${contractId}/complete`)
      .set(auth(ctx))
      .send({ version: await rowVersion(contractId) })
      .expect(409);
    expect(res.body.error.code).toBe('CONTRACT_NOT_COMPLETABLE');
  });

  it('계약 완료 시 상태가 COMPLETED가 되고 주문 물리화 + 그 시점 계약서 엑셀이 보관된다', async () => {
    const { contractId, currentVersionId } = await signedContract();

    const done = await api(ctx)
      .post(`/api/v1/contracts/${contractId}/complete`)
      .set(auth(ctx))
      .send({ version: await rowVersion(contractId) })
      .expect(200);
    expect(done.body.data.status).toBe('COMPLETED');
    expect(done.body.data.excelFileId).toBeTruthy();
    // 주문·주문품목은 이 시점에 생긴다
    expect(done.body.data.orders).toHaveLength(1);
    expect(done.body.data.customerStatus).toBe('CONTRACTED');
    expect(await ctx.prisma.orderItem.count({ where: { order: { contractId } } })).toBe(1);

    const contract = await ctx.prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(contract.status).toBe('COMPLETED');
    const version = await ctx.prisma.contractVersion.findUniqueOrThrow({ where: { id: currentVersionId } });
    expect(version.excelFileId).toBe(done.body.data.excelFileId);

    // 완료 감사로그
    const logs = await ctx.prisma.auditLog.findMany({
      where: { entityType: 'CONTRACT', action: 'COMPLETE', entityId: contractId },
    });
    expect(logs).toHaveLength(1);

    // 이후 다운로드는 보관본을 그대로 내려준다 — 두 번 받아도 같은 바이트다.
    const first = await api(ctx).get(`/api/v1/contracts/${contractId}/excel`).set(auth(ctx)).expect(200);
    expect(first.headers['content-type']).toContain('spreadsheetml');
    const second = await api(ctx).get(`/api/v1/contracts/${contractId}/excel`).set(auth(ctx)).expect(200);
    expect(second.headers['content-length']).toBe(first.headers['content-length']);

    const flow = await flowOf(contractId);
    expect(flow.completed).toBe(true);
    expect(flow.excelStored).toBe(true);
    expect(flow.canSign).toBe(false);
  });

  it('완료된 계약은 다시 완료할 수 없고 서명도 지울 수 없다', async () => {
    const { contractId, currentVersionId } = await signedContract();
    await api(ctx)
      .post(`/api/v1/contracts/${contractId}/complete`)
      .set(auth(ctx))
      .send({ version: await rowVersion(contractId) })
      .expect(200);

    const again = await api(ctx)
      .post(`/api/v1/contracts/${contractId}/complete`)
      .set(auth(ctx))
      .send({ version: await rowVersion(contractId) })
      .expect(409);
    expect(again.body.error.code).toBe('CONTRACT_NOT_COMPLETABLE');

    const del = await api(ctx)
      .delete(`/api/v1/contracts/${contractId}/versions/${currentVersionId}/signature`)
      .set(auth(ctx))
      .expect(409);
    expect(del.body.error.code).toBe('CONTRACT_NOT_COMPLETABLE');
  });

  it('미완료 계약의 엑셀은 즉석 생성본을 내려준다(보관 없음)', async () => {
    const { contractId, versionId } = await draftContract();
    const res = await api(ctx).get(`/api/v1/contracts/${contractId}/excel`).set(auth(ctx)).expect(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const version = await ctx.prisma.contractVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(version.excelFileId).toBeNull();
  });

  it('서명한 계약서를 고치면 서명이 무효화되고 작성중으로 돌아간다 (회귀)', async () => {
    const { contractId, currentVersionId: versionId } = await signedContract();
    // 서명완료 상태에서 서명을 지우면 작성중으로 되돌아간다
    await api(ctx)
      .delete(`/api/v1/contracts/${contractId}/versions/${versionId}/signature`)
      .set(auth(ctx))
      .expect(200);
    expect((await ctx.prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).status).toBe('DRAFT');

    await api(ctx)
      .patch(`/api/v1/contracts/${contractId}`)
      .set(auth(ctx))
      .send({ totalAmount: 1_600_000 })
      .expect(200);

    const v = await ctx.prisma.contractVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(v.signatureFileId).toBeNull();
    expect(v.signedAt).toBeNull();
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

// ---------------------------------------------------------------------------
// 베스트(3피스) — 계약서 품목표 추가·옵션 화면 제외 (현업 확정 2026-07-30)
// ---------------------------------------------------------------------------

describe('베스트 — 계약서 추가·컨설팅 중 제외', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext([ContractsModule, OrdersModule]);
    await truncateBusinessData(ctx.prisma);
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  let seq = 0;
  async function newCustomer(): Promise<string> {
    seq += 1;
    const digits = String(20000000 + seq).slice(-8);
    const customer = await ctx.prisma.customer.create({
      data: {
        id: randomUUID(),
        name: `베스트고객${seq}`,
        phone: `010-${digits.slice(0, 4)}-${digits.slice(4)}`,
        phoneNormalized: `010${digits}`,
        customerStatus: 'PROSPECT',
      },
    });
    return customer.id;
  }

  /** 베스트 포함 정장 1벌 계약 생성 (단가 100만 + 베스트 30만) */
  async function createVestContract(quantity = 1) {
    const customerId = await newCustomer();
    const unit = 1_000_000;
    const vest = 300_000;
    const res = await api(ctx)
      .post('/api/v1/contracts')
      .set(auth(ctx))
      .send({
        customerId,
        totalAmount: quantity * (unit + vest),
        lines: [
          {
            transactionType: 'CUSTOM',
            productCategory: 'SUIT',
            quantity,
            unitPrice: unit,
            lineAmount: quantity * (unit + vest),
            vestIncluded: true,
            vestUnitPrice: vest,
          },
        ],
      })
      .expect(201);
    return { contractId: res.body.data.id as string, vest, unit };
  }

  it('베스트 포함 라인은 벌의 VEST 부위를 만들고, 계약서 문서에 베스트 행이 따로 나온다', async () => {
    const { contractId, vest, unit } = await createVestContract();

    const item = await ctx.prisma.contractItem.findFirstOrThrow({
      where: { contractId },
      include: { components: true },
    });
    const types = item.components.filter((c) => c.status !== 'CANCELLED').map((c) => c.componentType);
    expect(types).toEqual(expect.arrayContaining(['JACKET', 'TROUSERS', 'VEST']));

    // 저장된 라인 값
    const doc = await api(ctx).get(`/api/v1/contracts/${contractId}/document`).set(auth(ctx)).expect(200);
    const lines = doc.body.data.lines;
    expect(lines).toHaveLength(2);
    expect(lines[0].isVest).toBe(false);
    expect(Number(lines[0].lineAmount)).toBe(unit); // 정장 행은 베스트 금액을 뺀 몫
    expect(lines[1].isVest).toBe(true);
    expect(lines[1].categoryLabel).toBe('베스트');
    expect(Number(lines[1].lineAmount)).toBe(vest);
  });

  it('베스트는 맞춤 정장 라인에만 켤 수 있다 (렌탈·셔츠는 400)', async () => {
    const customerId = await newCustomer();
    for (const line of [
      { transactionType: 'RENTAL', productCategory: 'SUIT' },
      { transactionType: 'CUSTOM', productCategory: 'SHIRT' },
    ]) {
      const res = await api(ctx)
        .post('/api/v1/contracts')
        .set(auth(ctx))
        .send({
          customerId,
          lines: [{ ...line, quantity: 1, lineAmount: 100000, vestIncluded: true, vestUnitPrice: 10000 }],
        })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('[옵션 선택 안함] 제외 — 라인·합계에서 베스트 금액이 자동 차감되고 부위가 취소된다', async () => {
    const { contractId, vest, unit } = await createVestContract();
    const item = await ctx.prisma.contractItem.findFirstOrThrow({ where: { contractId } });

    const res = await api(ctx)
      .post(`/api/v1/contracts/items/${item.id}/exclude-vest`)
      .set(auth(ctx))
      .expect(200);
    expect(Number(res.body.data.deductedAmount)).toBe(vest);

    const line = await ctx.prisma.contractLine.findFirstOrThrow({
      where: { contractVersion: { contractId } },
    });
    expect(line.vestIncluded).toBe(false);
    expect(line.vestUnitPrice).toBeNull();
    expect(Number(line.lineAmount)).toBe(unit);

    const contract = await ctx.prisma.contract.findUniqueOrThrow({
      where: { id: contractId },
      include: { currentVersion: true },
    });
    expect(Number(contract.currentVersion!.totalAmount)).toBe(unit);

    const components = await ctx.prisma.contractItemComponent.findMany({
      where: { contractItemId: item.id, componentType: 'VEST' },
    });
    expect(components).toHaveLength(1);
    expect(components[0].status).toBe('CANCELLED');

    // 이미 제외된 품목은 다시 제외할 수 없다
    const dup = await api(ctx)
      .post(`/api/v1/contracts/items/${item.id}/exclude-vest`)
      .set(auth(ctx))
      .expect(400);
    expect(dup.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('여러 벌 라인에서 한 벌만 제외하면 라인이 분리된다 (다른 벌의 베스트 유지)', async () => {
    const { contractId, vest, unit } = await createVestContract(2);
    const first = await ctx.prisma.contractItem.findFirstOrThrow({
      where: { contractId },
      orderBy: { sequenceNo: 'asc' },
    });

    await api(ctx).post(`/api/v1/contracts/items/${first.id}/exclude-vest`).set(auth(ctx)).expect(200);

    const lines = await ctx.prisma.contractLine.findMany({
      where: { contractVersion: { contractId } },
    });
    expect(lines).toHaveLength(2);
    const kept = lines.find((l) => l.vestIncluded);
    const split = lines.find((l) => !l.vestIncluded);
    expect(kept?.quantity).toBe(1);
    expect(split?.quantity).toBe(1);
    expect(Number(split!.lineAmount)).toBe(unit);

    // 총액은 한 벌 몫만 차감
    const contract = await ctx.prisma.contract.findUniqueOrThrow({
      where: { id: contractId },
      include: { currentVersion: true },
    });
    expect(Number(contract.currentVersion!.totalAmount)).toBe(2 * unit + vest);

    // 부위: 첫 벌만 취소, 둘째 벌은 유지
    const items = await ctx.prisma.contractItem.findMany({
      where: { contractId },
      include: { components: true },
      orderBy: { sequenceNo: 'asc' },
    });
    const vestOf = (i: (typeof items)[number]) =>
      i.components.find((c) => c.componentType === 'VEST');
    expect(vestOf(items[0])?.status).toBe('CANCELLED');
    expect(vestOf(items[1])?.status).toBe('CREATED');
  });

  it('완료 후 수정하기(버전업)로 베스트를 추가하면 재완료 시 주문 구성품에 증분 반영된다', async () => {
    // 2피스로 계약완료 → 주문 구성품은 상의·하의뿐
    const customerId = await newCustomer();
    const unit = 1_000_000;
    const created = await api(ctx)
      .post('/api/v1/contracts')
      .set(auth(ctx))
      .send({
        customerId,
        totalAmount: unit,
        lines: [
          { transactionType: 'CUSTOM', productCategory: 'SUIT', quantity: 1, unitPrice: unit, lineAmount: unit },
        ],
      })
      .expect(201);
    const contractId = created.body.data.id as string;
    await signAndCompleteContract(ctx, contractId);

    const orderItem = await ctx.prisma.orderItem.findFirstOrThrow({
      where: { order: { contractId } },
      include: { components: true },
    });
    expect(orderItem.components.map((c) => c.componentType)).not.toContain('VEST');

    // 수정하기(버전업) → 베스트 추가 → 재서명·재완료
    await api(ctx)
      .post(`/api/v1/contracts/${contractId}/revisions`)
      .set(auth(ctx))
      .send({ changeReason: '베스트 추가' })
      .expect(201);
    await api(ctx)
      .patch(`/api/v1/contracts/${contractId}`)
      .set(auth(ctx))
      .send({
        totalAmount: unit + 300_000,
        lines: [
          {
            transactionType: 'CUSTOM',
            productCategory: 'SUIT',
            quantity: 1,
            unitPrice: unit,
            lineAmount: unit + 300_000,
            vestIncluded: true,
            vestUnitPrice: 300_000,
          },
        ],
      })
      .expect(200);
    await signAndCompleteContract(ctx, contractId);

    // 같은 주문품목에 VEST 구성품만 늘어난다 (품목 중복 생성 없음)
    const orderItems = await ctx.prisma.orderItem.findMany({
      where: { order: { contractId } },
      include: { components: true },
    });
    expect(orderItems).toHaveLength(1);
    const vestComp = orderItems[0].components.find((c) => c.componentType === 'VEST');
    expect(vestComp?.status).toBe('CREATED');
  });

  it('베스트 단계가 있는 확정 세션에 베스트를 추가하면 서명 게이트가 다시 잠기고, 제외하면 풀린다', async () => {
    const admin = await ctx.prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
    const optionSet = await ctx.prisma.optionSet.findUniqueOrThrow({ where: { productCategory: 'SUIT' } });
    const prevActive = optionSet.activeVersionId;
    const versionId = randomUUID();
    await ctx.prisma.optionSetVersion.create({
      data: {
        id: versionId,
        optionSetId: optionSet.id,
        versionNo: 990 + seq,
        status: 'ACTIVE',
        createdBy: admin.id,
      },
    });
    await ctx.prisma.optionStage.create({
      data: {
        id: randomUUID(),
        optionSetVersionId: versionId,
        stageCode: 'VEST_GATE_TEST',
        stageName: '베스트 게이트 검증',
        sequenceNo: 1,
        componentGroup: 'VEST',
      },
    });
    await ctx.prisma.optionSet.update({
      where: { id: optionSet.id },
      data: { activeVersionId: versionId },
    });

    try {
      const { contractId } = await createVestContract();
      const item = await ctx.prisma.contractItem.findFirstOrThrow({ where: { contractId } });
      // 2피스 시절처럼 베스트 단계 값 없이 확정된 세션 (베스트 추가 전 확정본 재현)
      await ctx.prisma.optionSelectionSession.create({
        data: {
          id: randomUUID(),
          contractItemId: item.id,
          optionSetVersionId: versionId,
          selectionVersionNo: 1,
          status: 'CONFIRMED',
          confirmedAt: new Date(),
          isCurrent: true,
        },
      });

      // 베스트가 살아 있는데 VEST 단계 값이 없다 → 서명 게이트 잠김
      const locked = await api(ctx).get(`/api/v1/contracts/${contractId}/flow`).set(auth(ctx)).expect(200);
      expect(locked.body.data.consulting.ready).toBe(false);

      // [옵션 선택 안함]으로 베스트를 제외하면 다시 서명 가능
      await api(ctx).post(`/api/v1/contracts/items/${item.id}/exclude-vest`).set(auth(ctx)).expect(200);
      const unlocked = await api(ctx).get(`/api/v1/contracts/${contractId}/flow`).set(auth(ctx)).expect(200);
      expect(unlocked.body.data.consulting.ready).toBe(true);
    } finally {
      await ctx.prisma.optionSet.update({
        where: { id: optionSet.id },
        data: { activeVersionId: prevActive },
      });
    }
  });

  it('제작 진행 중인 벌은 베스트를 제외할 수 없다 (컨설팅 잠금과 동일 규칙)', async () => {
    const { contractId } = await createVestContract();
    await signAndCompleteContract(ctx, contractId);

    // 수정하기로 작성중 복귀 후, 주문품목이 제작요청으로 넘어간 상황
    await api(ctx)
      .post(`/api/v1/contracts/${contractId}/revisions`)
      .set(auth(ctx))
      .send({ changeReason: '베스트 제외 시도' })
      .expect(201);
    const orderItem = await ctx.prisma.orderItem.findFirstOrThrow({ where: { order: { contractId } } });
    await ctx.prisma.orderItem.update({
      where: { id: orderItem.id },
      data: { status: 'PRODUCTION_REQUESTED' },
    });

    const item = await ctx.prisma.contractItem.findFirstOrThrow({ where: { contractId } });
    const res = await api(ctx)
      .post(`/api/v1/contracts/items/${item.id}/exclude-vest`)
      .set(auth(ctx))
      .expect(409);
    expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });
});
