import { randomUUID } from 'crypto';
import { DashboardModule } from '../../backend/src/modules/dashboard/dashboard.module';
import { api, auth, createTestContext, TestContext, truncateBusinessData } from './helpers';

/** 로컬 달력 기준 오늘±offset 일자를 UTC 자정 Date로 만든다 (@db.Date 컬럼용). */
function dbDate(offsetDays: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

interface TaskRow {
  taskId: string;
  taskType: string;
  entityId: string;
  acknowledged: boolean;
  orderNo?: string;
  customerName?: string;
}

describe('대시보드 (dashboard)', () => {
  let ctx: TestContext;
  let adminId: string;
  let customerId: string;
  let contractId: string;
  let orderItemId: string;
  let optionSessionId: string;
  let measurementSessionId: string;
  let componentId: string;
  let allocationId: string;
  let workOrderId: string;
  let outputFileId: string;

  const getTasks = async (type: string): Promise<TaskRow[]> => {
    const res = await api(ctx).get(`/api/v1/dashboard/tasks?type=${type}`).set(auth(ctx)).expect(200);
    return res.body.data as TaskRow[];
  };

  beforeAll(async () => {
    ctx = await createTestContext([DashboardModule]);
    await truncateBusinessData(ctx.prisma);

    const admin = await ctx.prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
    adminId = admin.id;

    customerId = randomUUID();
    await ctx.prisma.customer.create({
      data: { id: customerId, name: '홍길동', phone: '010-1111-2222', phoneNormalized: '01011112222' },
    });

    contractId = randomUUID();
    await ctx.prisma.contract.create({
      data: {
        id: contractId,
        contractNo: 'CTR-260701-001',
        customerId,
        status: 'CONFIRMED',
        balanceDueDate: dbDate(-1), // 잔금 결제 예정일 경과 → 결제 지연 판정 (연동정합화 §4·§10)
      },
    });
    const versionId = randomUUID();
    await ctx.prisma.contractVersion.create({
      data: {
        id: versionId,
        contractId,
        versionNo: 1,
        versionStatus: 'CONFIRMED',
        totalAmount: 1_000_000,
        completionDueDate: dbDate(-1), // 완료 예정일 경과 → 결제 지연 대체 판정
        createdBy: adminId,
      },
    });
    await ctx.prisma.contract.update({ where: { id: contractId }, data: { currentVersionId: versionId } });

    const orderId = randomUUID();
    await ctx.prisma.order.create({
      data: { id: orderId, orderNo: 'ORD-260701-001', contractId, transactionType: 'CUSTOM', status: 'CREATED' },
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
    orderItemId = randomUUID();
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

    // 옵션 세션 CONFIRMED (시드 옵션 세트 SUIT 사용)
    const optionSet = await ctx.prisma.optionSet.findUniqueOrThrow({ where: { productCategory: 'SUIT' } });
    const optionSetVersionId = randomUUID();
    await ctx.prisma.optionSetVersion.create({
      data: { id: optionSetVersionId, optionSetId: optionSet.id, versionNo: 1, status: 'ACTIVE', createdBy: adminId },
    });
    optionSessionId = randomUUID();
    await ctx.prisma.optionSelectionSession.create({
      data: {
        id: optionSessionId,
        orderItemId,
        optionSetVersionId,
        selectionVersionNo: 1,
        status: 'CONFIRMED',
        confirmedAt: new Date(Date.now() - 60 * 60 * 1000),
        isCurrent: true,
      },
    });

    // 현재 채촌 연결
    measurementSessionId = randomUUID();
    await ctx.prisma.measurementSession.create({
      data: {
        id: measurementSessionId,
        customerId,
        versionNo: 1,
        measurementDate: dbDate(0),
        createdBy: adminId,
      },
    });
    await ctx.prisma.orderItemMeasurement.create({
      data: {
        id: randomUUID(),
        orderItemId,
        measurementSessionId,
        isCurrent: true,
        linkedBy: adminId,
        linkedAt: new Date(Date.now() - 30 * 60 * 1000),
      },
    });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('UNORDERED: 옵션 확정 + 채촌 연결 + 작업지시서 0건이면 목록에 포함된다', async () => {
    const tasks = await getTasks('UNORDERED');
    const row = tasks.find((t) => t.taskId === `unordered:${orderItemId}`);
    expect(row).toBeDefined();
    expect(row?.acknowledged).toBe(false);
    expect(row?.orderNo).toBe('ORD-260701-001');
    expect(row?.customerName).toBe('홍길동');
  });

  it('acknowledge: dashboard_task_actions에 저장되고 acknowledged=true가 된다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/dashboard/tasks/unordered:${orderItemId}/acknowledge`)
      .set(auth(ctx))
      .send({ memo: '공장 발주 예정 확인' })
      .expect(201);
    expect(res.body.data.status).toBe('ACKNOWLEDGED');

    const actions = await ctx.prisma.dashboardTaskAction.findMany({
      where: { taskType: 'UNORDERED', entityId: orderItemId },
    });
    expect(actions).toHaveLength(1);
    expect(actions[0].memo).toBe('공장 발주 예정 확인');
    expect(actions[0].entityType).toBe('ORDER_ITEM');

    const tasks = await getTasks('UNORDERED');
    expect(tasks.find((t) => t.entityId === orderItemId)?.acknowledged).toBe(true);
  });

  it('잘못된 taskId 형식은 VALIDATION_ERROR를 반환한다', async () => {
    const res = await api(ctx)
      .post('/api/v1/dashboard/tasks/bogus-task-id/acknowledge')
      .set(auth(ctx))
      .send({})
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('UNORDERED 해소: 첫 작업지시서 출력 후 목록에서 제외된다', async () => {
    outputFileId = randomUUID();
    await ctx.prisma.file.create({
      data: {
        id: outputFileId,
        storageKey: `test/${outputFileId}.xlsx`,
        originalName: 'work-order.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sizeBytes: 1024,
      },
    });
    workOrderId = randomUUID();
    await ctx.prisma.workOrder.create({ data: { id: workOrderId, orderItemId } });
    await ctx.prisma.workOrderVersion.create({
      data: {
        id: randomUUID(),
        workOrderId,
        versionNo: 1,
        sourceOptionSessionId: optionSessionId,
        sourceMeasurementSessionId: measurementSessionId,
        optionSnapshot: {},
        measurementSnapshot: {},
        sourceHash: 'hash-v1',
        outputFileId,
        status: 'ISSUED',
        issuedBy: adminId,
        issuedAt: new Date(),
      },
    });

    const tasks = await getTasks('UNORDERED');
    expect(tasks.find((t) => t.entityId === orderItemId)).toBeUndefined();
  });

  it('REPRINT_NEEDED: 출력 이후 옵션 재확정 시 포함되고 신규 버전 출력 시 제외된다', async () => {
    // 출력 직후에는 재출력 대상이 아니다
    let tasks = await getTasks('REPRINT_NEEDED');
    expect(tasks.find((t) => t.entityId === orderItemId)).toBeUndefined();

    // 옵션 확정 시각이 마지막 출력보다 이후가 되도록 변경
    await ctx.prisma.optionSelectionSession.update({
      where: { id: optionSessionId },
      data: { confirmedAt: new Date(Date.now() + 60_000) },
    });
    tasks = await getTasks('REPRINT_NEEDED');
    const row = tasks.find((t) => t.taskId === `reprint_needed:${orderItemId}`);
    expect(row).toBeDefined();

    // 최신 원본으로 신규 버전을 출력하면 해소된다
    await ctx.prisma.workOrderVersion.create({
      data: {
        id: randomUUID(),
        workOrderId,
        versionNo: 2,
        sourceOptionSessionId: optionSessionId,
        sourceMeasurementSessionId: measurementSessionId,
        optionSnapshot: {},
        measurementSnapshot: {},
        sourceHash: 'hash-v2',
        outputFileId,
        status: 'ISSUED',
        issuedBy: adminId,
        issuedAt: new Date(Date.now() + 120_000),
      },
    });
    tasks = await getTasks('REPRINT_NEEDED');
    expect(tasks.find((t) => t.entityId === orderItemId)).toBeUndefined();
  });

  it('LATE_RETURN: 반납 예정일 경과 미반납 배정이 포함되고 반납 처리 시 제외된다', async () => {
    componentId = randomUUID();
    await ctx.prisma.orderItemComponent.create({
      data: {
        id: componentId,
        orderItemId,
        componentType: 'JACKET',
        sequenceNo: 1,
        status: 'CREATED',
        expectedInboundDate: dbDate(-2), // 입고 지연 테스트에서 함께 사용
      },
    });
    const skuId = randomUUID();
    await ctx.prisma.rentalSku.create({
      data: { id: skuId, componentType: 'JACKET', design: 'A라인', color: 'BLACK', size: '100' },
    });
    const inventoryItemId = randomUUID();
    await ctx.prisma.rentalInventoryItem.create({
      data: { id: inventoryItemId, managementCode: 'JK-BLACK-100-01', rentalSkuId: skuId, status: 'RENTED' },
    });
    allocationId = randomUUID();
    await ctx.prisma.rentalAllocation.create({
      data: {
        id: allocationId,
        orderItemComponentId: componentId,
        rentalInventoryItemId: inventoryItemId,
        pickupDate: dbDate(-10),
        returnDueDate: dbDate(-1),
        availabilityEndDate: dbDate(0),
        actualPickupAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        status: 'PICKED_UP',
        assignedBy: adminId,
        assignedAt: new Date(),
      },
    });

    let tasks = await getTasks('LATE_RETURN');
    const row = tasks.find((t) => t.taskId === `late_return:${allocationId}`);
    expect(row).toBeDefined();
    expect(row?.acknowledged).toBe(false);

    // 반납 처리 → 해소
    await ctx.prisma.rentalAllocation.update({
      where: { id: allocationId },
      data: { actualReturnAt: new Date(), status: 'RETURNED' },
    });
    tasks = await getTasks('LATE_RETURN');
    expect(tasks.find((t) => t.entityId === allocationId)).toBeUndefined();
  });

  it('INBOUND_DELAY: 입고 예정일 경과 미입고 구성품이 포함되고 입고 시 제외된다', async () => {
    let tasks = await getTasks('INBOUND_DELAY');
    expect(tasks.find((t) => t.entityId === componentId)).toBeDefined();

    await ctx.prisma.orderItemComponent.update({
      where: { id: componentId },
      data: { actualInboundAt: new Date(), status: 'INBOUND' },
    });
    tasks = await getTasks('INBOUND_DELAY');
    expect(tasks.find((t) => t.entityId === componentId)).toBeUndefined();
  });

  it('PAYMENT_DELAY: balance_due_date 경과 + 미수 잔액>0이면 포함되고, 예정일 없으면 제외·완납 시 제외된다', async () => {
    let tasks = await getTasks('PAYMENT_DELAY');
    expect(tasks.find((t) => t.entityId === contractId)).toBeDefined();

    // 잔금 결제 예정일이 없으면 판정에서 제외한다 (연동정합화 §4)
    await ctx.prisma.contract.update({ where: { id: contractId }, data: { balanceDueDate: null } });
    tasks = await getTasks('PAYMENT_DELAY');
    expect(tasks.find((t) => t.entityId === contractId)).toBeUndefined();
    await ctx.prisma.contract.update({ where: { id: contractId }, data: { balanceDueDate: dbDate(-1) } });
    tasks = await getTasks('PAYMENT_DELAY');
    expect(tasks.find((t) => t.entityId === contractId)).toBeDefined();

    await ctx.prisma.payment.create({
      data: {
        id: randomUUID(),
        contractId,
        paymentType: 'BALANCE',
        amount: 1_000_000,
        paymentDate: dbDate(0),
        status: 'COMPLETED',
        createdBy: adminId,
      },
    });
    tasks = await getTasks('PAYMENT_DELAY');
    expect(tasks.find((t) => t.entityId === contractId)).toBeUndefined();
  });

  it('summary: { date, appointments(평면 뷰), week(오늘±3일), taskCounts }를 반환한다 (연동정합화 §10)', async () => {
    const purpose = await ctx.prisma.appointmentPurpose.findFirstOrThrow();
    await ctx.prisma.appointment.create({
      data: {
        id: randomUUID(),
        customerId,
        source: 'CRM',
        purposeId: purpose.id,
        scheduledStart: new Date(),
        status: 'RESERVED',
      },
    });
    // 취소 예약과 범위 밖(+5일) 예약은 집계에서 제외된다
    await ctx.prisma.appointment.create({
      data: {
        id: randomUUID(),
        customerId,
        source: 'CRM',
        purposeId: purpose.id,
        scheduledStart: new Date(),
        status: 'CANCELLED',
      },
    });
    await ctx.prisma.appointment.create({
      data: {
        id: randomUUID(),
        customerId,
        source: 'CRM',
        purposeId: purpose.id,
        scheduledStart: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        status: 'RESERVED',
      },
    });

    const res = await api(ctx).get('/api/v1/dashboard/summary').set(auth(ctx)).expect(200);
    const data = res.body.data;
    expect(data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // 오늘 예약: 예약 평면 뷰 (연동정합화 §1)
    expect(data.appointments).toHaveLength(1);
    expect(data.appointments[0]).toMatchObject({
      customerName: '홍길동',
      status: 'RESERVED',
      syncStatus: 'NORMAL',
    });
    expect(data.appointments[0].startAt).toBeDefined();
    expect(data.appointments[0].purposeCode).toBeDefined();

    // 주간: 오늘±3일 7개 [{date, count}]
    expect(data.week).toHaveLength(7);
    expect(data.week.map((w: { date: string }) => w.date)).toContain(data.date);
    const today = data.week.find((w: { date: string }) => w.date === data.date);
    expect(today.count).toBe(1);
    expect(data.week.reduce((sum: number, w: { count: number }) => sum + w.count, 0)).toBe(1);

    expect(Object.keys(data.taskCounts).sort()).toEqual(
      ['INBOUND_DELAY', 'LATE_RETURN', 'PAYMENT_DELAY', 'REPRINT_NEEDED', 'UNORDERED'].sort(),
    );
    // 앞선 테스트에서 모든 판정이 해소된 상태
    expect(data.taskCounts.UNORDERED).toBe(0);
    expect(data.taskCounts.LATE_RETURN).toBe(0);
  });

  it('공유 메모: 작성·수정·소프트 삭제와 감사로그를 지원한다', async () => {
    const created = await api(ctx)
      .post('/api/v1/shared-memos')
      .set(auth(ctx))
      .send({ content: '금일 반납 2건 인수인계 부탁드립니다.' })
      .expect(201);
    const memoId = created.body.data.id;
    expect(created.body.data.author.displayName).toBeDefined();

    let list = await api(ctx).get('/api/v1/shared-memos').set(auth(ctx)).expect(200);
    expect(list.body.data.some((m: { id: string }) => m.id === memoId)).toBe(true);

    const updated = await api(ctx)
      .patch(`/api/v1/shared-memos/${memoId}`)
      .set(auth(ctx))
      .send({ content: '반납 2건 완료 처리했습니다.', status: 'COMPLETED' })
      .expect(200);
    expect(updated.body.data.status).toBe('COMPLETED');

    await api(ctx).delete(`/api/v1/shared-memos/${memoId}`).set(auth(ctx)).expect(200);
    list = await api(ctx).get('/api/v1/shared-memos').set(auth(ctx)).expect(200);
    expect(list.body.data.some((m: { id: string }) => m.id === memoId)).toBe(false);

    // 소프트 삭제: 레코드는 보존된다
    const memo = await ctx.prisma.sharedNote.findUniqueOrThrow({ where: { id: memoId } });
    expect(memo.status).toBe('DELETED');
    expect(memo.deletedAt).not.toBeNull();

    const actions = await ctx.prisma.auditLog.findMany({
      where: { entityType: 'SHARED_NOTE', entityId: memoId },
      orderBy: { createdAt: 'asc' },
    });
    expect(actions.map((a) => a.action)).toEqual(['CREATE', 'UPDATE', 'DELETE']);
  });

  it('지원하지 않는 type 쿼리는 VALIDATION_ERROR를 반환한다', async () => {
    const res = await api(ctx).get('/api/v1/dashboard/tasks?type=BOGUS').set(auth(ctx)).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
