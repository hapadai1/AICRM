import { randomUUID } from 'crypto';
import { RentalReleaseScheduler } from '../../backend/src/modules/rentals/rental-release.scheduler';
import { RentalsModule } from '../../backend/src/modules/rentals/rentals.module';
import { api, auth, createTestContext, TestContext, truncateBusinessData } from './helpers';

describe('렌탈 실물 재고·기간 배정·출고·반납 (Phase 5)', () => {
  let ctx: TestContext;
  let adminId: string;
  let orderId: string;
  let orderItemId: string;
  let jacketComponentId: string;

  // 가용·배정 흐름에서 스위트 내 공유하는 상태
  let itemA1: { id: string; managementCode: string };
  let itemA2: { id: string; managementCode: string };
  let allocationId: string;

  beforeAll(async () => {
    ctx = await createTestContext([RentalsModule]);
    await truncateBusinessData(ctx.prisma);

    const admin = await ctx.prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
    adminId = admin.id;

    // 정비 기준은 기준정보라 truncate 대상이 아니다 — 앞선 실행이 바꿔 뒀을 수 있어 기본값으로 되돌린다.
    await ctx.prisma.rentalReturnPolicy.updateMany({
      data: { lightCleaningDays: 2, darkCleaningDays: 1, autoRelease: true },
    });

    // 렌탈 주문 픽스처: 고객 → 계약 → 계약버전/라인 → 렌탈 주문 → 품목 → 구성품
    const customer = await ctx.prisma.customer.create({
      data: {
        id: randomUUID(),
        name: '렌탈 고객',
        phone: '010-9000-0001',
        phoneNormalized: '01090000001',
        customerStatus: 'CONTRACTED',
      },
    });
    const contract = await ctx.prisma.contract.create({
      data: { id: randomUUID(), contractNo: 'CTR-260721-901', customerId: customer.id, status: 'CONFIRMED' },
    });
    const version = await ctx.prisma.contractVersion.create({
      data: {
        id: randomUUID(),
        contractId: contract.id,
        versionNo: 1,
        versionStatus: 'CONFIRMED',
        createdBy: adminId,
      },
    });
    const line = await ctx.prisma.contractLine.create({
      data: {
        id: randomUUID(),
        contractVersionId: version.id,
        transactionType: 'RENTAL',
        productCategory: 'SUIT',
        quantity: 1,
      },
    });
    const order = await ctx.prisma.order.create({
      data: { id: randomUUID(), orderNo: 'ORD-260721-901', contractId: contract.id, transactionType: 'RENTAL' },
    });
    orderId = order.id;
    // 주문품목은 계약 품목(계약 소유)의 물리화 결과다. 렌탈 선택 세션도 이 품목에 붙는다.
    const anchorItem = await ctx.prisma.contractItem.create({
      data: {
        id: randomUUID(),
        contractId: contract.id,
        sourceContractLineId: line.id,
        transactionType: 'RENTAL',
        productCategory: 'SUIT',
        sequenceNo: 1,
        displayName: '렌탈 정장 #1',
      },
    });
    const orderItem = await ctx.prisma.orderItem.create({
      data: {
        id: randomUUID(),
        orderId: order.id,
        sourceContractItemId: anchorItem.id,
        productCategory: 'SUIT',
        sequenceNo: 1,
        displayName: '렌탈 정장 #1',
      },
    });
    orderItemId = orderItem.id;
    const jacket = await ctx.prisma.orderItemComponent.create({
      data: { id: randomUUID(), orderItemId: orderItem.id, componentType: 'JACKET' },
    });
    jacketComponentId = jacket.id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  // ---------------------------------------------------------------------------
  // 1. 재고 등록
  // ---------------------------------------------------------------------------

  it('quantity 일괄 등록 시 관리코드 연번으로 실물을 생성하고 SKU는 find-or-create 한다', async () => {
    const res = await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({
        componentType: 'JACKET',
        color: 'BLACK',
        size: '50',
        managementCode: 'JKT-BK-100',
        quantity: 3,
      })
      .expect(201);
    const codes = res.body.data.map((i: { managementCode: string }) => i.managementCode);
    expect(codes).toEqual(['JKT-BK-100-001', 'JKT-BK-100-002', 'JKT-BK-100-003']);

    // 같은 속성 추가 등록 시 SKU가 새로 생기지 않는다
    await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'JACKET', color: 'BLACK', size: '50', managementCode: 'JKT-BK-100-EX' })
      .expect(201);
    const skuCount = await ctx.prisma.rentalSku.count({
      where: { componentType: 'JACKET', color: 'BLACK', size: '50' },
    });
    expect(skuCount).toBe(1);
  });

  it('관리코드 중복 등록을 친절한 오류로 차단한다', async () => {
    const res = await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'JACKET', color: 'BLACK', size: '50', managementCode: 'JKT-BK-100-002' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('JKT-BK-100-002');
    expect(res.body.error.details.duplicatedCodes).toContain('JKT-BK-100-002');
  });

  it('import는 dryRun 미리보기와 오류 행 분리를 지원한다', async () => {
    const items = [
      { componentType: 'TROUSERS', color: 'BLACK', size: '92', managementCode: 'PNT-BK-32-001' },
      { componentType: 'JACKET', color: 'BLACK', size: '50', managementCode: 'JKT-BK-100-002' }, // DB 중복
      { componentType: 'HAT', color: 'GRAY', size: 'F', managementCode: 'HAT-001' }, // 허용되지 않은 품목
      { componentType: 'SHOES', color: 'SHOE_BROWN' }, // 필수값 누락
    ];

    const dry = await api(ctx)
      .post('/api/v1/rental-inventory/import')
      .set(auth(ctx))
      .send({ dryRun: true, items })
      .expect(201);
    expect(dry.body.data.dryRun).toBe(true);
    expect(dry.body.data.successCount).toBe(1);
    expect(dry.body.data.errorCount).toBe(3);
    // dryRun은 저장하지 않는다
    expect(await ctx.prisma.rentalInventoryItem.count({ where: { managementCode: 'PNT-BK-32-001' } })).toBe(0);

    const real = await api(ctx)
      .post('/api/v1/rental-inventory/import')
      .set(auth(ctx))
      .send({ items })
      .expect(201);
    expect(real.body.data.successCount).toBe(1);
    expect(real.body.data.errorCount).toBe(3);
    const errorRows = real.body.data.errors.map((e: { row: number }) => e.row).sort();
    expect(errorRows).toEqual([2, 3, 4]);
    expect(await ctx.prisma.rentalInventoryItem.count({ where: { managementCode: 'PNT-BK-32-001' } })).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 1-b. E10 — 컬러·사이즈 기준정보 코드 검증
  // ---------------------------------------------------------------------------

  it('E10: 활성 기준정보 코드(color/size)면 실물 등록이 통과한다', async () => {
    await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'JACKET', color: 'CHARCOAL', size: '52', managementCode: 'E10-OK-001' })
      .expect(201);
  });

  it('E10: 미등록 color/size 코드는 VALIDATION_ERROR fieldErrors로 차단한다', async () => {
    // 미등록 컬러
    const badColor = await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'JACKET', color: 'RAINBOW', size: '50', managementCode: 'E10-BADC-001' })
      .expect(400);
    expect(badColor.body.error.code).toBe('VALIDATION_ERROR');
    expect(badColor.body.error.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'color', reason: 'INVALID_COLOR_CODE' })]),
    );
    expect(await ctx.prisma.rentalInventoryItem.count({ where: { managementCode: 'E10-BADC-001' } })).toBe(0);

    // 미등록 사이즈 (호수 체계 밖: '32')
    const badSize = await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'TROUSERS', color: 'BLACK', size: '32', managementCode: 'E10-BADS-001' })
      .expect(400);
    expect(badSize.body.error.code).toBe('VALIDATION_ERROR');
    expect(badSize.body.error.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'size', reason: 'INVALID_SIZE_CODE' })]),
    );
    expect(await ctx.prisma.rentalInventoryItem.count({ where: { managementCode: 'E10-BADS-001' } })).toBe(0);
  });

  it('E10: import은 미등록 color/size 행을 오류로 분리한다', async () => {
    const res = await api(ctx)
      .post('/api/v1/rental-inventory/import')
      .set(auth(ctx))
      .send({
        dryRun: true,
        items: [
          { componentType: 'JACKET', color: 'NAVY', size: '50', managementCode: 'E10-IMP-OK' },
          { componentType: 'JACKET', color: 'RAINBOW', size: '999', managementCode: 'E10-IMP-BAD' },
        ],
      })
      .expect(201);
    expect(res.body.data.successCount).toBe(1);
    expect(res.body.data.errorCount).toBe(1);
    const badRow = res.body.data.errors.find((e: { managementCode: string }) => e.managementCode === 'E10-IMP-BAD');
    expect(badRow.errors.join(' ')).toMatch(/color/);
    expect(badRow.errors.join(' ')).toMatch(/size/);
  });

  // ---------------------------------------------------------------------------
  // 2. 가용 검색·기간 배정
  // ---------------------------------------------------------------------------

  it('가용 검색은 기간이 겹치는 실물을 제외한다', async () => {
    const created = await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'JACKET', color: 'NAVY', size: '54', managementCode: 'AV-J', quantity: 2 })
      .expect(201);
    [itemA1, itemA2] = created.body.data;
    expect(itemA1.managementCode).toBe('AV-J-001');

    const before = await api(ctx)
      .get('/api/v1/rental-inventory/availability')
      .set(auth(ctx))
      .query({ componentType: 'JACKET', color: 'NAVY', size: '54', pickupDate: '2026-08-01', availabilityEndDate: '2026-08-05' })
      .expect(200);
    expect(before.body.data.map((i: { managementCode: string }) => i.managementCode)).toEqual(['AV-J-001', 'AV-J-002']);

    // AV-J-001 배정 (2026-08-01 ~ 08-05)
    const alloc = await api(ctx)
      .post(`/api/v1/rental-orders/${orderId}/allocations`)
      .set(auth(ctx))
      .send({
        componentId: jacketComponentId,
        inventoryItemId: itemA1.id,
        pickupDate: '2026-08-01',
        returnDueDate: '2026-08-03',
        availabilityEndDate: '2026-08-05',
      })
      .expect(201);
    allocationId = alloc.body.data.id;
    expect(alloc.body.data.status).toBe('RESERVED');

    const item1 = await ctx.prisma.rentalInventoryItem.findUniqueOrThrow({ where: { id: itemA1.id } });
    expect(item1.status).toBe('RESERVED');

    // 겹치는 기간: AV-J-001 제외
    const overlapped = await api(ctx)
      .get('/api/v1/rental-inventory/availability')
      .set(auth(ctx))
      .query({ componentType: 'JACKET', color: 'NAVY', size: '54', pickupDate: '2026-08-03', availabilityEndDate: '2026-08-07' })
      .expect(200);
    expect(overlapped.body.data.map((i: { managementCode: string }) => i.managementCode)).toEqual(['AV-J-002']);

    // 겹치지 않는 기간: RESERVED 상태여도 배정 가능 후보에 포함
    const later = await api(ctx)
      .get('/api/v1/rental-inventory/availability')
      .set(auth(ctx))
      .query({ componentType: 'JACKET', color: 'NAVY', size: '54', pickupDate: '2026-08-10', availabilityEndDate: '2026-08-12' })
      .expect(200);
    expect(later.body.data.map((i: { managementCode: string }) => i.managementCode)).toContain('AV-J-001');
  });

  it('가용 종료일을 생략하면 반납 예정일까지만 묶이고 다음 날부터 예약된다', async () => {
    const item = await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'JACKET', color: 'GREY', size: '48', managementCode: 'END-J-001' })
      .expect(201);
    const itemId = item.body.data[0].id;

    // 7/29 픽업 ~ 7/31 반납. 가용 종료일 미지정.
    const alloc = await api(ctx)
      .post(`/api/v1/rental-orders/${orderId}/allocations`)
      .set(auth(ctx))
      .send({
        componentId: jacketComponentId,
        inventoryItemId: itemId,
        pickupDate: '2026-12-29',
        returnDueDate: '2026-12-31',
      })
      .expect(201);
    expect(alloc.body.data.availabilityEndDate).toContain('2026-12-31');

    // 반납 예정일 당일은 아직 묶여 있다
    await api(ctx)
      .post(`/api/v1/rental-orders/${orderId}/allocations`)
      .set(auth(ctx))
      .send({
        componentId: jacketComponentId,
        inventoryItemId: itemId,
        pickupDate: '2026-12-31',
        returnDueDate: '2027-01-02',
      })
      .expect(409);

    // 다음 날부터는 예약된다
    await api(ctx)
      .post(`/api/v1/rental-orders/${orderId}/allocations`)
      .set(auth(ctx))
      .send({
        componentId: jacketComponentId,
        inventoryItemId: itemId,
        pickupDate: '2027-01-01',
        returnDueDate: '2027-01-02',
      })
      .expect(201);
  });

  it('겹치는 기간의 배정을 RENTAL_PERIOD_OVERLAP으로 차단한다 (순차 2회 요청)', async () => {
    const res = await api(ctx)
      .post(`/api/v1/rental-orders/${orderId}/allocations`)
      .set(auth(ctx))
      .send({
        componentId: jacketComponentId,
        inventoryItemId: itemA1.id,
        pickupDate: '2026-08-04',
        returnDueDate: '2026-08-05',
        availabilityEndDate: '2026-08-06',
      })
      .expect(409);
    expect(res.body.error.code).toBe('RENTAL_PERIOD_OVERLAP');
    expect(await ctx.prisma.rentalAllocation.count({ where: { rentalInventoryItemId: itemA1.id } })).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 3. ID 일치 검증·실물 변경·출고
  // ---------------------------------------------------------------------------

  it('change-item으로 실물을 교체하면 구실물은 AVAILABLE로 복원되고 이력이 남는다', async () => {
    // 사유 누락은 400
    await api(ctx)
      .post(`/api/v1/rental-allocations/${allocationId}/change-item`)
      .set(auth(ctx))
      .send({ newInventoryItemId: itemA2.id, version: 0 })
      .expect(400);

    const res = await api(ctx)
      .post(`/api/v1/rental-allocations/${allocationId}/change-item`)
      .set(auth(ctx))
      .send({ newInventoryItemId: itemA2.id, reason: '오염 확인으로 동일 규격 실물 교체', version: 0 })
      .expect(201);
    expect(res.body.data.rentalInventoryItemId).toBe(itemA2.id);

    const [oldItem, newItem] = await Promise.all([
      ctx.prisma.rentalInventoryItem.findUniqueOrThrow({ where: { id: itemA1.id } }),
      ctx.prisma.rentalInventoryItem.findUniqueOrThrow({ where: { id: itemA2.id } }),
    ]);
    expect(oldItem.status).toBe('AVAILABLE');
    expect(newItem.status).toBe('RESERVED');

    const event = await ctx.prisma.rentalAllocationEvent.findFirstOrThrow({
      where: { rentalAllocationId: allocationId, eventType: 'ITEM_CHANGED' },
    });
    expect(event.oldInventoryItemId).toBe(itemA1.id);
    expect(event.newInventoryItemId).toBe(itemA2.id);
    expect(event.reason).toContain('실물 교체');
  });

  it('변경된 실물 ID로 출고에 성공한다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/rental-allocations/${allocationId}/checkout`)
      .set(auth(ctx))
      .send({ checkoutDate: '2026-08-01', version: 1 })
      .expect(201);
    expect(res.body.data.status).toBe('CHECKED_OUT');
    expect(res.body.data.actualPickupAt).toContain('2026-08-01');

    const item = await ctx.prisma.rentalInventoryItem.findUniqueOrThrow({ where: { id: itemA2.id } });
    expect(item.status).toBe('CHECKED_OUT');
  });

  // ---------------------------------------------------------------------------
  // 4. 반납·수동 가용 전환
  // ---------------------------------------------------------------------------

  it('반납은 자동 AVAILABLE 전환 없이 RETURNED_HOLD와 available_from을 저장한다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/rental-allocations/${allocationId}/return`)
      .set(auth(ctx))
      .send({ returnDate: '2026-08-03', availableFrom: '2026-08-07' })
      .expect(201);
    expect(res.body.data.status).toBe('RETURNED');

    const item = await ctx.prisma.rentalInventoryItem.findUniqueOrThrow({ where: { id: itemA2.id } });
    expect(item.status).toBe('RETURNED_HOLD'); // 자동 AVAILABLE 금지
    expect(item.availableFrom?.toISOString().slice(0, 10)).toBe('2026-08-07');

    // 반납 대기 상태에서는 재배정 불가
    const blocked = await api(ctx)
      .post(`/api/v1/rental-orders/${orderId}/allocations`)
      .set(auth(ctx))
      .send({
        componentId: jacketComponentId,
        inventoryItemId: itemA2.id,
        pickupDate: '2026-09-01',
        returnDueDate: '2026-09-02',
        availabilityEndDate: '2026-09-03',
      })
      .expect(409);
    expect(blocked.body.error.code).toBe('RENTAL_ITEM_NOT_AVAILABLE');

    // 가용 검색에서도 제외
    const avail = await api(ctx)
      .get('/api/v1/rental-inventory/availability')
      .set(auth(ctx))
      .query({ componentType: 'JACKET', color: 'NAVY', size: '54', pickupDate: '2026-09-01', availabilityEndDate: '2026-09-03' })
      .expect(200);
    expect(avail.body.data.map((i: { managementCode: string }) => i.managementCode)).not.toContain('AV-J-002');
  });

  it('수동 상태 변경은 사유가 필수다 (누락·공백 모두 거부)', async () => {
    await api(ctx)
      .post(`/api/v1/rental-inventory/${itemA2.id}/status-events`)
      .set(auth(ctx))
      .send({ newStatus: 'UNAVAILABLE' })
      .expect(400);
    await api(ctx)
      .post(`/api/v1/rental-inventory/${itemA2.id}/status-events`)
      .set(auth(ctx))
      .send({ newStatus: 'UNAVAILABLE', reason: '   ' })
      .expect(400);
  });

  it('수동 AVAILABLE 전환 후에도 available_from 이전 픽업 배정은 차단한다', async () => {
    await api(ctx)
      .post(`/api/v1/rental-inventory/${itemA2.id}/status-events`)
      .set(auth(ctx))
      .send({ newStatus: 'AVAILABLE', availableFrom: '2026-08-07', reason: '정비 완료' })
      .expect(201);

    // 픽업일이 available_from(08-07) 이전이면 차단
    const early = await api(ctx)
      .post(`/api/v1/rental-orders/${orderId}/allocations`)
      .set(auth(ctx))
      .send({
        componentId: jacketComponentId,
        inventoryItemId: itemA2.id,
        pickupDate: '2026-08-06',
        returnDueDate: '2026-08-06',
        availabilityEndDate: '2026-08-06',
      })
      .expect(409);
    expect(early.body.error.code).toBe('RENTAL_ITEM_NOT_AVAILABLE');

    // available_from 이후 픽업은 배정 성공
    const ok = await api(ctx)
      .post(`/api/v1/rental-orders/${orderId}/allocations`)
      .set(auth(ctx))
      .send({
        componentId: jacketComponentId,
        inventoryItemId: itemA2.id,
        pickupDate: '2026-08-07',
        returnDueDate: '2026-08-08',
        availabilityEndDate: '2026-08-09',
      })
      .expect(201);
    expect(ok.body.data.status).toBe('RESERVED');
  });

  // ---------------------------------------------------------------------------
  // 4-b. 정비 기준 — 색 계열별 정비일·자동 가용 전환 (현업 확정 2026-08-01)
  // ---------------------------------------------------------------------------

  /**
   * 정비 기준 테스트 전용 렌탈 주문. 구성품을 여러 개 만들어야 해서 앞 테스트의 주문에
   * 붙이면 "이 주문의 구성품은 1개" 같은 기대가 깨진다.
   */
  let policyOrderId = '';
  let policyOrderItemId = '';

  /** 렌탈 주문은 계약당 하나뿐이라(contract_id+transaction_type UNIQUE) 계약부터 새로 만든다. */
  async function ensurePolicyOrder(): Promise<void> {
    if (policyOrderItemId) return;
    const base = await ctx.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { contract: { select: { customerId: true } } },
    });
    const contract = await ctx.prisma.contract.create({
      data: {
        id: randomUUID(),
        contractNo: 'CTR-260721-902',
        customerId: base.contract.customerId,
        status: 'CONFIRMED',
      },
    });
    const anchor = await ctx.prisma.contractItem.create({
      data: {
        id: randomUUID(),
        contractId: contract.id,
        transactionType: 'RENTAL',
        productCategory: 'SUIT',
        sequenceNo: 1,
        displayName: '렌탈 정장 #2',
      },
    });
    const order = await ctx.prisma.order.create({
      data: {
        id: randomUUID(),
        orderNo: 'ORD-260721-902',
        contractId: contract.id,
        transactionType: 'RENTAL',
      },
    });
    const item = await ctx.prisma.orderItem.create({
      data: {
        id: randomUUID(),
        orderId: order.id,
        sourceContractItemId: anchor.id,
        productCategory: 'SUIT',
        sequenceNo: 1,
        displayName: '렌탈 정장 #2',
      },
    });
    policyOrderId = order.id;
    policyOrderItemId = item.id;
  }

  /**
   * 색 하나를 반납까지 끌고 가는 픽스처. 다른 테스트의 기간 배정과 겹치지 않게
   * 구성품과 실물을 매번 새로 만든다.
   */
  async function returnOneItem(
    color: string,
    period: { pickupDate: string; returnDueDate: string },
    body: Record<string, unknown>,
  ): Promise<{ itemId: string; allocationId: string }> {
    await ensurePolicyOrder();
    const component = await ctx.prisma.orderItemComponent.create({
      data: { id: randomUUID(), orderItemId: policyOrderItemId, componentType: 'JACKET' },
    });
    const created = await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'JACKET', color, size: '54' })
      .expect(201);
    const itemId = created.body.data[0].id as string;

    const allocation = await api(ctx)
      .post(`/api/v1/rental-orders/${policyOrderId}/allocations`)
      .set(auth(ctx))
      .send({ componentId: component.id, inventoryItemId: itemId, ...period })
      .expect(201);
    const id = allocation.body.data.id as string;
    await api(ctx)
      .post(`/api/v1/rental-allocations/${id}/checkout`)
      .set(auth(ctx))
      .send({ checkoutDate: period.pickupDate, version: allocation.body.data.rowVersion })
      .expect(201);
    const checkedOut = await ctx.prisma.rentalAllocation.findUniqueOrThrow({ where: { id } });
    await api(ctx)
      .post(`/api/v1/rental-allocations/${id}/return`)
      .set(auth(ctx))
      .send({ ...body, version: checkedOut.rowVersion })
      .expect(201);
    return { itemId, allocationId: id };
  }

  it('대여 가능 예정일을 생략하면 색 계열별 정비일로 채운다 (밝은색 +2 / 블랙 타입 +1)', async () => {
    const dark = await returnOneItem(
      'NAVY',
      { pickupDate: '2026-11-02', returnDueDate: '2026-11-03' },
      { returnDate: '2026-11-03' },
    );
    const light = await returnOneItem(
      'WHITE',
      { pickupDate: '2026-11-02', returnDueDate: '2026-11-03' },
      { returnDate: '2026-11-03' },
    );

    const darkItem = await ctx.prisma.rentalInventoryItem.findUniqueOrThrow({ where: { id: dark.itemId } });
    const lightItem = await ctx.prisma.rentalInventoryItem.findUniqueOrThrow({ where: { id: light.itemId } });
    expect(darkItem.availableFrom?.toISOString().slice(0, 10)).toBe('2026-11-04');
    expect(lightItem.availableFrom?.toISOString().slice(0, 10)).toBe('2026-11-05');
    expect(lightItem.status).toBe('RETURNED_HOLD');

    // 왜 그 날짜인지가 상태 이력만 봐도 읽혀야 한다
    const event = await ctx.prisma.rentalInventoryStatusEvent.findFirstOrThrow({
      where: { rentalInventoryItemId: light.itemId },
      orderBy: { occurredAt: 'desc' },
    });
    expect(event.reason).toContain('정비 2일');
  });

  it('대여 가능 예정일을 직접 주면 그 값이 정비 기준보다 우선한다', async () => {
    const { itemId } = await returnOneItem(
      'WHITE',
      { pickupDate: '2026-11-06', returnDueDate: '2026-11-07' },
      { returnDate: '2026-11-07', availableFrom: '2026-11-08' },
    );
    const item = await ctx.prisma.rentalInventoryItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.availableFrom?.toISOString().slice(0, 10)).toBe('2026-11-08');
  });

  it('반납 목록은 정비 소요일과 대여 가능 예정일을 함께 준다', async () => {
    await ensurePolicyOrder();
    const component = await ctx.prisma.orderItemComponent.create({
      data: { id: randomUUID(), orderItemId: policyOrderItemId, componentType: 'JACKET' },
    });
    const created = await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'JACKET', color: 'WHITE', size: '54' })
      .expect(201);
    const allocation = await api(ctx)
      .post(`/api/v1/rental-orders/${policyOrderId}/allocations`)
      .set(auth(ctx))
      .send({
        componentId: component.id,
        inventoryItemId: created.body.data[0].id,
        pickupDate: '2026-11-10',
        returnDueDate: '2026-11-11',
      })
      .expect(201);
    await api(ctx)
      .post(`/api/v1/rental-allocations/${allocation.body.data.id}/checkout`)
      .set(auth(ctx))
      .send({ checkoutDate: '2026-11-10', version: allocation.body.data.rowVersion })
      .expect(201);

    const list = await api(ctx)
      .get('/api/v1/rental-allocations')
      .set(auth(ctx))
      .query({ view: 'return', date: '2026-11-11' })
      .expect(200);
    const row = (list.body.data as { id: string; cleaningDays?: number; suggestedAvailableFrom?: string }[]).find(
      (r) => r.id === allocation.body.data.id,
    );
    expect(row?.cleaningDays).toBe(2);
    expect(row?.suggestedAvailableFrom).toBe('2026-11-13');
  });

  it('정비일이 지난 반납 대기 실물만 자동으로 대여 가능이 된다', async () => {
    // 정비일이 이미 지난 반납 대기 — 전환 대상
    const due = await returnOneItem(
      'NAVY',
      { pickupDate: '2026-11-14', returnDueDate: '2026-11-15' },
      { returnDate: '2026-11-15', availableFrom: '2020-01-01' },
    );
    // 아직 정비 중 — 그대로 둬야 한다
    const notYet = await returnOneItem(
      'NAVY',
      { pickupDate: '2026-11-14', returnDueDate: '2026-11-15' },
      { returnDate: '2026-11-15', availableFrom: '2099-01-01' },
    );
    // 수선은 날짜가 아니라 사람이 끝났다고 판단해야 풀린다
    const alteration = await returnOneItem(
      'NAVY',
      { pickupDate: '2026-11-14', returnDueDate: '2026-11-15' },
      { returnDate: '2026-11-15', availableFrom: '2020-01-01', nextStatus: 'ALTERATION' },
    );

    const scheduler = ctx.app.get(RentalReleaseScheduler);
    const released = await scheduler.releaseDueItems('테스트');
    expect(released).toBeGreaterThanOrEqual(1);

    const rows = await ctx.prisma.rentalInventoryItem.findMany({
      where: { id: { in: [due.itemId, notYet.itemId, alteration.itemId] } },
      select: { id: true, status: true },
    });
    const statusOf = (id: string) => rows.find((r) => r.id === id)?.status;
    expect(statusOf(due.itemId)).toBe('AVAILABLE');
    expect(statusOf(notYet.itemId)).toBe('RETURNED_HOLD');
    expect(statusOf(alteration.itemId)).toBe('ALTERATION');

    const event = await ctx.prisma.rentalInventoryStatusEvent.findFirstOrThrow({
      where: { rentalInventoryItemId: due.itemId },
      orderBy: { occurredAt: 'desc' },
    });
    expect(event.reason).toBe('정비 완료 자동 가용 전환');
  });

  it('정비 기준을 바꾸면 이후 반납부터 그 일수가 적용된다', async () => {
    await api(ctx)
      .patch('/api/v1/admin/rental-return-policy')
      .set(auth(ctx))
      .send({ darkCleaningDays: 3 })
      .expect(200);

    try {
      const { itemId } = await returnOneItem(
        'NAVY',
        { pickupDate: '2026-11-20', returnDueDate: '2026-11-21' },
        { returnDate: '2026-11-21' },
      );
      const item = await ctx.prisma.rentalInventoryItem.findUniqueOrThrow({ where: { id: itemId } });
      expect(item.availableFrom?.toISOString().slice(0, 10)).toBe('2026-11-24');
    } finally {
      // 기준정보는 truncate로 지워지지 않는다 — 실패하더라도 되돌려야 다음 실행이 흔들리지 않는다.
      await ctx.prisma.rentalReturnPolicy.updateMany({ data: { darkCleaningDays: 1 } });
    }
  });

  it('기간을 주면 대여 기간이 걸치는 건을 전부 돌려준다 (시작·끝이 안에 들어올 필요는 없다)', async () => {
    await ensurePolicyOrder();
    const component = await ctx.prisma.orderItemComponent.create({
      data: { id: randomUUID(), orderItemId: policyOrderItemId, componentType: 'JACKET' },
    });
    const created = await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'JACKET', color: 'NAVY', size: '54' })
      .expect(201);
    // 12/28 나가 이듬해 1/3에 들어오는 건 — 12월로 찾아도 1월로 찾아도 걸려야 한다.
    const allocation = await api(ctx)
      .post(`/api/v1/rental-orders/${policyOrderId}/allocations`)
      .set(auth(ctx))
      .send({
        componentId: component.id,
        inventoryItemId: created.body.data[0].id,
        pickupDate: '2026-12-28',
        returnDueDate: '2027-01-03',
      })
      .expect(201);
    const id = allocation.body.data.id as string;

    const idsIn = async (from: string, to: string) => {
      const res = await api(ctx)
        .get('/api/v1/rental-allocations')
        .set(auth(ctx))
        .query({ view: 'pickup', from, to })
        .expect(200);
      return (res.body.data as { id: string }[]).map((r) => r.id);
    };

    expect(await idsIn('2026-12-01', '2026-12-31')).toContain(id); // 나가는 달
    expect(await idsIn('2027-01-01', '2027-01-31')).toContain(id); // 들어오는 달
    expect(await idsIn('2026-12-30', '2026-12-31')).toContain(id); // 기간 한가운데
    expect(await idsIn('2026-11-01', '2026-11-30')).not.toContain(id); // 안 걸치는 달
  });

  it('지난 내역 뷰는 끝난 건만 기간으로 돌려준다 (처리 대상 목록에는 안 남는다)', async () => {
    const { allocationId: doneId } = await returnOneItem(
      'NAVY',
      { pickupDate: '2026-12-01', returnDueDate: '2026-12-02' },
      { returnDate: '2026-12-02' },
    );

    const inRange = await api(ctx)
      .get('/api/v1/rental-allocations')
      .set(auth(ctx))
      .query({ view: 'history', from: '2026-12-01', to: '2026-12-31' })
      .expect(200);
    const found = (inRange.body.data as { id: string; status: string; actualReturnAt: string }[]).find(
      (r) => r.id === doneId,
    );
    expect(found?.status).toBe('RETURNED');
    expect(found?.actualReturnAt).toContain('2026-12-02');

    // 기간 밖이면 안 나온다 — 기본값(최근 3개월)으로도 12월 건은 안 잡힌다.
    const outOfRange = await api(ctx)
      .get('/api/v1/rental-allocations')
      .set(auth(ctx))
      .query({ view: 'history', from: '2026-01-01', to: '2026-01-31' })
      .expect(200);
    expect((outOfRange.body.data as { id: string }[]).map((r) => r.id)).not.toContain(doneId);

    // 반납이 끝난 건은 처리 대상 목록(출고·반납)에는 남지 않는다
    for (const view of ['pickup', 'return']) {
      const res = await api(ctx)
        .get('/api/v1/rental-allocations')
        .set(auth(ctx))
        .query({ view, date: '2026-12-02' })
        .expect(200);
      expect((res.body.data as { id: string }[]).map((r) => r.id)).not.toContain(doneId);
    }
  });

  it('연락·회신·변경을 비고로 쌓고, 연락 횟수와 최근 비고를 목록에 실어 준다', async () => {
    await ensurePolicyOrder();
    const component = await ctx.prisma.orderItemComponent.create({
      data: { id: randomUUID(), orderItemId: policyOrderItemId, componentType: 'JACKET' },
    });
    const created = await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'JACKET', color: 'NAVY', size: '54' })
      .expect(201);
    const allocation = await api(ctx)
      .post(`/api/v1/rental-orders/${policyOrderId}/allocations`)
      .set(auth(ctx))
      .send({
        componentId: component.id,
        inventoryItemId: created.body.data[0].id,
        pickupDate: '2027-02-01',
        returnDueDate: '2027-02-03',
      })
      .expect(201);
    const id = allocation.body.data.id as string;

    // 회신 — 전화로 받은 답을 남긴다
    await api(ctx)
      .post(`/api/v1/rental-allocations/${id}/notes`)
      .set(auth(ctx))
      .send({ kind: 'REPLY', body: '3일 뒤 방문하겠다고 함' })
      .expect(201);
    // 반납일 변경은 기록만 — 배정 기간은 그대로 둔다
    await api(ctx)
      .post(`/api/v1/rental-allocations/${id}/notes`)
      .set(auth(ctx))
      .send({ kind: 'CHANGE', newReturnDueDate: '2027-02-06', body: '고객 요청' })
      .expect(201);
    // 연락은 실제 발송을 거쳐야 하므로 이 경로로 만들 수 없다
    await api(ctx)
      .post(`/api/v1/rental-allocations/${id}/notes`)
      .set(auth(ctx))
      .send({ kind: 'CONTACT', body: '보냄' })
      .expect(400);
    // 발송 결과 봉합 — 이것만 횟수에 잡힌다. 보낸 문구는 담지 않는다(문구가 하나뿐이라 다 같다).
    const contact = await api(ctx)
      .post(`/api/v1/rental-allocations/${id}/contacts`)
      .set(auth(ctx))
      .send({ channel: 'ALIMTALK' })
      .expect(201);
    expect(contact.body.data.body).toBe('연락 발송 · 알림톡');

    const notes = await api(ctx).get(`/api/v1/rental-allocations/${id}/notes`).set(auth(ctx)).expect(200);
    const kinds = (notes.body.data as { kind: string; body: string }[]).map((n) => n.kind);
    expect(kinds).toEqual(['CONTACT', 'CHANGE', 'REPLY']); // 최근 것부터
    const change = (notes.body.data as { kind: string; body: string }[]).find((n) => n.kind === 'CHANGE');
    expect(change?.body).toBe('반납 예정일 2027-02-03 → 2027-02-06 · 고객 요청');

    // 기록해도 배정의 반납 예정일은 그대로다 — 기간 잠금을 흔들지 않는다
    const untouched = await ctx.prisma.rentalAllocation.findUniqueOrThrow({ where: { id } });
    expect(untouched.returnDueDate.toISOString().slice(0, 10)).toBe('2027-02-03');

    const list = await api(ctx)
      .get('/api/v1/rental-allocations')
      .set(auth(ctx))
      .query({ view: 'pickup', from: '2027-02-01', to: '2027-02-28' })
      .expect(200);
    const row = (list.body.data as { id: string; contactCount: number; lastNote: { kind: string } }[]).find(
      (r) => r.id === id,
    );
    expect(row?.contactCount).toBe(1);
    // 비고에는 연락이 올라오지 않는다 — 횟수는 연락 칸이 말하고, 비고는 "그래서 뭐라던가"를 본다.
    expect(row?.lastNote.kind).toBe('CHANGE');
  });

  it('지연일수를 계산하고 지연만 보기로 거른다', async () => {
    await ensurePolicyOrder();
    const component = await ctx.prisma.orderItemComponent.create({
      data: { id: randomUUID(), orderItemId: policyOrderItemId, componentType: 'JACKET' },
    });
    const created = await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'JACKET', color: 'NAVY', size: '54' })
      .expect(201);
    const allocation = await api(ctx)
      .post(`/api/v1/rental-orders/${policyOrderId}/allocations`)
      .set(auth(ctx))
      .send({
        componentId: component.id,
        inventoryItemId: created.body.data[0].id,
        pickupDate: '2027-03-01',
        returnDueDate: '2027-03-05',
      })
      .expect(201);
    const id = allocation.body.data.id as string;

    const rowOn = async (date: string, extra: Record<string, unknown> = {}) => {
      const res = await api(ctx)
        .get('/api/v1/rental-allocations')
        .set(auth(ctx))
        .query({ view: 'pickup', from: '2027-03-01', to: '2027-03-31', date, ...extra })
        .expect(200);
      return (res.body.data as { id: string; overdueDays: number }[]).find((r) => r.id === id);
    };

    // 픽업일 당일은 아직 안 밀렸다
    expect((await rowOn('2027-03-01'))?.overdueDays).toBe(0);
    // 사흘 지나면 미픽업 3일
    expect((await rowOn('2027-03-04'))?.overdueDays).toBe(3);
    // 지연만 보기 — 안 밀린 날에는 목록에서 빠진다
    expect(await rowOn('2027-03-01', { overdueOnly: true })).toBeUndefined();
    expect((await rowOn('2027-03-04', { overdueOnly: true }))?.overdueDays).toBe(3);
  });

  it('컬러 추가는 이름과 색 계열만 받고 코드·순번은 서버가 채운다', async () => {
    const created: string[] = [];
    try {
      const first = await api(ctx)
        .post('/api/v1/admin/master/rental-colors')
        .set(auth(ctx))
        .send({ name: '세이지 그린', tone: 'LIGHT' })
        .expect(201);
      created.push(first.body.data.id);
      // 코드는 사람이 정하지 않는다 — 시스템이 실물 관리코드에 쓰는 값이다
      expect(first.body.data.code).toMatch(/^COLOR_\d+$/);
      // 품목을 안 주면 전 품목 공통, 색 계열은 준 대로
      expect(first.body.data).toMatchObject({ tone: 'LIGHT', componentTypes: [] });

      const second = await api(ctx)
        .post('/api/v1/admin/master/rental-colors')
        .set(auth(ctx))
        .send({ name: '더스티 블루' })
        .expect(201);
      created.push(second.body.data.id);
      expect(second.body.data.code).not.toBe(first.body.data.code);
      // 색 계열 기본값은 블랙 타입 — 밝은색으로 잘못 잡으면 재고가 하루 더 묶인다
      expect(second.body.data.tone).toBe('DARK');
      // 새 색은 목록 맨 뒤에 붙는다
      expect(second.body.data.sortOrder).toBeGreaterThan(first.body.data.sortOrder);

      // 삭제 대신 중지, 그리고 되살리기
      const id = first.body.data.id as string;
      const stopped = await api(ctx)
        .patch(`/api/v1/admin/master/rental-colors/${id}`)
        .set(auth(ctx))
        .send({ active: false })
        .expect(200);
      expect(stopped.body.data.active).toBe(false);
      const resumed = await api(ctx)
        .patch(`/api/v1/admin/master/rental-colors/${id}`)
        .set(auth(ctx))
        .send({ active: true, tone: 'DARK' })
        .expect(200);
      expect(resumed.body.data).toMatchObject({ active: true, tone: 'DARK' });
    } finally {
      // 기준정보는 truncate 대상이 아니다 — 남겨 두면 다음 실행의 채번·순번이 어긋난다.
      await ctx.prisma.rentalColor.deleteMany({ where: { id: { in: created } } });
    }
  });

  // ---------------------------------------------------------------------------
  // 5. 상태 변경·폐기 처리 충돌 검증
  // ---------------------------------------------------------------------------

  it('현재·미래 배정과 충돌하는 수동 상태 변경과 폐기 처리를 차단한다', async () => {
    // itemA2는 08-07~08-09 RESERVED 배정 보유
    const statusRes = await api(ctx)
      .post(`/api/v1/rental-inventory/${itemA2.id}/status-events`)
      .set(auth(ctx))
      .send({ newStatus: 'UNAVAILABLE', reason: '오염' })
      .expect(409);
    expect(statusRes.body.error.code).toBe('INVALID_STATUS_TRANSITION');

    const retireRes = await api(ctx)
      .post(`/api/v1/rental-inventory/${itemA2.id}/retire`)
      .set(auth(ctx))
      .send({ reason: '폐기' })
      .expect(409);
    expect(retireRes.body.error.code).toBe('INVALID_STATUS_TRANSITION');

    // 배정 없는 실물은 폐기 처리 가능
    const created = await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'SHOES', color: 'SHOE_BLACK', size: '260', managementCode: 'SHO-RET-001' })
      .expect(201);
    const shoesId = created.body.data[0].id;

    // 폐기는 되돌릴 수 없어 사유가 필수다 — 누락·공백 모두 거른다.
    await api(ctx).post(`/api/v1/rental-inventory/${shoesId}/retire`).set(auth(ctx)).send({}).expect(400);
    await api(ctx)
      .post(`/api/v1/rental-inventory/${shoesId}/retire`)
      .set(auth(ctx))
      .send({ reason: '   ' })
      .expect(400);

    const retired = await api(ctx)
      .post(`/api/v1/rental-inventory/${shoesId}/retire`)
      .set(auth(ctx))
      .send({ reason: '운영 종료' })
      .expect(201);
    expect(retired.body.data.status).toBe('RETIRED');
    expect(retired.body.data.active).toBe(false);

    // 입력한 사유가 상태 이력에 그대로 남아야 화면 하단 패널에서 확인할 수 있다.
    const detail = await api(ctx).get(`/api/v1/rental-inventory/${shoesId}`).set(auth(ctx)).expect(200);
    const retireEvent = detail.body.data.statusEvents.find(
      (e: { newStatus: string }) => e.newStatus === 'RETIRED',
    );
    expect(retireEvent.reason).toBe('운영 종료');
  });

  it('폐기한 실물의 관리코드는 새 실물에 다시 쓸 수 있다 (이력은 남는다)', async () => {
    const code = 'REUSE-SHO-001';
    const first = await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'SHOES', color: 'SHOE_BLACK', size: '265', managementCode: code })
      .expect(201);
    const firstId = first.body.data[0].id;

    // 살아 있는 동안에는 같은 코드로 다시 못 넣는다.
    await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'SHOES', color: 'SHOE_BROWN', size: '270', managementCode: code })
      .expect(400);

    await api(ctx)
      .post(`/api/v1/rental-inventory/${firstId}/retire`)
      .set(auth(ctx))
      .send({ reason: '밑창 손상' })
      .expect(201);

    // 폐기 후에는 같은 코드표를 새 옷에 붙일 수 있다.
    const second = await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'SHOES', color: 'SHOE_BROWN', size: '270', managementCode: code })
      .expect(201);
    expect(second.body.data[0].id).not.toBe(firstId);

    // 같은 코드로 두 행이 남되, 목록(기본=폐기 제외)에는 새 것만 보인다.
    expect(await ctx.prisma.rentalInventoryItem.count({ where: { managementCode: code } })).toBe(2);
    const list = await api(ctx)
      .get('/api/v1/rental-inventory')
      .set(auth(ctx))
      .query({ managementCode: code })
      .expect(200);
    expect(list.body.data.map((i: { id: string }) => i.id)).toEqual([second.body.data[0].id]);

    // 폐기만 보기로는 폐기된 쪽만 나온다.
    const retiredOnly = await api(ctx)
      .get('/api/v1/rental-inventory')
      .set(auth(ctx))
      .query({ managementCode: code, retired: 'true' })
      .expect(200);
    expect(retiredOnly.body.data.map((i: { id: string }) => i.id)).toEqual([firstId]);
  });

  // ---------------------------------------------------------------------------
  // 6. 이력·감사로그
  // ---------------------------------------------------------------------------

  it('배정·변경·출고·반납 이벤트와 실물 상태 이력, 감사로그가 기록된다', async () => {
    const events = await ctx.prisma.rentalAllocationEvent.findMany({
      where: { rentalAllocationId: allocationId },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toEqual(['ASSIGNED', 'ITEM_CHANGED', 'PICKED_UP', 'RETURNED']);

    // 실물 상세에 배정·상태 이력이 포함된다
    const detail = await api(ctx).get(`/api/v1/rental-inventory/${itemA2.id}`).set(auth(ctx)).expect(200);
    expect(detail.body.data.allocations.length).toBeGreaterThanOrEqual(2);
    const statuses = detail.body.data.statusEvents.map((e: { newStatus: string }) => e.newStatus);
    expect(statuses).toEqual(expect.arrayContaining(['RESERVED', 'CHECKED_OUT', 'RETURNED_HOLD', 'AVAILABLE']));

    // 감사로그 (배정 생성·상태 변경)
    const auditCount = await ctx.prisma.auditLog.count({
      where: { entityType: 'RENTAL_ALLOCATION', entityId: allocationId },
    });
    expect(auditCount).toBeGreaterThanOrEqual(3);
    const itemAudit = await ctx.prisma.auditLog.count({
      where: { entityType: 'RENTAL_INVENTORY_ITEM', action: 'STATUS_CHANGE' },
    });
    expect(itemAudit).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // 7. 연동정합화 — 관리코드 수용·출고/반납·구성품 목록 뷰 (계약 §5)
  // ---------------------------------------------------------------------------

  let codeAllocationId: string;

  it('배정 생성 시 inventoryItemId 대신 itemCode(관리코드)를 허용한다', async () => {
    // 실물 ID·관리코드 둘 다 없으면 400
    const missing = await api(ctx)
      .post(`/api/v1/rental-orders/${orderId}/allocations`)
      .set(auth(ctx))
      .send({
        componentId: jacketComponentId,
        pickupDate: '2026-10-01',
        returnDueDate: '2026-10-03',
        availabilityEndDate: '2026-10-05',
      })
      .expect(400);
    expect(missing.body.error.code).toBe('VALIDATION_ERROR');

    // 없는 관리코드는 404
    await api(ctx)
      .post(`/api/v1/rental-orders/${orderId}/allocations`)
      .set(auth(ctx))
      .send({
        componentId: jacketComponentId,
        itemCode: 'NO-SUCH-CODE',
        pickupDate: '2026-10-01',
        returnDueDate: '2026-10-03',
        availabilityEndDate: '2026-10-05',
      })
      .expect(404);

    const res = await api(ctx)
      .post(`/api/v1/rental-orders/${orderId}/allocations`)
      .set(auth(ctx))
      .send({
        componentId: jacketComponentId,
        itemCode: 'JKT-BK-100-001',
        pickupDate: '2026-10-01',
        returnDueDate: '2026-10-03',
        availabilityEndDate: '2026-10-05',
      })
      .expect(201);
    codeAllocationId = res.body.data.id;

    // 관리코드는 살아 있는 실물끼리만 유일하다(폐기 후 재사용) — findFirst로 찾는다.
    const item = await ctx.prisma.rentalInventoryItem.findFirstOrThrow({
      where: { managementCode: 'JKT-BK-100-001' },
    });
    expect(res.body.data.rentalInventoryItemId).toBe(item.id);
    expect(item.status).toBe('RESERVED');
  });

  it('pickup 뷰는 기준일까지의 예약 배정을 평면 뷰로 반환한다', async () => {
    const res = await api(ctx)
      .get('/api/v1/rental-allocations')
      .set(auth(ctx))
      .query({ view: 'pickup', date: '2026-10-01' })
      .expect(200);
    const row = res.body.data.find((a: { id: string }) => a.id === codeAllocationId);
    expect(row).toMatchObject({
      status: 'RESERVED',
      pickupDate: '2026-10-01',
      returnDueDate: '2026-10-03',
      managementCode: 'JKT-BK-100-001',
      componentType: 'JACKET',
      componentId: jacketComponentId,
      displayName: '렌탈 정장 #1',
      orderNo: 'ORD-260721-901',
      customerName: '렌탈 고객',
      version: 0,
    });

    // 기준일 이후 픽업 예정 건은 제외
    const earlier = await api(ctx)
      .get('/api/v1/rental-allocations')
      .set(auth(ctx))
      .query({ view: 'pickup', date: '2026-08-06' })
      .expect(200);
    expect(earlier.body.data).toEqual([]);

    // view 누락은 400
    await api(ctx).get('/api/v1/rental-allocations').set(auth(ctx)).expect(400);
  });

  it('출고 비고는 배정 이벤트에 남는다 (예약과 다른 옷을 내보낸 경우 기록용)', async () => {
    const ok = await api(ctx)
      .post(`/api/v1/rental-allocations/${codeAllocationId}/checkout`)
      .set(auth(ctx))
      .send({ checkoutDate: '2026-10-01', notes: '사이즈 교환 요청으로 50호 출고', version: 0 })
      .expect(201);
    expect(ok.body.data.status).toBe('CHECKED_OUT');

    const event = await ctx.prisma.rentalAllocationEvent.findFirstOrThrow({
      where: { rentalAllocationId: codeAllocationId, eventType: 'PICKED_UP' },
    });
    expect(event.reason).toBe('사이즈 교환 요청으로 50호 출고');
  });

  it('출고 비고는 선택값이라 없어도 출고된다', async () => {
    const alloc = await api(ctx)
      .post(`/api/v1/rental-orders/${orderId}/allocations`)
      .set(auth(ctx))
      .send({
        componentId: jacketComponentId,
        itemCode: 'JKT-BK-100-002',
        pickupDate: '2026-11-01',
        returnDueDate: '2026-11-02',
        availabilityEndDate: '2026-11-03',
      })
      .expect(201);
    await api(ctx)
      .post(`/api/v1/rental-allocations/${alloc.body.data.id}/checkout`)
      .set(auth(ctx))
      .send({ checkoutDate: '2026-11-01', version: 0 })
      .expect(201);
  });

  it('return 뷰는 출고 배정을 지연 여부와 함께 반환한다', async () => {
    const onTime = await api(ctx)
      .get('/api/v1/rental-allocations')
      .set(auth(ctx))
      .query({ view: 'return', date: '2026-10-03' })
      .expect(200);
    const row = onTime.body.data.find((a: { id: string }) => a.id === codeAllocationId);
    expect(row.status).toBe('CHECKED_OUT');
    expect(row.overdue).toBe(false);

    // 반납예정일(10-03) 경과 — 지연 건도 포함하고 overdue 표시
    const late = await api(ctx)
      .get('/api/v1/rental-allocations')
      .set(auth(ctx))
      .query({ view: 'return', date: '2026-10-06' })
      .expect(200);
    const lateRow = late.body.data.find((a: { id: string }) => a.id === codeAllocationId);
    expect(lateRow.overdue).toBe(true);
  });

  it('rental-orders/components는 렌탈 구성품과 현재 배정을 반환한다', async () => {
    const res = await api(ctx)
      .get('/api/v1/rental-orders/components')
      .set(auth(ctx))
      .query({ orderId })
      .expect(200);
    expect(res.body.data.length).toBe(1);
    const comp = res.body.data[0];
    expect(comp).toMatchObject({
      componentId: jacketComponentId,
      componentType: 'JACKET',
      displayName: '렌탈 정장 #1',
      orderId,
      orderNo: 'ORD-260721-901',
      customerName: '렌탈 고객',
    });
    // 현재 배정 = 픽업일이 가장 이른 활성 배정 (AV-J-002, 08-07 RESERVED)
    expect(comp.currentAllocation.managementCode).toBe('AV-J-002');
    expect(comp.currentAllocation.status).toBe('RESERVED');
    expect(comp.currentAllocation.pickupDate).toBe('2026-08-07');

    // orderId 없으면 활성 렌탈 주문 전체
    const all = await api(ctx).get('/api/v1/rental-orders/components').set(auth(ctx)).expect(200);
    expect(all.body.data.map((c: { componentId: string }) => c.componentId)).toContain(jacketComponentId);

    // 없는 주문은 404
    await api(ctx)
      .get('/api/v1/rental-orders/components')
      .set(auth(ctx))
      .query({ orderId: randomUUID() })
      .expect(404);
  });

  // ---------------------------------------------------------------------------
  // 8. 렌탈예약 달력 — 일자별 가용 집계 (설계서 06 §4)
  // ---------------------------------------------------------------------------

  it('availability-calendar는 일자별 가용 수를 집계하고 배정 기간엔 가용이 줄어든다', async () => {
    // 달력 전용 격리 재고: 고유 디자인 'CAL달력'으로 다른 테스트 데이터와 분리
    const created = await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'JACKET', color: 'GREY', size: '56', managementCode: 'CAL-J', quantity: 2 })
      .expect(201);
    const [cal1] = created.body.data;

    // 배정 전: 3일 모두 가용 2건
    const before = await api(ctx)
      .get('/api/v1/rental-inventory/availability-calendar')
      .set(auth(ctx))
      .query({ from: '2027-01-10', to: '2027-01-12', color: 'GREY', size: '56' })
      .expect(200);
    expect(before.body.data.map((d: { date: string }) => d.date)).toEqual([
      '2027-01-10',
      '2027-01-11',
      '2027-01-12',
    ]);
    expect(before.body.data.every((d: { availableCount: number }) => d.availableCount === 2)).toBe(true);
    expect(before.body.data[0].items.length).toBe(2);

    // CAL-J-001을 2027-01-10 ~ 01-11(가용종료) 배정
    await api(ctx)
      .post(`/api/v1/rental-orders/${orderId}/allocations`)
      .set(auth(ctx))
      .send({
        componentId: jacketComponentId,
        inventoryItemId: cal1.id,
        pickupDate: '2027-01-10',
        returnDueDate: '2027-01-11',
        availabilityEndDate: '2027-01-11',
      })
      .expect(201);

    // 배정 후: 01-10·01-11은 가용 1건(배정된 실물 제외), 01-12는 다시 2건
    const after = await api(ctx)
      .get('/api/v1/rental-inventory/availability-calendar')
      .set(auth(ctx))
      .query({ from: '2027-01-10', to: '2027-01-12', color: 'GREY', size: '56' })
      .expect(200);
    const byDate = Object.fromEntries(
      after.body.data.map((d: { date: string; availableCount: number }) => [d.date, d.availableCount]),
    );
    expect(byDate['2027-01-10']).toBe(1);
    expect(byDate['2027-01-11']).toBe(1);
    expect(byDate['2027-01-12']).toBe(2);

    // q 검색어(관리코드 부분일치)와 잘못된 기간(from>to) 방어
    const q = await api(ctx)
      .get('/api/v1/rental-inventory/availability-calendar')
      .set(auth(ctx))
      .query({ from: '2027-01-12', to: '2027-01-12', q: 'CAL-J' })
      .expect(200);
    expect(q.body.data[0].items.every((i: { managementCode: string }) => i.managementCode.includes('CAL-J'))).toBe(true);

    await api(ctx)
      .get('/api/v1/rental-inventory/availability-calendar')
      .set(auth(ctx))
      .query({ from: '2027-01-12', to: '2027-01-10' })
      .expect(400);
  });
});

