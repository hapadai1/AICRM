import { randomUUID } from 'crypto';
import { OptionsModule } from '../../backend/src/modules/options/options.module';
import { api, auth, createTestContext, TestContext, truncateBusinessData } from './helpers';

interface StageView {
  stageId: string;
  stageCode: string;
  sequenceNo: number;
  choices: Array<{ id: string; choiceCode: string; choiceName: string; imageFileId: string }>;
  selectedChoiceId: string | null;
}

describe('옵션 마스터·선택 세션 (Phase 3)', () => {
  let ctx: TestContext;
  let optionSetId: string;
  let orderItem1: string;
  let orderItem2: string;
  let orderItem4: string; // 세션 없는 신규 품목 (진행 목록·fabric 테스트용)

  // 마스터 흐름에서 채워지는 상태
  let versionV1: string;
  let versionV2: string;
  // 세션 흐름에서 채워지는 상태
  let sessionId: string;
  let sessionVersion = 0; // row_version 추적
  let stages: StageView[] = [];
  let confirmedSessionId: string;

  const stagesPayload = {
    stages: [1, 2, 3].map((n) => ({
      stageCode: `STAGE_${n}`,
      stageName: `단계 ${n}`,
      sequenceNo: n,
      required: true,
      choices: [
        { choiceCode: 'A', choiceName: `${n}-A 옵션`, factoryLabel: `F${n}A` },
        { choiceCode: 'B', choiceName: `${n}-B 옵션` },
      ],
    })),
  };

  beforeAll(async () => {
    ctx = await createTestContext([OptionsModule]);
    await truncateBusinessData(ctx.prisma);

    // 테스트 업무 데이터: customer → contract(version/line) → order → order_items(SUIT x2)
    const admin = await ctx.prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
    const customerId = randomUUID();
    await ctx.prisma.customer.create({
      data: {
        id: customerId,
        name: '옵션 테스트 고객',
        phone: '010-9999-0001',
        phoneNormalized: '01099990001',
      },
    });
    const contractId = randomUUID();
    await ctx.prisma.contract.create({
      data: { id: contractId, contractNo: 'CTR-OPT-001', customerId, status: 'CONFIRMED' },
    });
    const contractVersionId = randomUUID();
    await ctx.prisma.contractVersion.create({
      data: {
        id: contractVersionId,
        contractId,
        versionNo: 1,
        versionStatus: 'CONFIRMED',
        createdBy: admin.id,
      },
    });
    const lineId = randomUUID();
    await ctx.prisma.contractLine.create({
      data: {
        id: lineId,
        contractVersionId,
        transactionType: 'CUSTOM',
        productCategory: 'SUIT',
        quantity: 2,
      },
    });
    const orderId = randomUUID();
    await ctx.prisma.order.create({
      data: { id: orderId, orderNo: 'ORD-OPT-001', contractId, transactionType: 'CUSTOM' },
    });
    orderItem1 = randomUUID();
    orderItem2 = randomUUID();
    await ctx.prisma.orderItem.createMany({
      data: [
        {
          id: orderItem1,
          orderId,
          sourceContractLineId: lineId,
          productCategory: 'SUIT',
          sequenceNo: 1,
          displayName: '정장 #1',
        },
        {
          id: orderItem2,
          orderId,
          sourceContractLineId: lineId,
          productCategory: 'SUIT',
          sequenceNo: 2,
          displayName: '정장 #2',
        },
      ],
    });

    // truncateBusinessData의 TRUNCATE ... CASCADE가 option_set_versions를 참조하는
    // option_sets까지 비우므로 시드와 동일한 SUIT 옵션 세트를 재생성한다.
    const suitSet = await ctx.prisma.optionSet.upsert({
      where: { productCategory: 'SUIT' },
      update: {},
      create: { id: randomUUID(), productCategory: 'SUIT', name: '정장 옵션', activeVersionId: null },
    });
    optionSetId = suitSet.id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  // -------------------------------------------------------------------------
  // 1) 마스터: 버전 생성 → 단계 저장(A/B 검증) → 활성화
  // -------------------------------------------------------------------------

  it('빈 DRAFT 버전을 생성한다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/option-sets/${optionSetId}/versions`)
      .set(auth(ctx))
      .send({ description: '2026 V1' })
      .expect(201);
    expect(res.body.data.status).toBe('DRAFT');
    expect(res.body.data.versionNo).toBe(1);
    expect(res.body.data.stages).toHaveLength(0);
    versionV1 = res.body.data.id;
  });

  it('단계의 선택지가 A/B 2개가 아니면 OPTION_SET_INVALID를 반환한다', async () => {
    const res = await api(ctx)
      .put(`/api/v1/option-set-versions/${versionV1}/stages`)
      .set(auth(ctx))
      .send({
        stages: [
          {
            stageCode: 'LAPEL',
            stageName: '라펠',
            sequenceNo: 1,
            choices: [{ choiceCode: 'A', choiceName: '피크드' }],
          },
        ],
      })
      .expect(422);
    expect(res.body.error.code).toBe('OPTION_SET_INVALID');
  });

  it('DRAFT 버전에 단계·선택지를 저장하면 placeholder 이미지 파일이 연결된다', async () => {
    const res = await api(ctx)
      .put(`/api/v1/option-set-versions/${versionV1}/stages`)
      .set(auth(ctx))
      .send(stagesPayload)
      .expect(200);
    expect(res.body.data.stages).toHaveLength(3);
    for (const stage of res.body.data.stages) {
      expect(stage.choices).toHaveLength(2);
      expect(stage.choices.map((c: { choiceCode: string }) => c.choiceCode).sort()).toEqual([
        'A',
        'B',
      ]);
      for (const choice of stage.choices) expect(choice.imageFileId).toBeTruthy();
    }
    // image_file_id 필수 FK → placeholder 파일 레코드 생성 확인
    const files = await ctx.prisma.file.count({
      where: { storageKey: { startsWith: 'placeholders/options/' } },
    });
    expect(files).toBe(6);
  });

  it('활성화하면 ACTIVE가 되고 option_sets.active_version_id가 갱신된다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/option-set-versions/${versionV1}/activate`)
      .set(auth(ctx))
      .send({})
      .expect(201);
    expect(res.body.data.status).toBe('ACTIVE');
    const set = await ctx.prisma.optionSet.findUniqueOrThrow({ where: { id: optionSetId } });
    expect(set.activeVersionId).toBe(versionV1);
    // 활성화 감사로그 기록
    const audits = await ctx.prisma.auditLog.count({
      where: { entityType: 'OPTION_SET_VERSION', entityId: versionV1, action: 'ACTIVATE' },
    });
    expect(audits).toBe(1);
  });

  it('ACTIVE 버전은 단계 저장이 차단된다', async () => {
    const res = await api(ctx)
      .put(`/api/v1/option-set-versions/${versionV1}/stages`)
      .set(auth(ctx))
      .send(stagesPayload)
      .expect(409);
    expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('기존 버전 복사로 새 버전을 만들어 활성화하면 기존 ACTIVE는 RETIRED가 된다', async () => {
    const created = await api(ctx)
      .post(`/api/v1/option-sets/${optionSetId}/versions`)
      .set(auth(ctx))
      .send({ copyFromVersionId: versionV1, description: '2026 V2' })
      .expect(201);
    versionV2 = created.body.data.id;
    expect(created.body.data.versionNo).toBe(2);
    expect(created.body.data.stages).toHaveLength(3);

    const activated = await api(ctx)
      .post(`/api/v1/option-set-versions/${versionV2}/activate`)
      .set(auth(ctx))
      .send({})
      .expect(201);
    expect(activated.body.data.retiredVersionIds).toContain(versionV1);

    const v1 = await ctx.prisma.optionSetVersion.findUniqueOrThrow({ where: { id: versionV1 } });
    expect(v1.status).toBe('RETIRED');
    const set = await ctx.prisma.optionSet.findUniqueOrThrow({ where: { id: optionSetId } });
    expect(set.activeVersionId).toBe(versionV2);
  });

  it('활성 옵션 세트를 카테고리로 조회한다', async () => {
    const res = await api(ctx)
      .get('/api/v1/option-sets/active')
      .query({ category: 'SUIT' })
      .set(auth(ctx))
      .expect(200);
    expect(res.body.data.version.id).toBe(versionV2);
    expect(res.body.data.version.stages).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // 2) 선택 세션: 시작 → 임시저장·재개 → 확정 차단 → 확정 → 재시작 → 복사
  // -------------------------------------------------------------------------

  it('세션 시작 시 ACTIVE 버전으로 NOT_STARTED 세션을 생성한다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/order-items/${orderItem1}/option-sessions`)
      .set(auth(ctx))
      .expect(201);
    expect(res.body.data.status).toBe('NOT_STARTED');
    expect(res.body.data.selectionVersionNo).toBe(1);
    expect(res.body.data.optionSetVersion.id).toBe(versionV2);
    expect(res.body.data.totalStages).toBe(3);
    sessionId = res.body.data.sessionId;
    sessionVersion = res.body.data.version;
    stages = res.body.data.stages;
  });

  it('미확정 세션이 있으면 재시작 시 동일 세션을 반환한다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/order-items/${orderItem1}/option-sessions`)
      .set(auth(ctx))
      .expect(201);
    expect(res.body.data.sessionId).toBe(sessionId);
    expect(res.body.data.selectionVersionNo).toBe(1);
  });

  it('단계 임시저장 시 IN_PROGRESS가 되고 재개 지점이 다음 단계를 가리킨다', async () => {
    const stage1 = stages[0];
    const res = await api(ctx)
      .put(`/api/v1/option-sessions/${sessionId}/stages/${stage1.stageId}`)
      .set(auth(ctx))
      .send({ choiceId: stage1.choices[0].id, currentStageOrder: 1, version: sessionVersion })
      .expect(200);
    expect(res.body.data.status).toBe('IN_PROGRESS');
    expect(res.body.data.savedStageId).toBe(stage1.stageId);
    expect(res.body.data.nextStageId).toBe(stages[1].stageId);
    expect(res.body.data.completedStages).toBe(1);
    expect(res.body.data.totalStages).toBe(3);
    expect(res.body.data.version).toBe(sessionVersion + 1);
    sessionVersion = res.body.data.version;

    const resume = await api(ctx)
      .get(`/api/v1/option-sessions/${sessionId}/resume`)
      .set(auth(ctx))
      .expect(200);
    expect(resume.body.data.resumeStageId).toBe(stages[1].stageId);
    expect(resume.body.data.completedStages).toBe(1);
  });

  it('오래된 row_version으로 저장하면 VERSION_CONFLICT를 반환한다', async () => {
    const stage2 = stages[1];
    const res = await api(ctx)
      .put(`/api/v1/option-sessions/${sessionId}/stages/${stage2.stageId}`)
      .set(auth(ctx))
      .send({ choiceId: stage2.choices[1].id, version: sessionVersion - 1 })
      .expect(409);
    expect(res.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('전 단계 미완료 상태의 confirm은 OPTION_STAGE_INCOMPLETE로 차단된다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/option-sessions/${sessionId}/confirm`)
      .set(auth(ctx))
      .send({ version: sessionVersion })
      .expect(422);
    expect(res.body.error.code).toBe('OPTION_STAGE_INCOMPLETE');
    expect(res.body.error.details.missingStages).toHaveLength(2);
  });

  it('전 단계 저장 시 REVIEW가 되고 확인서에 누락이 없다', async () => {
    for (const stage of [stages[1], stages[2]]) {
      const res = await api(ctx)
        .put(`/api/v1/option-sessions/${sessionId}/stages/${stage.stageId}`)
        .set(auth(ctx))
        .send({ choiceId: stage.choices[1].id, version: sessionVersion })
        .expect(200);
      sessionVersion = res.body.data.version;
    }
    const detail = await api(ctx)
      .get(`/api/v1/option-sessions/${sessionId}`)
      .set(auth(ctx))
      .expect(200);
    expect(detail.body.data.status).toBe('REVIEW');
    expect(detail.body.data.completedStages).toBe(3);

    const review = await api(ctx)
      .get(`/api/v1/option-sessions/${sessionId}/review`)
      .set(auth(ctx))
      .expect(200);
    expect(review.body.data.missingStages).toHaveLength(0);
    expect(review.body.data.stages.every((s: { selected: unknown }) => s.selected)).toBe(true);
  });

  it('confirm 시 CONFIRMED가 되고 감사로그가 남는다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/option-sessions/${sessionId}/confirm`)
      .set(auth(ctx))
      .send({ version: sessionVersion })
      .expect(200);
    expect(res.body.data.status).toBe('CONFIRMED');
    expect(res.body.data.confirmedAt).toBeTruthy();
    expect(res.body.data.optionSummary).toHaveLength(3);

    const row = await ctx.prisma.optionSelectionSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    expect(row.status).toBe('CONFIRMED');
    expect(row.confirmedAt).not.toBeNull();

    const audits = await ctx.prisma.auditLog.count({
      where: { entityType: 'OPTION_SELECTION_SESSION', entityId: sessionId, action: 'CONFIRM' },
    });
    expect(audits).toBe(1);
    confirmedSessionId = sessionId;
  });

  it('확정 세션은 재저장·재확정이 차단된다', async () => {
    const stage1 = stages[0];
    const res = await api(ctx)
      .put(`/api/v1/option-sessions/${sessionId}/stages/${stage1.stageId}`)
      .set(auth(ctx))
      .send({ choiceId: stage1.choices[1].id, version: sessionVersion + 1 })
      .expect(409);
    expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('확정 후 재시작하면 선택값이 복사된 새 selection_version_no 세션이 생성된다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/order-items/${orderItem1}/option-sessions`)
      .set(auth(ctx))
      .expect(201);
    expect(res.body.data.sessionId).not.toBe(confirmedSessionId);
    expect(res.body.data.selectionVersionNo).toBe(2);
    expect(res.body.data.status).toBe('REVIEW'); // 확정 세션의 선택값 복사 → 전 단계 완료
    expect(res.body.data.completedStages).toBe(3);
    expect(res.body.data.isCurrent).toBe(true);

    // is_current는 품목당 1개만 유지된다
    const currents = await ctx.prisma.optionSelectionSession.findMany({
      where: { orderItemId: orderItem1, isCurrent: true },
    });
    expect(currents).toHaveLength(1);
    expect(currents[0].id).toBe(res.body.data.sessionId);
    const old = await ctx.prisma.optionSelectionSession.findUniqueOrThrow({
      where: { id: confirmedSessionId },
    });
    expect(old.isCurrent).toBe(false);
  });

  it('동일 카테고리의 다른 품목으로 선택값을 복사한다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/option-sessions/${confirmedSessionId}/copy`)
      .set(auth(ctx))
      .send({ targetOrderItemId: orderItem2 })
      .expect(201);
    expect(res.body.data.orderItemId).toBe(orderItem2);
    expect(res.body.data.completedStages).toBe(3);
    expect(res.body.data.status).toBe('REVIEW');
    expect(res.body.data.stages.every((s: StageView) => s.selectedChoiceId)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3) 화면 전용 신설 API: 진행 목록 · 품목 현재 세션 · fabric 저장 (연동정합화 계약 §6)
  // -------------------------------------------------------------------------

  it('option-progress는 맞춤 품목별 진행 현황을 반환하고 취소 품목은 제외한다', async () => {
    const base = await ctx.prisma.orderItem.findUniqueOrThrow({ where: { id: orderItem1 } });
    const cancelledId = randomUUID();
    orderItem4 = randomUUID();
    await ctx.prisma.orderItem.createMany({
      data: [
        {
          id: cancelledId,
          orderId: base.orderId,
          sourceContractLineId: base.sourceContractLineId,
          productCategory: 'SUIT',
          sequenceNo: 3,
          displayName: '취소된 정장',
          status: 'CANCELLED',
        },
        {
          id: orderItem4,
          orderId: base.orderId,
          sourceContractLineId: base.sourceContractLineId,
          productCategory: 'SUIT',
          sequenceNo: 4,
          displayName: '정장 #4',
        },
      ],
    });

    const res = await api(ctx).get('/api/v1/order-items/option-progress').set(auth(ctx)).expect(200);
    const rows = res.body.data as Array<Record<string, unknown>>;
    const ids = rows.map((r) => r.orderItemId);
    expect(ids).toContain(orderItem1);
    expect(ids).toContain(orderItem2);
    expect(ids).toContain(orderItem4);
    expect(ids).not.toContain(cancelledId); // 취소 품목 제외

    // 진행 중(is_current) 세션 기준의 상태·단계 수
    const row1 = rows.find((r) => r.orderItemId === orderItem1) as Record<string, unknown>;
    expect(row1).toMatchObject({
      displayName: '정장 #1',
      productCategory: 'SUIT',
      customerName: '옵션 테스트 고객',
      orderNo: 'ORD-OPT-001',
      status: 'REVIEW',
      completedStages: 3,
      totalStages: 3,
    });
    expect(row1.sessionId).toBeTruthy();
    expect(row1.sessionId).not.toBe(confirmedSessionId); // 확정 세션이 아닌 현재 세션

    // 세션이 없는 품목: NOT_STARTED + 활성 버전 단계 수
    const fresh = rows.find((r) => r.orderItemId === orderItem4) as Record<string, unknown>;
    expect(fresh).toMatchObject({
      status: 'NOT_STARTED',
      completedStages: 0,
      totalStages: 3,
      sessionId: null,
      fabric: null,
    });
  });

  it('품목의 현재 옵션 세션을 조회하고 없으면 session: null을 반환한다', async () => {
    const res = await api(ctx)
      .get(`/api/v1/order-items/${orderItem1}/option-session`)
      .set(auth(ctx))
      .expect(200);
    const session = res.body.data.session;
    expect(session).not.toBeNull();
    expect(session.orderItemId).toBe(orderItem1);
    expect(session.isCurrent).toBe(true);
    expect(session.stages).toHaveLength(3);
    expect(session.completedStages).toBe(3);
    expect(session.stages.every((s: StageView) => s.selectedChoiceId)).toBe(true);
    expect(session.resumeStageId).toBeTruthy(); // 재개 지점 포함

    const none = await api(ctx)
      .get(`/api/v1/order-items/${orderItem4}/option-session`)
      .set(auth(ctx))
      .expect(200);
    expect(none.body.data.session).toBeNull();

    await api(ctx).get(`/api/v1/order-items/${randomUUID()}/option-session`).set(auth(ctx)).expect(404);
  });

  it('세션 시작 body의 fabric이 fabricName으로 저장된다', async () => {
    const res = await api(ctx)
      .post(`/api/v1/order-items/${orderItem4}/option-sessions`)
      .set(auth(ctx))
      .send({ fabric: '캐시미어 네이비' })
      .expect(201);
    expect(res.body.data.fabricName).toBe('캐시미어 네이비');
    const row = await ctx.prisma.optionSelectionSession.findUniqueOrThrow({
      where: { id: res.body.data.sessionId },
    });
    expect(row.fabricName).toBe('캐시미어 네이비');

    // 진행 목록에 fabric·세션 반영
    const progress = await api(ctx).get('/api/v1/order-items/option-progress').set(auth(ctx)).expect(200);
    const row4 = progress.body.data.find(
      (r: { orderItemId: string }) => r.orderItemId === orderItem4,
    );
    expect(row4.fabric).toBe('캐시미어 네이비');
    expect(row4.status).toBe('NOT_STARTED');
    expect(row4.sessionId).toBe(res.body.data.sessionId);
  });

  it('일반 직원 권한(OPTION_SELECT 없음이 아닌 마스터 권한 없음)으로 마스터 API는 403이다', async () => {
    // STAFF 역할 사용자 생성: OPTION_SELECT는 있으나 OPTION_MASTER_EDIT 없음
    // (users는 truncate 대상이 아니므로 재실행 안전하게 고유 loginId를 사용한다)
    const staffLoginId = `opt-staff-${Date.now()}`;
    await api(ctx)
      .post('/api/v1/users')
      .set(auth(ctx))
      .send({
        loginId: staffLoginId,
        displayName: '옵션 직원',
        password: 'staff1234!',
        roleCodes: ['STAFF'],
      })
      .expect(201);
    const login = await api(ctx)
      .post('/api/v1/auth/login')
      .send({ loginId: staffLoginId, password: 'staff1234!' })
      .expect(200);
    const staffToken = login.body.data.accessToken as string;

    const denied = await api(ctx)
      .post(`/api/v1/option-sets/${optionSetId}/versions`)
      .set({ Authorization: `Bearer ${staffToken}` })
      .send({})
      .expect(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');

    // 선택 API는 접근 가능
    await api(ctx)
      .get(`/api/v1/option-sessions/${confirmedSessionId}`)
      .set({ Authorization: `Bearer ${staffToken}` })
      .expect(200);
  });
});
