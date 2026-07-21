import { randomUUID } from 'crypto';
import { MeasurementsModule } from '../../backend/src/modules/measurements/measurements.module';
import { api, auth, createTestContext, TestContext, truncateBusinessData } from './helpers';

describe('채촌(측정) 도메인 (Phase: measurements)', () => {
  let ctx: TestContext;
  let adminId: string;
  let customerId: string;
  let orderId: string;
  let orderItemId: string;

  // 세션 상태 (테스트 순서 의존)
  let sessionV1: string; // CHEST 98.0 / SLEEVE 61.0 / UPPER_SIZE 105
  let sessionV2: string; // CHEST 99.5 / SLEEVE 60.5 / UPPER_SIZE 106
  let emptySession: string;

  beforeAll(async () => {
    ctx = await createTestContext([MeasurementsModule]);
    await truncateBusinessData(ctx.prisma);

    const admin = await ctx.prisma.user.findUnique({ where: { loginId: 'admin' } });
    adminId = admin!.id;

    // 최소 업무 데이터: 고객 → 계약 → 계약버전 → 계약라인 → 주문 → 품목
    customerId = randomUUID();
    await ctx.prisma.customer.create({
      data: {
        id: customerId,
        name: '채촌 테스트 고객',
        phone: '010-9000-0001',
        phoneNormalized: '01090000001',
      },
    });
    const contractId = randomUUID();
    await ctx.prisma.contract.create({
      data: { id: contractId, contractNo: 'CTR-MEAS-001', customerId, status: 'CONFIRMED' },
    });
    const contractVersionId = randomUUID();
    await ctx.prisma.contractVersion.create({
      data: { id: contractVersionId, contractId, versionNo: 1, createdBy: adminId },
    });
    const contractLineId = randomUUID();
    await ctx.prisma.contractLine.create({
      data: {
        id: contractLineId,
        contractVersionId,
        transactionType: 'CUSTOM',
        productCategory: 'SUIT',
        quantity: 1,
      },
    });
    orderId = randomUUID();
    await ctx.prisma.order.create({
      data: { id: orderId, orderNo: 'ORD-MEAS-001', contractId, transactionType: 'CUSTOM' },
    });
    orderItemId = randomUUID();
    await ctx.prisma.orderItem.create({
      data: {
        id: orderItemId,
        orderId,
        sourceContractLineId: contractLineId,
        productCategory: 'SUIT',
        sequenceNo: 1,
        displayName: 'SUIT-01',
      },
    });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('신규 세션 생성 시 고객별 version_no가 자동 증가한다', async () => {
    const res1 = await api(ctx)
      .post(`/api/v1/customers/${customerId}/measurements`)
      .set(auth(ctx))
      .send({
        measurementDate: '2026-07-01',
        measurementType: 'INITIAL',
        relatedOrderId: orderId,
        bodyNotes: '어깨 왼쪽 처짐',
        values: [
          { measurementCode: 'CHEST', numericValue: 98.0 },
          { measurementCode: 'SLEEVE', numericValue: 61.0 },
          { measurementCode: 'UPPER_SIZE', textValue: '105' },
        ],
      })
      .expect(201);
    expect(res1.body.data.versionNo).toBe(1);
    expect(res1.body.data.completed).toBe(false);
    sessionV1 = res1.body.data.id;

    // 알려진 코드는 분류가 자동 보완된다
    const chest = res1.body.data.values.find((v: any) => v.measurementCode === 'CHEST');
    expect(chest.bodySection).toBe('UPPER');
    expect(chest.numericValue).toBe(98);
    expect(chest.unit).toBe('CM');

    const res2 = await api(ctx)
      .post(`/api/v1/customers/${customerId}/measurements`)
      .set(auth(ctx))
      .send({
        measurementDate: '2026-07-10',
        measurementType: 'FITTING',
        bodyNotes: '가봉 후 보정',
        values: [
          { measurementCode: 'CHEST', numericValue: 99.5 },
          { measurementCode: 'SLEEVE', numericValue: 60.5 },
          { measurementCode: 'UPPER_SIZE', textValue: '106' },
        ],
      })
      .expect(201);
    expect(res2.body.data.versionNo).toBe(2);
    sessionV2 = res2.body.data.id;
  });

  it('값은 numeric/text 중 하나가 반드시 필요하다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/customers/${customerId}/measurements`)
      .set(auth(ctx))
      .send({
        measurementDate: '2026-07-11',
        values: [{ measurementCode: 'WAIST' }],
      })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.fieldErrors[0].reason).toBe('VALUE_REQUIRED');
  });

  it('채촌 이력 목록은 최신 버전 순으로 담당자·연결 품목 수를 보여준다', async () => {
    const res = await api(ctx)
      .get(`/api/v1/customers/${customerId}/measurements`)
      .set(auth(ctx))
      .expect(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].versionNo).toBe(2);
    expect(res.body.data[1].versionNo).toBe(1);
    expect(res.body.data[0].measurementDate).toBe('2026-07-10');
    expect(res.body.data[0].createdBy.displayName).toBeDefined();
    expect(res.body.data[0].linkedOrderItemCount).toBe(0);
  });

  it('임시 저장(PATCH)은 값을 UPSERT한다 (기존 수정 + 신규 추가)', async () => {
    const res = await api(ctx)
      .patch(`/api/v1/measurements/${sessionV2}`)
      .set(auth(ctx))
      .send({
        fitPreference: '슬림',
        values: [
          { measurementCode: 'SLEEVE', numericValue: 60.5 }, // 기존 upsert
          { measurementCode: 'WAIST', numericValue: 84.0 }, // 신규
        ],
      })
      .expect(200);
    expect(res.body.data.fitPreference).toBe('슬림');
    const codes = res.body.data.values.map((v: any) => v.measurementCode);
    expect(codes).toEqual(expect.arrayContaining(['CHEST', 'SLEEVE', 'UPPER_SIZE', 'WAIST']));
    expect(res.body.data.values).toHaveLength(4);
    const waist = res.body.data.values.find((v: any) => v.measurementCode === 'WAIST');
    expect(waist.bodySection).toBe('LOWER');
    expect(waist.numericValue).toBe(84);
  });

  it('버전 비교는 숫자만 차이를 계산하고 문자값은 변경 여부만 표시한다', async () => {
    const res = await api(ctx)
      .get('/api/v1/measurements/compare')
      .query({ left: sessionV1, right: sessionV2 })
      .set(auth(ctx))
      .expect(200);

    const items = res.body.data.items;
    const chest = items.find((i: any) => i.measurementCode === 'CHEST');
    expect(chest.previous.numericValue).toBe(98);
    expect(chest.current.numericValue).toBe(99.5);
    expect(chest.diff).toBe(1.5); // +1.5
    expect(chest.changed).toBe(true);

    const sleeve = items.find((i: any) => i.measurementCode === 'SLEEVE');
    expect(sleeve.diff).toBe(-0.5); // -0.5

    const upperSize = items.find((i: any) => i.measurementCode === 'UPPER_SIZE');
    expect(upperSize.diff).toBeNull();
    expect(upperSize.changed).toBe(true);

    // 한쪽에만 있는 항목(WAIST)은 차이를 계산하지 않는다
    const waist = items.find((i: any) => i.measurementCode === 'WAIST');
    expect(waist.previous.numericValue).toBeNull();
    expect(waist.diff).toBeNull();

    // 좌우 세션의 체형 메모 병기
    expect(res.body.data.left.bodyNotes).toBe('어깨 왼쪽 처짐');
    expect(res.body.data.right.bodyNotes).toBe('가봉 후 보정');
  });

  it('완료 전 세션은 품목에 연결할 수 없다', async () => {
    const res = await api(ctx)
      .put(`/api/v1/order-items/${orderItemId}/measurement`)
      .set(auth(ctx))
      .send({ measurementSessionId: sessionV1 })
      .expect(422);
    expect(res.body.error.code).toBe('MEASUREMENT_NOT_COMPLETE');
  });

  it('완료 처리는 값 1개 이상을 요구하고 audit COMPLETE를 기록한다', async () => {
    // 값 없는 세션은 완료 불가
    const empty = await api(ctx)
      .post(`/api/v1/customers/${customerId}/measurements`)
      .set(auth(ctx))
      .send({ measurementDate: '2026-07-12', measurementType: 'OTHER' })
      .expect(201);
    emptySession = empty.body.data.id;
    const fail = await api(ctx)
      .post(`/api/v1/measurements/${emptySession}/complete`)
      .set(auth(ctx))
      .expect(422);
    expect(fail.body.error.code).toBe('MEASUREMENT_NOT_COMPLETE');

    // 값 있는 세션은 완료 성공 — completed_at 컬럼에 기록된다
    const ok = await api(ctx)
      .post(`/api/v1/measurements/${sessionV1}/complete`)
      .set(auth(ctx))
      .expect(201);
    expect(ok.body.data.completed).toBe(true);
    expect(ok.body.data.completedAt).toBeTruthy();
    const row = await ctx.prisma.measurementSession.findUniqueOrThrow({ where: { id: sessionV1 } });
    expect(row.completedAt).not.toBeNull();
    await api(ctx).post(`/api/v1/measurements/${sessionV2}/complete`).set(auth(ctx)).expect(201);

    // 감사로그는 이력용으로 계속 기록된다 (완료 판정 기준은 컬럼)
    const audits = await ctx.prisma.auditLog.findMany({
      where: { entityType: 'MEASUREMENT_SESSION', action: 'COMPLETE', entityId: sessionV1 },
    });
    expect(audits).toHaveLength(1);

    // 중복 완료 차단
    const dup = await api(ctx)
      .post(`/api/v1/measurements/${sessionV1}/complete`)
      .set(auth(ctx))
      .expect(409);
    expect(dup.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('완료된 세션도 작업지시서 출력 전이면 수정할 수 있다 (설계서 09 §2.1)', async () => {
    await api(ctx)
      .patch(`/api/v1/measurements/${sessionV1}`)
      .set(auth(ctx))
      .send({ values: [{ measurementCode: 'CHEST', numericValue: 100 }] })
      .expect(200);

    const detail = await api(ctx).get(`/api/v1/measurements/${sessionV1}`).set(auth(ctx)).expect(200);
    const chest = detail.body.data.values.find((v: any) => v.measurementCode === 'CHEST');
    expect(chest.numericValue).toBe(100);
    expect(detail.body.data.completed).toBe(true);
    expect(detail.body.data.completedAt).toBeTruthy();
    expect(detail.body.data.locked).toBe(false);
    expect(detail.body.data.customerName).toBe('채촌 테스트 고객');

    // 감사로그에 "완료 후 수정" 사유가 남는다
    const audit = await ctx.prisma.auditLog.findFirst({
      where: { entityType: 'MEASUREMENT_SESSION', action: 'UPDATE', entityId: sessionV1 },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.reason).toBe('완료 후 수정');

    // 원래 값으로 되돌려 이후 테스트(비교·복사)의 기대값을 유지한다
    await api(ctx)
      .patch(`/api/v1/measurements/${sessionV1}`)
      .set(auth(ctx))
      .send({ values: [{ measurementCode: 'CHEST', numericValue: 98 }] })
      .expect(200);
  });

  it('값을 비워 보내면 해당 항목이 삭제된다', async () => {
    const target = await api(ctx)
      .post('/api/v1/measurements')
      .set(auth(ctx))
      .send({
        customerId,
        measurementDate: '2026-07-13',
        values: [
          { measurementCode: 'CHEST', numericValue: 90 },
          { measurementCode: 'WAIST', numericValue: 80 },
        ],
      })
      .expect(201);

    const updated = await api(ctx)
      .patch(`/api/v1/measurements/${target.body.data.id}`)
      .set(auth(ctx))
      .send({ values: [{ measurementCode: 'WAIST' }] })
      .expect(200);
    const codes = updated.body.data.values.map((v: any) => v.measurementCode);
    expect(codes).toEqual(['CHEST']);

    // 정리
    await api(ctx).delete(`/api/v1/measurements/${target.body.data.id}`).set(auth(ctx)).expect(200);
  });

  it('완료 해제 후 다시 완료할 수 있다', async () => {
    const reopened = await api(ctx)
      .post(`/api/v1/measurements/${sessionV2}/reopen`)
      .set(auth(ctx))
      .expect(201);
    expect(reopened.body.data.completed).toBe(false);

    await api(ctx).post(`/api/v1/measurements/${sessionV2}/complete`).set(auth(ctx)).expect(201);
  });

  it('clone은 새 날짜·구분으로 값을 복사하고 previous_session_id를 연결한다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/measurements/${sessionV1}/clone`)
      .set(auth(ctx))
      .send({ measurementDate: '2026-07-20', measurementType: 'REMEASURE' })
      .expect(201);
    const cloned = res.body.data;
    expect(cloned.versionNo).toBe(4); // v3 = 빈 세션 다음
    expect(cloned.previousSessionId).toBe(sessionV1);
    expect(cloned.measurementDate).toBe('2026-07-20');
    expect(cloned.measurementType).toBe('REMEASURE');
    expect(cloned.completed).toBe(false);
    expect(cloned.values).toHaveLength(3);
    const chest = cloned.values.find((v: any) => v.measurementCode === 'CHEST');
    expect(chest.numericValue).toBe(98);
    const size = cloned.values.find((v: any) => v.measurementCode === 'UPPER_SIZE');
    expect(size.textValue).toBe('105');
    // 복사본은 완료 전이므로 편집 가능
    await api(ctx)
      .patch(`/api/v1/measurements/${cloned.id}`)
      .set(auth(ctx))
      .send({ values: [{ measurementCode: 'CHEST', numericValue: 98.5 }] })
      .expect(200);
  });

  it('품목 연결은 is_current=true를 품목당 1개만 보장한다 (재연결 시 이전 해제)', async () => {
    // 1차 연결: sessionV1
    const first = await api(ctx)
      .put(`/api/v1/order-items/${orderItemId}/measurement`)
      .set(auth(ctx))
      .send({ measurementSessionId: sessionV1 })
      .expect(200);
    expect(first.body.data.isCurrent).toBe(true);
    expect(first.body.data.measurementSessionId).toBe(sessionV1);

    // 2차 재연결: sessionV2 → 기존 current 해제
    const second = await api(ctx)
      .put(`/api/v1/order-items/${orderItemId}/measurement`)
      .set(auth(ctx))
      .send({ measurementSessionId: sessionV2 })
      .expect(200);
    expect(second.body.data.isCurrent).toBe(true);

    const links = await ctx.prisma.orderItemMeasurement.findMany({ where: { orderItemId } });
    expect(links).toHaveLength(2);
    const current = links.filter((l) => l.isCurrent);
    expect(current).toHaveLength(1);
    expect(current[0].measurementSessionId).toBe(sessionV2);

    // 같은 세션으로 다시 연결해도 current는 1개 유지 (upsert)
    await api(ctx)
      .put(`/api/v1/order-items/${orderItemId}/measurement`)
      .set(auth(ctx))
      .send({ measurementSessionId: sessionV1 })
      .expect(200);
    const relinked = await ctx.prisma.orderItemMeasurement.findMany({ where: { orderItemId } });
    expect(relinked).toHaveLength(2); // 새 행이 아닌 기존 행 재사용
    expect(relinked.filter((l) => l.isCurrent)).toHaveLength(1);

    // 목록에 연결 품목 수 반영
    const list = await api(ctx)
      .get(`/api/v1/customers/${customerId}/measurements`)
      .set(auth(ctx))
      .expect(200);
    const v1Row = list.body.data.find((s: any) => s.id === sessionV1);
    expect(v1Row.linkedOrderItemCount).toBe(1);
    expect(v1Row.linkedOrderItems[0].displayName).toBe('SUIT-01');
    expect(v1Row.completed).toBe(true);
    expect(v1Row.completedAt).toBeTruthy();

    // 감사로그 LINK 기록
    const audits = await ctx.prisma.auditLog.findMany({
      where: { entityType: 'ORDER_ITEM_MEASUREMENT', action: 'LINK' },
    });
    expect(audits.length).toBeGreaterThanOrEqual(3);
  });

  it('다른 고객의 채촌 세션은 품목에 연결할 수 없다', async () => {
    const otherCustomerId = randomUUID();
    await ctx.prisma.customer.create({
      data: {
        id: otherCustomerId,
        name: '다른 고객',
        phone: '010-9000-0002',
        phoneNormalized: '01090000002',
      },
    });
    const other = await api(ctx)
      .post(`/api/v1/customers/${otherCustomerId}/measurements`)
      .set(auth(ctx))
      .send({
        measurementDate: '2026-07-15',
        values: [{ measurementCode: 'CHEST', numericValue: 90 }],
      })
      .expect(201);
    expect(other.body.data.versionNo).toBe(1); // 버전은 고객별로 독립
    await api(ctx).post(`/api/v1/measurements/${other.body.data.id}/complete`).set(auth(ctx)).expect(201);

    const res = await api(ctx)
      .put(`/api/v1/order-items/${orderItemId}/measurement`)
      .set(auth(ctx))
      .send({ measurementSessionId: other.body.data.id })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('전역 검색은 고객명·전화·기간·구분·상태로 필터한다 (MEAS-001)', async () => {
    const all = await api(ctx).get('/api/v1/measurements').set(auth(ctx)).expect(200);
    // 두 고객의 기록이 모두 보인다 (고객을 고르지 않아도 조회된다)
    const customerIds: string[] = all.body.data.map((r: any) => r.customerId);
    expect(new Set(customerIds).size).toBeGreaterThanOrEqual(2);
    expect(all.body.data[0].customerName).toBeDefined();
    expect(all.body.page.totalElements).toBe(all.body.data.length);
    // 최신 채촌일 순
    const dates: string[] = all.body.data.map((r: any) => r.measurementDate);
    expect([...dates].sort().reverse()).toEqual(dates);

    const byName = await api(ctx)
      .get('/api/v1/measurements')
      .query({ q: '다른 고객' })
      .set(auth(ctx))
      .expect(200);
    expect(byName.body.data).toHaveLength(1);
    expect(byName.body.data[0].customerName).toBe('다른 고객');

    const byPhone = await api(ctx)
      .get('/api/v1/measurements')
      .query({ q: '9000-0002' })
      .set(auth(ctx))
      .expect(200);
    expect(byPhone.body.data).toHaveLength(1);

    const byRange = await api(ctx)
      .get('/api/v1/measurements')
      .query({ customerId, dateFrom: '2026-07-10', dateTo: '2026-07-12' })
      .set(auth(ctx))
      .expect(200);
    expect(byRange.body.data.every((r: any) => r.measurementDate >= '2026-07-10')).toBe(true);
    expect(byRange.body.data.every((r: any) => r.measurementDate <= '2026-07-12')).toBe(true);

    const drafts = await api(ctx)
      .get('/api/v1/measurements')
      .query({ customerId, status: 'DRAFT' })
      .set(auth(ctx))
      .expect(200);
    expect(drafts.body.data.every((r: any) => r.completed === false)).toBe(true);

    const remeasure = await api(ctx)
      .get('/api/v1/measurements')
      .query({ type: 'REMEASURE' })
      .set(auth(ctx))
      .expect(200);
    expect(remeasure.body.data.every((r: any) => r.measurementType === 'REMEASURE')).toBe(true);
  });

  it('삭제는 값·품목 연결을 함께 정리하고 감사로그를 남긴다', async () => {
    const created = await api(ctx)
      .post('/api/v1/measurements')
      .set(auth(ctx))
      .send({
        customerId,
        measurementDate: '2026-07-16',
        values: [{ measurementCode: 'CHEST', numericValue: 95 }],
      })
      .expect(201);
    const targetId = created.body.data.id;

    await api(ctx).delete(`/api/v1/measurements/${targetId}`).set(auth(ctx)).expect(200);

    expect(await ctx.prisma.measurementSession.findUnique({ where: { id: targetId } })).toBeNull();
    expect(
      await ctx.prisma.measurementValue.count({ where: { measurementSessionId: targetId } }),
    ).toBe(0);
    const audit = await ctx.prisma.auditLog.findFirst({
      where: { entityType: 'MEASUREMENT_SESSION', action: 'DELETE', entityId: targetId },
    });
    expect(audit).not.toBeNull();

    await api(ctx).get(`/api/v1/measurements/${targetId}`).set(auth(ctx)).expect(404);
  });

  it('작업지시서 출력에 쓰인 채촌은 수정·삭제·완료해제가 잠긴다', async () => {
    // sessionV2는 orderItemId에 연결되어 있다. 그 상태로 작업지시서 버전을 만든다.
    const optionSet = await ctx.prisma.optionSet.findFirstOrThrow();
    const optionSetVersion = await ctx.prisma.optionSetVersion.create({
      data: {
        id: randomUUID(),
        optionSetId: optionSet.id,
        versionNo: 1,
        status: 'ACTIVE',
        createdBy: adminId,
      },
    });
    const optionSession = await ctx.prisma.optionSelectionSession.create({
      data: {
        id: randomUUID(),
        orderItemId,
        optionSetVersionId: optionSetVersion.id,
        selectionVersionNo: 1,
        status: 'CONFIRMED',
      },
    });
    const file = await ctx.prisma.file.create({
      data: {
        id: randomUUID(),
        storageKey: `work-orders/${randomUUID()}.xlsx`,
        originalName: 'wo.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sizeBytes: BigInt(1024),
      },
    });
    const workOrder = await ctx.prisma.workOrder.create({
      data: { id: randomUUID(), orderItemId },
    });
    await ctx.prisma.workOrderVersion.create({
      data: {
        id: randomUUID(),
        workOrderId: workOrder.id,
        versionNo: 1,
        sourceOptionSessionId: optionSession.id,
        sourceMeasurementSessionId: sessionV2,
        optionSnapshot: {},
        measurementSnapshot: {},
        sourceHash: 'hash-lock-test',
        outputFileId: file.id,
        issuedBy: adminId,
        issuedAt: new Date(),
      },
    });

    const patch = await api(ctx)
      .patch(`/api/v1/measurements/${sessionV2}`)
      .set(auth(ctx))
      .send({ values: [{ measurementCode: 'CHEST', numericValue: 111 }] })
      .expect(409);
    expect(patch.body.error.code).toBe('MEASUREMENT_LOCKED');

    const del = await api(ctx).delete(`/api/v1/measurements/${sessionV2}`).set(auth(ctx)).expect(409);
    expect(del.body.error.code).toBe('MEASUREMENT_LOCKED');

    const reopen = await api(ctx)
      .post(`/api/v1/measurements/${sessionV2}/reopen`)
      .set(auth(ctx))
      .expect(409);
    expect(reopen.body.error.code).toBe('MEASUREMENT_LOCKED');

    const detail = await api(ctx).get(`/api/v1/measurements/${sessionV2}`).set(auth(ctx)).expect(200);
    expect(detail.body.data.locked).toBe(true);
    expect(detail.body.data.workOrderVersionCount).toBe(1);
  });

  it('인증 없이 접근하면 401을 반환한다', async () => {
    await api(ctx).get(`/api/v1/customers/${customerId}/measurements`).expect(401);
    await api(ctx).get('/api/v1/measurements').expect(401);
  });
});
