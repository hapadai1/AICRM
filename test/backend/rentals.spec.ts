import { randomUUID } from 'crypto';
import { RentalsModule } from '../../backend/src/modules/rentals/rentals.module';
import { api, auth, createTestContext, TestContext, truncateBusinessData } from './helpers';

describe('렌탈 실물 재고·기간 배정·출고·반납 (Phase 5)', () => {
  let ctx: TestContext;
  let adminId: string;
  let orderId: string;
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
    const orderItem = await ctx.prisma.orderItem.create({
      data: {
        id: randomUUID(),
        orderId: order.id,
        sourceContractLineId: line.id,
        productCategory: 'SUIT',
        sequenceNo: 1,
        displayName: '렌탈 정장 #1',
      },
    });
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
        design: '클래식',
        color: 'BLACK',
        size: '100',
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
      .send({ componentType: 'JACKET', design: '클래식', color: 'BLACK', size: '100', managementCode: 'JKT-BK-100-EX' })
      .expect(201);
    const skuCount = await ctx.prisma.rentalSku.count({
      where: { componentType: 'JACKET', design: '클래식', color: 'BLACK', size: '100' },
    });
    expect(skuCount).toBe(1);
  });

  it('관리코드 중복 등록을 친절한 오류로 차단한다', async () => {
    const res = await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'JACKET', design: '클래식', color: 'BLACK', size: '100', managementCode: 'JKT-BK-100-002' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('JKT-BK-100-002');
    expect(res.body.error.details.duplicatedCodes).toContain('JKT-BK-100-002');
  });

  it('import는 dryRun 미리보기와 오류 행 분리를 지원한다', async () => {
    const items = [
      { componentType: 'TROUSERS', design: '클래식', color: 'BLACK', size: '95', managementCode: 'PNT-BK-32-001' },
      { componentType: 'JACKET', design: '클래식', color: 'BLACK', size: '100', managementCode: 'JKT-BK-100-002' }, // DB 중복
      { componentType: 'HAT', design: '모자', color: 'GRAY', size: 'F', managementCode: 'HAT-001' }, // 허용되지 않은 품목
      { componentType: 'SHOES', design: '더비', color: 'BROWN' }, // 필수값 누락
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
      .send({ componentType: 'JACKET', design: 'E10', color: 'CHARCOAL', size: '110', managementCode: 'E10-OK-001' })
      .expect(201);
  });

  it('E10: 미등록 color/size 코드는 VALIDATION_ERROR fieldErrors로 차단한다', async () => {
    // 미등록 컬러
    const badColor = await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'JACKET', design: 'E10', color: 'RAINBOW', size: '100', managementCode: 'E10-BADC-001' })
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
      .send({ componentType: 'TROUSERS', design: 'E10', color: 'BLACK', size: '32', managementCode: 'E10-BADS-001' })
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
          { componentType: 'JACKET', design: 'E10', color: 'NAVY', size: '100', managementCode: 'E10-IMP-OK' },
          { componentType: 'JACKET', design: 'E10', color: 'RAINBOW', size: '999', managementCode: 'E10-IMP-BAD' },
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
      .send({ componentType: 'JACKET', design: '가용', color: 'NAVY', size: '105', managementCode: 'AV-J', quantity: 2 })
      .expect(201);
    [itemA1, itemA2] = created.body.data;
    expect(itemA1.managementCode).toBe('AV-J-001');

    const before = await api(ctx)
      .get('/api/v1/rental-inventory/availability')
      .set(auth(ctx))
      .query({ componentType: 'JACKET', design: '가용', pickupDate: '2026-08-01', availabilityEndDate: '2026-08-05' })
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
      .query({ componentType: 'JACKET', design: '가용', pickupDate: '2026-08-03', availabilityEndDate: '2026-08-07' })
      .expect(200);
    expect(overlapped.body.data.map((i: { managementCode: string }) => i.managementCode)).toEqual(['AV-J-002']);

    // 겹치지 않는 기간: RESERVED 상태여도 배정 가능 후보에 포함
    const later = await api(ctx)
      .get('/api/v1/rental-inventory/availability')
      .set(auth(ctx))
      .query({ componentType: 'JACKET', design: '가용', pickupDate: '2026-08-10', availabilityEndDate: '2026-08-12' })
      .expect(200);
    expect(later.body.data.map((i: { managementCode: string }) => i.managementCode)).toContain('AV-J-001');
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

  it('예약 ID와 다른 실물 출고는 RENTAL_ID_MISMATCH로 차단한다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/rental-allocations/${allocationId}/checkout`)
      .set(auth(ctx))
      .send({ confirmedInventoryItemId: itemA2.id, checkoutDate: '2026-08-01', version: 0 })
      .expect(409);
    expect(res.body.error.code).toBe('RENTAL_ID_MISMATCH');
    expect(res.body.error.details.assignedManagementCode).toBe('AV-J-001');
  });

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
      .send({ confirmedInventoryItemId: itemA2.id, checkoutDate: '2026-08-01', version: 1 })
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
      .query({ componentType: 'JACKET', design: '가용', pickupDate: '2026-09-01', availabilityEndDate: '2026-09-03' })
      .expect(200);
    expect(avail.body.data.map((i: { managementCode: string }) => i.managementCode)).not.toContain('AV-J-002');
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
  // 5. 상태 변경·사용 종료 충돌 검증
  // ---------------------------------------------------------------------------

  it('현재·미래 배정과 충돌하는 수동 상태 변경과 사용 종료를 차단한다', async () => {
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

    // 배정 없는 실물은 사용 종료 가능
    const created = await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'SHOES', design: '더비', color: 'BLACK', size: '100', managementCode: 'SHO-RET-001' })
      .expect(201);
    const shoesId = created.body.data[0].id;
    const retired = await api(ctx)
      .post(`/api/v1/rental-inventory/${shoesId}/retire`)
      .set(auth(ctx))
      .send({ reason: '운영 종료' })
      .expect(201);
    expect(retired.body.data.status).toBe('RETIRED');
    expect(retired.body.data.active).toBe(false);
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

    const item = await ctx.prisma.rentalInventoryItem.findUniqueOrThrow({
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
      design: '클래식',
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

  it('출고 시 confirmedItemCode(관리코드)를 허용하고 불일치를 차단한다', async () => {
    // 다른 실물의 관리코드는 RENTAL_ID_MISMATCH
    const mismatch = await api(ctx)
      .post(`/api/v1/rental-allocations/${codeAllocationId}/checkout`)
      .set(auth(ctx))
      .send({ confirmedItemCode: 'AV-J-002', checkoutDate: '2026-10-01', version: 0 })
      .expect(409);
    expect(mismatch.body.error.code).toBe('RENTAL_ID_MISMATCH');
    expect(mismatch.body.error.details.assignedManagementCode).toBe('JKT-BK-100-001');
    expect(mismatch.body.error.details.confirmedItemCode).toBe('AV-J-002');

    // 확인 ID·관리코드 둘 다 없으면 400
    const none = await api(ctx)
      .post(`/api/v1/rental-allocations/${codeAllocationId}/checkout`)
      .set(auth(ctx))
      .send({ checkoutDate: '2026-10-01', version: 0 })
      .expect(400);
    expect(none.body.error.code).toBe('VALIDATION_ERROR');

    const ok = await api(ctx)
      .post(`/api/v1/rental-allocations/${codeAllocationId}/checkout`)
      .set(auth(ctx))
      .send({ confirmedItemCode: 'JKT-BK-100-001', checkoutDate: '2026-10-01', version: 0 })
      .expect(201);
    expect(ok.body.data.status).toBe('CHECKED_OUT');
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
      .send({ componentType: 'JACKET', design: 'CAL달력', color: 'NAVY', size: '100', managementCode: 'CAL-J', quantity: 2 })
      .expect(201);
    const [cal1] = created.body.data;

    // 배정 전: 3일 모두 가용 2건
    const before = await api(ctx)
      .get('/api/v1/rental-inventory/availability-calendar')
      .set(auth(ctx))
      .query({ from: '2027-01-10', to: '2027-01-12', design: 'CAL달력' })
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
      .query({ from: '2027-01-10', to: '2027-01-12', design: 'CAL달력' })
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
  let orderItemId: string;
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
    const contract = await ctx.prisma.contract.create({
      data: { id: randomUUID(), contractNo: 'CTR-260721-950', customerId: customer.id, status: 'CONFIRMED' },
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
    const orderItem = await ctx.prisma.orderItem.create({
      data: { id: randomUUID(), orderId: order.id, sourceContractLineId: line.id, productCategory: 'SUIT', sequenceNo: 1, displayName: '렌탈 정장' },
    });
    orderItemId = orderItem.id;
    const jacket = await ctx.prisma.orderItemComponent.create({
      data: { id: randomUUID(), orderItemId: orderItem.id, componentType: 'JACKET' },
    });
    jacketComponentId = jacket.id;

    // 후보가 될 AVAILABLE 실물 2건 (JACKET / NAVY / L)
    await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'JACKET', design: '렌탈클래식', color: 'NAVY', size: '100', managementCode: 'RJ-NV-L', quantity: 2 })
      .expect(201);
    // 다른 색은 후보에서 제외되어야 한다
    await api(ctx)
      .post('/api/v1/rental-inventory')
      .set(auth(ctx))
      .send({ componentType: 'JACKET', design: '렌탈클래식', color: 'BLACK', size: '100', managementCode: 'RJ-BK-L' })
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
      expect.arrayContaining(['90', '100', '110', '120']),
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
      .post(`/api/v1/order-items/${orderItemId}/rental-selection`)
      .set(auth(ctx))
      .expect(201);
    expect(res.body.data.status).toBe('IN_PROGRESS');
    expect(res.body.data.components).toHaveLength(1);
    expect(res.body.data.components[0].componentType).toBe('JACKET');
    sessionId = res.body.data.sessionId;
    sessionVersion = res.body.data.version;

    // 재호출 시 동일 현재 세션 반환
    const again = await api(ctx)
      .post(`/api/v1/order-items/${orderItemId}/rental-selection`)
      .set(auth(ctx))
      .expect(201);
    expect(again.body.data.sessionId).toBe(sessionId);
  });

  it('부위별 컬러·사이즈·비고를 저장하고 잘못된 코드는 거부한다', async () => {
    const res = await api(ctx)
      .put(`/api/v1/rental-selections/${sessionId}/lines/${jacketComponentId}`)
      .set(auth(ctx))
      .send({ colorCode: 'NAVY', sizeCode: '100', notes: '기장 -2cm', version: sessionVersion })
      .expect(200);
    const jacket = res.body.data.components.find(
      (c: { orderItemComponentId: string }) => c.orderItemComponentId === jacketComponentId,
    );
    expect(jacket).toMatchObject({ colorCode: 'NAVY', sizeCode: '100', notes: '기장 -2cm' });
    sessionVersion = res.body.data.version;

    await api(ctx)
      .put(`/api/v1/rental-selections/${sessionId}/lines/${jacketComponentId}`)
      .set(auth(ctx))
      .send({ colorCode: 'NOPE', version: sessionVersion })
      .expect(400);
  });

  it('후보 조회는 재고상태 AVAILABLE을 부위×컬러×사이즈로 필터한다', async () => {
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
      (c: { orderItemComponentId: string }) => c.orderItemComponentId === jacketComponentId,
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
    expect(rJacket).toMatchObject({ colorCode: 'NAVY', colorName: '네이비', sizeCode: '100' });
    expect(rJacket.selectedItem.managementCode).toBe(pick.managementCode);

    // 감사로그
    const audits = await ctx.prisma.auditLog.count({
      where: { entityType: 'RENTAL_SELECTION_SESSION', entityId: sessionId, action: 'CONFIRM' },
    });
    expect(audits).toBe(1);
  });

  it('CUSTOM 품목은 렌탈 선택 시작이 거부된다', async () => {
    const admin = await ctx.prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
    const customer = await ctx.prisma.customer.create({
      data: { id: randomUUID(), name: '맞춤고객', phone: '010-9100-0002', phoneNormalized: '01091000002' },
    });
    const contract = await ctx.prisma.contract.create({
      data: { id: randomUUID(), contractNo: 'CTR-260721-951', customerId: customer.id, status: 'CONFIRMED' },
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
    const item = await ctx.prisma.orderItem.create({
      data: { id: randomUUID(), orderId: order.id, sourceContractLineId: cl.id, productCategory: 'SUIT', sequenceNo: 1, displayName: '맞춤 정장' },
    });
    const res = await api(ctx)
      .post(`/api/v1/order-items/${item.id}/rental-selection`)
      .set(auth(ctx))
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