// ---------------------------------------------------------------------------
// 렌탈 스타일 선택 + 기준정보(컬러/사이즈) (v2 D3 / 설계서 04 §4·§5)
// ---------------------------------------------------------------------------

describe('렌탈 스타일 선택·기준정보 (v2 D3)', () => {
  let ctx: TestContext;
  // 렌탈 선택은 계약 품목(ContractItem)·그 부위에 붙는다 (컨설팅은 작성중 단계)
  let contractItemId: string;
  let jacketComponentId: string;
  let sessionId: string;
  let sessionVersion = 0;

  beforeAll(async () => {
    ctx = await createTestContext();
    await truncateBusinessData(ctx.prisma);

    const admin = await ctx.prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
    const customer = await ctx.prisma.customer.create({
      data: {
        id: randomUUID(),
        name: '렌탈선택 고객',
        phone: '010-9100-0001',
        phoneNormalized: '01091000001',
        customerStatus: 'CONTRACTED',
      },
    });
    // 렌탈 선택(컨설팅)은 계약 작성중(DRAFT)에서 한다 (현업 확정 2026-07-31).
    const contract = await ctx.prisma.contract.create({
      data: { id: randomUUID(), contractNo: 'CTR-260721-950', customerId: customer.id, status: 'DRAFT' },
    });
    const version = await ctx.prisma.contractVersion.create({
      data: { id: randomUUID(), contractId: contract.id, versionNo: 1, versionStatus: 'CONFIRMED', createdBy: admin.id },
    });
    const line = await ctx.prisma.contractLine.create({
      data: { id: randomUUID(), contractVersionId: version.id, transactionType: 'RENTAL', productCategory: 'SUIT', quantity: 1 },
    });
    const order = await ctx.prisma.order.create({
      data: { id: randomUUID(), orderNo: 'ORD-260721-950', contractId: contract.id, transactionType: 'RENTAL' },
    });
    const contractItem = await ctx.prisma.contractItem.create({
      data: {
        id: randomUUID(),
        contractId: contract.id,
        sourceContractLineId: line.id,
        transactionType: 'RENTAL',
        productCategory: 'SUIT',
        sequenceNo: 1,
        displayName: '렌탈 정장',
      },
    });
    contractItemId = contractItem.id;
    const jacket = await ctx.prisma.contractItemComponent.create({
      data: { id: randomUUID(), contractItemId: contractItem.id, componentType: 'JACKET' },
    });
    jacketComponentId = jacket.id;
    // 물리화(계약완료) 결과인 주문품목 — 배정 흐름에서 쓴다.
    await ctx.prisma.orderItem.create({
      data: {
        id: randomUUID(),
        orderId: order.id,
        sourceContractItemId: contractItem.id,
        productCategory: 'SUIT',
        sequenceNo: 1,
        displayName: '렌탈 정장',
      },
    });

    // 후보가 될 AVAILABLE 실물 2건 (JACKET / NAVY / L)
    await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'JACKET', color: 'NAVY', size: '50', managementCode: 'RJ-NV-L', quantity: 2 })
      .expect(201);
    // 다른 색은 후보에서 제외되어야 한다
    await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'JACKET', color: 'BLACK', size: '50', managementCode: 'RJ-BK-L' })
      .expect(201);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('rental-colors/rental-sizes 기준정보가 시드되어 있고 CRUD가 동작한다', async () => {
    const colors = await api(ctx).get('/api/v1/admin/master/rental-colors').set(auth(ctx)).expect(200);
    expect(colors.body.data.length).toBeGreaterThanOrEqual(12);
    expect(colors.body.data.map((c: { code: string }) => c.code)).toContain('NAVY');

    const sizes = await api(ctx).get('/api/v1/admin/master/rental-sizes').set(auth(ctx)).expect(200);
    expect(sizes.body.data.map((s: { code: string }) => s.code)).toEqual(
      expect.arrayContaining(['46', '50', '92', '100', '260']),
    );

    // create → retire (마스터 테이블은 스위트 간 truncate되지 않으므로 코드는 매 실행 고유값)
    const newCode = `TEAL_${randomUUID().slice(0, 6).toUpperCase()}`;
    const created = await api(ctx)
      .post('/api/v1/admin/master/rental-colors')
      .set(auth(ctx))
      .send({ code: newCode, name: '틸', sortOrder: 99 })
      .expect(201);
    expect(created.body.data.code).toBe(newCode);
    const retired = await api(ctx)
      .post(`/api/v1/admin/master/rental-colors/${created.body.data.id}/retire`)
      .set(auth(ctx))
      .expect(201);
    expect(retired.body.data.active).toBe(false);
  });

  it('RENTAL 품목의 렌탈 선택 세션을 시작하고 부위 슬롯을 반환한다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/contract-items/${contractItemId}/rental-selection`)
      .set(auth(ctx))
      .expect(201);
    expect(res.body.data.status).toBe('IN_PROGRESS');
    expect(res.body.data.components).toHaveLength(1);
    expect(res.body.data.components[0].componentType).toBe('JACKET');
    sessionId = res.body.data.sessionId;
    sessionVersion = res.body.data.version;

    // 재호출 시 동일 현재 세션 반환
    const again = await api(ctx)
      .post(`/api/v1/contract-items/${contractItemId}/rental-selection`)
      .set(auth(ctx))
      .expect(201);
    expect(again.body.data.sessionId).toBe(sessionId);
  });

  it('부위별 컬러·사이즈·비고를 저장하고 잘못된 코드는 거부한다', async () => {
    const res = await api(ctx)
      .put(`/api/v1/rental-selections/${sessionId}/lines/${jacketComponentId}`)
      .set(auth(ctx))
      .send({ colorCode: 'NAVY', sizeCode: '50', notes: '기장 -2cm', version: sessionVersion })
      .expect(200);
    const jacket = res.body.data.components.find(
      (c: { contractItemComponentId: string }) => c.contractItemComponentId === jacketComponentId,
    );
    expect(jacket).toMatchObject({ colorCode: 'NAVY', sizeCode: '50', notes: '기장 -2cm' });
    sessionVersion = res.body.data.version;

    await api(ctx)
      .put(`/api/v1/rental-selections/${sessionId}/lines/${jacketComponentId}`)
      .set(auth(ctx))
      .send({ colorCode: 'NOPE', version: sessionVersion })
      .expect(400);
  });

  it('대여 기간을 정하기 전에는 후보 조회·확정이 422 RENTAL_PERIOD_REQUIRED로 막힌다', async () => {
    const cand = await api(ctx)
      .get(`/api/v1/rental-selections/${sessionId}/lines/${jacketComponentId}/candidates`)
      .set(auth(ctx))
      .expect(422);
    expect(cand.body.error.code).toBe('RENTAL_PERIOD_REQUIRED');

    const confirm = await api(ctx)
      .post(`/api/v1/rental-selections/${sessionId}/confirm`)
      .set(auth(ctx))
      .send({ version: sessionVersion })
      .expect(422);
    expect(confirm.body.error.code).toBe('RENTAL_PERIOD_REQUIRED');
  });

  it('대여 기간을 저장한다 — 반납일이 대여일보다 빠르면 거부', async () => {
    const bad = await api(ctx)
      .put(`/api/v1/rental-selections/${sessionId}/period`)
      .set(auth(ctx))
      .send({ pickupDate: '2026-09-10', returnDueDate: '2026-09-01', version: sessionVersion })
      .expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');

    const res = await api(ctx)
      .put(`/api/v1/rental-selections/${sessionId}/period`)
      .set(auth(ctx))
      .send({ pickupDate: '2026-09-01', returnDueDate: '2026-09-10', version: sessionVersion })
      .expect(200);
    expect(res.body.data.pickupDate).toContain('2026-09-01');
    expect(res.body.data.returnDueDate).toContain('2026-09-10');
    sessionVersion = res.body.data.version;
  });

  it('후보 조회는 대여 기간에 비어 있는 실물을 부위×컬러×사이즈로 필터한다', async () => {
    const res = await api(ctx)
      .get(`/api/v1/rental-selections/${sessionId}/lines/${jacketComponentId}/candidates`)
      .set(auth(ctx))
      .expect(200);
    const codes = res.body.data.candidates.map((c: { managementCode: string }) => c.managementCode);
    // NAVY 2건만, BLACK 제외
    expect(codes.sort()).toEqual(['RJ-NV-L-001', 'RJ-NV-L-002']);
  });

  it('후보 실물 선택 → 확정 → 확인서(코드→표시명) 흐름', async () => {
    const cand = await api(ctx)
      .get(`/api/v1/rental-selections/${sessionId}/lines/${jacketComponentId}/candidates`)
      .set(auth(ctx))
      .expect(200);
    const pick = cand.body.data.candidates[0];

    const selected = await api(ctx)
      .put(`/api/v1/rental-selections/${sessionId}/lines/${jacketComponentId}/item`)
      .set(auth(ctx))
      .send({ inventoryItemId: pick.id, version: sessionVersion })
      .expect(200);
    const jacket = selected.body.data.components.find(
      (c: { contractItemComponentId: string }) => c.contractItemComponentId === jacketComponentId,
    );
    expect(jacket.selectedInventoryItemId).toBe(pick.id);
    sessionVersion = selected.body.data.version;

    const confirmed = await api(ctx)
      .post(`/api/v1/rental-selections/${sessionId}/confirm`)
      .set(auth(ctx))
      .send({ version: sessionVersion })
      .expect(200);
    expect(confirmed.body.data.status).toBe('CONFIRMED');

    // 확정 후 수정 차단
    await api(ctx)
      .put(`/api/v1/rental-selections/${sessionId}/lines/${jacketComponentId}`)
      .set(auth(ctx))
      .send({ colorCode: 'BLACK' })
      .expect(409);

    const review = await api(ctx)
      .get(`/api/v1/rental-selections/${sessionId}/review`)
      .set(auth(ctx))
      .expect(200);
    const rJacket = review.body.data.components[0];
    expect(rJacket).toMatchObject({ colorCode: 'NAVY', colorName: '네이비', sizeCode: '50' });
    expect(rJacket.selectedItem.managementCode).toBe(pick.managementCode);

    // 감사로그
    const audits = await ctx.prisma.auditLog.count({
      where: { entityType: 'RENTAL_SELECTION_SESSION', entityId: sessionId, action: 'CONFIRM' },
    });
    expect(audits).toBe(1);
  });

  it('기간이 겹치는 배정이 있는 실물은 후보에서 빠지고, 기간을 바꾸면 고른 실물이 해제된다', async () => {
    // 새 세션(2번째 버전)으로 검증한다 — 앞 테스트에서 현재 세션은 확정됐다.
    await ctx.prisma.rentalSelectionSession.updateMany({
      where: { contractItemId },
      data: { isCurrent: false },
    });
    const started = await api(ctx)
      .post(`/api/v1/contract-items/${contractItemId}/rental-selection`)
      .set(auth(ctx))
      .expect(201);
    const sid = started.body.data.sessionId as string;
    let ver = started.body.data.version as number;

    const setPeriod = async (pickupDate: string, returnDueDate: string) => {
      const r = await api(ctx)
        .put(`/api/v1/rental-selections/${sid}/period`)
        .set(auth(ctx))
        .send({ pickupDate, returnDueDate, version: ver })
        .expect(200);
      ver = r.body.data.version;
      return r;
    };
    const codesOf = async () => {
      const r = await api(ctx)
        .get(`/api/v1/rental-selections/${sid}/lines/${jacketComponentId}/candidates`)
        .set(auth(ctx))
        .expect(200);
      return (r.body.data.candidates as { managementCode: string }[])
        .map((c) => c.managementCode)
        .sort();
    };

    await api(ctx)
      .put(`/api/v1/rental-selections/${sid}/lines/${jacketComponentId}`)
      .set(auth(ctx))
      .send({ colorCode: 'NAVY', sizeCode: '50', version: ver })
      .then((r) => {
        ver = r.body.data.version;
      });

    // 10/01~10/10에 RJ-NV-L-001을 이미 배정해 둔다 → 겹치는 기간에는 후보에서 빠져야 한다.
    const occupied = await ctx.prisma.rentalInventoryItem.findFirstOrThrow({
      where: { managementCode: 'RJ-NV-L-001' },
    });
    // 배정(RentalAllocation)은 주문품목 부위에 붙는다 — 계약 품목 부위와 축은 같고 물리화 결과다.
    const physicalItem = await ctx.prisma.orderItem.findFirstOrThrow({
      where: { sourceContractItemId: contractItemId },
    });
    const component = await ctx.prisma.orderItemComponent.create({
      data: { id: randomUUID(), orderItemId: physicalItem.id, componentType: 'JACKET' },
    });
    await ctx.prisma.rentalAllocation.create({
      data: {
        id: randomUUID(),
        orderItemComponentId: component.id,
        rentalInventoryItemId: occupied.id,
        pickupDate: new Date('2026-10-01T00:00:00.000Z'),
        returnDueDate: new Date('2026-10-10T00:00:00.000Z'),
        availabilityEndDate: new Date('2026-10-10T00:00:00.000Z'),
        status: 'RESERVED',
        assignedAt: new Date(),
        assignedBy: (await ctx.prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } })).id,
      },
    });

    await setPeriod('2026-10-05', '2026-10-08');
    expect(await codesOf()).toEqual(['RJ-NV-L-002']);

    // 겹치지 않는 기간이면 둘 다 후보
    await setPeriod('2026-11-01', '2026-11-05');
    expect(await codesOf()).toEqual(['RJ-NV-L-001', 'RJ-NV-L-002']);

    // 실물을 고른 뒤 기간을 바꾸면 선택이 해제된다(그 기간에 빈다는 보장이 사라지므로)
    const picked = await api(ctx)
      .put(`/api/v1/rental-selections/${sid}/lines/${jacketComponentId}/item`)
      .set(auth(ctx))
      .send({ itemCode: 'RJ-NV-L-001', version: ver })
      .expect(200);
    ver = picked.body.data.version;
    expect(picked.body.data.components[0].selectedInventoryItemId).toBeTruthy();

    const moved = await setPeriod('2026-12-01', '2026-12-05');
    expect(moved.body.data.components[0].selectedInventoryItemId).toBeNull();
  });

  it('CUSTOM 품목은 렌탈 선택 시작이 거부된다', async () => {
    const admin = await ctx.prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
    const customer = await ctx.prisma.customer.create({
      data: { id: randomUUID(), name: '맞춤고객', phone: '010-9100-0002', phoneNormalized: '01091000002' },
    });
    const contract = await ctx.prisma.contract.create({
      data: { id: randomUUID(), contractNo: 'CTR-260721-951', customerId: customer.id, status: 'DRAFT' },
    });
    const cv = await ctx.prisma.contractVersion.create({
      data: { id: randomUUID(), contractId: contract.id, versionNo: 1, versionStatus: 'CONFIRMED', createdBy: admin.id },
    });
    const cl = await ctx.prisma.contractLine.create({
      data: { id: randomUUID(), contractVersionId: cv.id, transactionType: 'CUSTOM', productCategory: 'SUIT', quantity: 1 },
    });
    const order = await ctx.prisma.order.create({
      data: { id: randomUUID(), orderNo: 'ORD-260721-951', contractId: contract.id, transactionType: 'CUSTOM' },
    });
    const customItem = await ctx.prisma.contractItem.create({
      data: {
        id: randomUUID(),
        contractId: contract.id,
        sourceContractLineId: cl.id,
        transactionType: 'CUSTOM',
        productCategory: 'SUIT',
        sequenceNo: 1,
        displayName: '맞춤 정장',
      },
    });
    await ctx.prisma.orderItem.create({
      data: {
        id: randomUUID(),
        orderId: order.id,
        sourceContractItemId: customItem.id,
        productCategory: 'SUIT',
        sequenceNo: 1,
        displayName: '맞춤 정장',
      },
    });
    const res = await api(ctx)
      .post(`/api/v1/contract-items/${customItem.id}/rental-selection`)
      .set(auth(ctx))
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
