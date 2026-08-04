import { randomUUID } from 'crypto';
import { ContractsModule } from '../../backend/src/modules/contracts/contracts.module';
import { OptionsModule } from '../../backend/src/modules/options/options.module';
import { OrdersModule } from '../../backend/src/modules/orders/orders.module';
import { api, auth, createTestContext, SIGN_PNG, TestContext, truncateBusinessData } from './helpers';

/**
 * 베스트(3피스) E2E — 계약부터 주문까지 화면 버튼 순서 그대로 밟는다 (현업 확정 2026-07-30·31).
 *
 * 버튼 ↔ API 매핑:
 *   임시저장            = POST/PATCH /contracts
 *   옵션 선택(단계 저장) = POST /contract-items/:id/option-sessions → PUT /option-sessions/:id/stages/:stageId
 *   최종 저장(확정)      = POST /option-sessions/:id/confirm
 *   옵션 선택 안함       = POST /contracts/items/:id/exclude-vest
 *   서명하기            = POST /contracts/:id/versions/:vid/signature
 *   수정하기(서명완료)   = DELETE /contracts/:id/versions/:vid/signature (서명 해제, 버전 그대로)
 *   계약완료            = POST /contracts/:id/complete
 *   수정하기(계약완료)   = POST /contracts/:id/revisions (사유 필수, 버전업)
 *
 * 각 단계에서 베스트 추가([베스트 제외] 해제)와 제외([옵션 선택 안함]/체크)를 시도하고
 * 허용/차단과 금액·부위·단계·주문 구성품 정합을 검증한다.
 */

const UNIT = 1_000_000;
const VEST = 300_000;

describe('베스트 E2E — 계약 → 컨설팅 → 서명 → 계약완료 → 주문 → 수정하기', () => {
  let ctx: TestContext;
  let contractId: string;
  let itemId: string;

  beforeAll(async () => {
    ctx = await createTestContext([ContractsModule, OptionsModule, OrdersModule]);
    await truncateBusinessData(ctx.prisma);

    // 정장 옵션세트: 상의 1단계 + 하의 1단계 + 베스트 2단계 (선택지 추가금 0원 — 금액 검증 단순화)
    const suitSet = await ctx.prisma.optionSet.upsert({
      where: { productCategory: 'SUIT' },
      update: {},
      create: { id: randomUUID(), productCategory: 'SUIT', name: '정장 옵션', activeVersionId: null },
    });
    const versionRes = await api(ctx)
      .post(`/api/v1/option-sets/${suitSet.id}/versions`)
      .set(auth(ctx))
      .send({})
      .expect(201);
    const versionId = versionRes.body.data.id as string;
    await api(ctx)
      .put(`/api/v1/option-set-versions/${versionId}/stages`)
      .set(auth(ctx))
      .send({
        stages: [
          { stageCode: 'JACKET_LAPEL', stageName: '상의 라펠', sequenceNo: 1, required: true, componentGroup: 'JACKET', choices: [{ choiceCode: 'A', choiceName: '노치드' }, { choiceCode: 'B', choiceName: '피크드' }] },
          { stageCode: 'TROUSER_FIT', stageName: '하의 핏', sequenceNo: 2, required: true, componentGroup: 'TROUSERS', choices: [{ choiceCode: 'A', choiceName: '스트레이트' }, { choiceCode: 'B', choiceName: '테이퍼드' }] },
          { stageCode: 'VEST_STITCH', stageName: '베스트 스티치', sequenceNo: 3, required: true, componentGroup: 'VEST', choices: [{ choiceCode: 'A', choiceName: '스티치' }, { choiceCode: 'B', choiceName: '스티치 없음' }] },
          { stageCode: 'VEST_COLLAR', stageName: '베스트 카라', sequenceNo: 4, required: true, componentGroup: 'VEST', choices: [{ choiceCode: 'A', choiceName: '노치드 카라' }, { choiceCode: 'B', choiceName: '숄카라' }] },
        ],
      })
      .expect(200);
    await api(ctx).post(`/api/v1/option-set-versions/${versionId}/activate`).set(auth(ctx)).expect(201);

    const customer = await ctx.prisma.customer.create({
      data: {
        id: randomUUID(),
        name: 'E2E 베스트 고객',
        phone: '010-7777-0001',
        phoneNormalized: '01077770001',
        customerStatus: 'PROSPECT',
      },
    });

    // [계약서 작성 → 임시저장] — 2피스 정장 1벌.
    // 맞춤 정장의 기본은 포함(3피스)이라, 2피스로 시작하려면 제외를 명시해 보낸다.
    const created = await api(ctx)
      .post('/api/v1/contracts')
      .set(auth(ctx))
      .send({
        customerId: customer.id,
        totalAmount: UNIT,
        lines: [
          {
            transactionType: 'CUSTOM',
            productCategory: 'SUIT',
            quantity: 1,
            unitPrice: UNIT,
            lineAmount: UNIT,
            vestIncluded: false,
          },
        ],
      })
      .expect(201);
    contractId = created.body.data.id;
    itemId = (await ctx.prisma.contractItem.findFirstOrThrow({ where: { contractId } })).id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  // ---------- 공용 버튼 헬퍼 ----------

  /**
   * [임시저장] — 라인 전체 교체. 계약서는 베스트를 다루지 않는다 (현업 확정 2026-08-01).
   * 베스트를 빼서 값을 깎는 것도 여기서 수기로 한다(자동 차감 없음).
   */
  async function saveLines(total: number, expectStatus = 200) {
    return api(ctx)
      .patch(`/api/v1/contracts/${contractId}`)
      .set(auth(ctx))
      .send({
        totalAmount: total,
        lines: [
          {
            transactionType: 'CUSTOM',
            productCategory: 'SUIT',
            quantity: 1,
            unitPrice: total,
            lineAmount: total,
          },
        ],
      })
      .expect(expectStatus);
  }

  /** 컨설팅 [베스트 제외] 체크박스 — 체크(제외)/해제(재포함) 한 엔드포인트 */
  const setVest = (included: boolean) =>
    api(ctx).post(`/api/v1/contracts/items/${itemId}/vest`).set(auth(ctx)).send({ included });

  async function flow() {
    const res = await api(ctx).get(`/api/v1/contracts/${contractId}/flow`).set(auth(ctx)).expect(200);
    return res.body.data;
  }

  async function sessionDetail() {
    const res = await api(ctx).get(`/api/v1/contract-items/${itemId}/option-session`).set(auth(ctx)).expect(200);
    return res.body.data.session;
  }

  /** [옵션 선택] — 미선택 단계를 첫 선택지로 모두 저장 */
  async function selectRemainingStages() {
    let session = await sessionDetail();
    if (!session) {
      const started = await api(ctx)
        .post(`/api/v1/contract-items/${itemId}/option-sessions`)
        .set(auth(ctx))
        .send({})
        .expect(201);
      session = started.body.data;
    }
    let version = session.version as number;
    for (const stage of session.stages) {
      if (stage.selectedChoiceId) continue;
      const res = await api(ctx)
        .put(`/api/v1/option-sessions/${session.sessionId}/stages/${stage.stageId}`)
        .set(auth(ctx))
        .send({ choiceId: stage.choices[0].id, currentStageOrder: stage.sequenceNo, version })
        .expect(200);
      version = res.body.data.version;
    }
    return { sessionId: session.sessionId as string, version };
  }

  /** [최종 저장(확정)] */
  async function confirmSession() {
    const { sessionId, version } = await selectRemainingStages();
    await api(ctx)
      .post(`/api/v1/option-sessions/${sessionId}/confirm`)
      .set(auth(ctx))
      .send({ version })
      .expect((r) => {
        if (r.status !== 200 && r.status !== 201) throw new Error(`confirm 실패: ${JSON.stringify(r.body)}`);
      });
  }

  /** [서명하기] */
  async function sign() {
    const contract = await ctx.prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
    await api(ctx)
      .post(`/api/v1/contracts/${contractId}/versions/${contract.currentVersionId}/signature`)
      .set(auth(ctx))
      .send({ imageDataUrl: SIGN_PNG, signerName: 'E2E' })
      .expect((r) => {
        if (r.status !== 200 && r.status !== 201) throw new Error(`서명 실패: ${JSON.stringify(r.body)}`);
      });
  }

  /** [계약완료] */
  async function complete() {
    await api(ctx).post(`/api/v1/contracts/${contractId}/complete`).set(auth(ctx)).send({}).expect(200);
  }

  async function totalAmount(): Promise<number> {
    const c = await ctx.prisma.contract.findUniqueOrThrow({
      where: { id: contractId },
      include: { currentVersion: true },
    });
    return Number(c.currentVersion!.totalAmount);
  }

  async function vestComponentStatus(): Promise<string | null> {
    const comp = await ctx.prisma.contractItemComponent.findFirst({
      where: { contractItemId: itemId, componentType: 'VEST' },
    });
    return comp?.status ?? null;
  }

  async function orderVestStatus(): Promise<string | null> {
    const comp = await ctx.prisma.orderItemComponent.findFirst({
      where: { orderItem: { sourceContractItemId: itemId }, componentType: 'VEST' },
    });
    return comp?.status ?? null;
  }

  // ---------- A. 작성중 (주문 없음) ----------

  it('A1. 작성중 기본 3피스 — 베스트 부위·단계가 처음부터 있고, 문서에 베스트 행은 없다', async () => {
    // 계약 시점에는 3피스로 갈지 모르니 정장은 항상 세 부위로 만든다 (현업 확정 2026-08-01).
    expect(await vestComponentStatus()).toBe('CREATED');
    const started = await api(ctx)
      .post(`/api/v1/contract-items/${itemId}/option-sessions`)
      .set(auth(ctx))
      .send({})
      .expect(201);
    expect(started.body.data.totalStages).toBe(4); // 상의·하의 + 베스트 2단계
    expect(started.body.data.stages.map((s: { stageCode: string }) => s.stageCode)).toContain('VEST_STITCH');

    // 계약서 품목표는 베스트 행을 따로 싣지 않는다 — 정장 한 행뿐이다.
    const doc = await api(ctx).get(`/api/v1/contracts/${contractId}/document`).set(auth(ctx)).expect(200);
    expect(doc.body.data.lines).toHaveLength(1);
    expect(Number(doc.body.data.lines[0].lineAmount)).toBe(UNIT);
  });

  it('A2. [베스트 제외] 체크 — 부위·단계가 빠지고 계약 금액은 그대로다', async () => {
    const res = await setVest(false).expect(200);
    expect(res.body.data.vestIncluded).toBe(false);
    expect(await vestComponentStatus()).toBe('CANCELLED');
    // 베스트 값은 그때그때 달라 자동 차감하지 않는다 — 계약서에서 수기로 조정한다.
    expect(await totalAmount()).toBe(UNIT);

    const session = await sessionDetail();
    expect(session.totalStages).toBe(2); // 상의·하의만
  });

  it('A3. 체크 해제 — 베스트가 되살아난다 (컨설팅이 유일한 경로라 왕복해야 한다)', async () => {
    await setVest(true).expect(200);
    expect(await vestComponentStatus()).toBe('CREATED');
    expect((await sessionDetail()).totalStages).toBe(4);
  });

  it('A4. 4단계 모두 선택·확정 — 서명 게이트가 열린다', async () => {
    await confirmSession();
    expect((await flow()).consulting.ready).toBe(true);
  });

  it('A5. 확정 후 [베스트 제외] — 단계·선택값이 정리되고 게이트는 열린 채 유지된다', async () => {
    await setVest(false).expect(200);
    expect(await vestComponentStatus()).toBe('CANCELLED');
    expect(await totalAmount()).toBe(UNIT);

    const session = await sessionDetail();
    expect(session.totalStages).toBe(2);
    expect(session.completedStages).toBe(2); // 남은 상의·하의는 이미 선택됨
    expect((await flow()).consulting.ready).toBe(true);
  });

  it('A6. 다시 포함 — 베스트 단계가 선택될 때까지 서명 게이트가 잠기고, 선택하면 풀린다', async () => {
    await setVest(true).expect(200);
    expect(await vestComponentStatus()).toBe('CREATED'); // 취소됐던 부위 되살림
    expect((await flow()).consulting.ready).toBe(false); // VEST 단계 미선택

    // 확정 세션 재편집(새 선택 버전) → 베스트 2단계만 남은 미선택을 채우고 재확정
    await api(ctx).post(`/api/v1/contract-items/${itemId}/option-sessions`).set(auth(ctx)).send({}).expect(201);
    await confirmSession();
    expect((await flow()).consulting.ready).toBe(true);
  });

  // ---------- B. 서명완료 (주문 없음) ----------

  it('B1. 서명완료 — 계약서 수정·베스트 제외가 모두 잠긴다', async () => {
    await sign();
    expect((await flow()).status).toBe('SIGNED');

    await saveLines(UNIT, 409); // 계약서 수정 잠금 (CONTRACT_NOT_DRAFT)
    const res = await setVest(false).expect(409);
    expect(res.body.error.code).toBe('CONTRACT_NOT_DRAFT');
    expect(await vestComponentStatus()).toBe('CREATED');
  });

  it('B2. [수정하기](서명 해제) — 작성중 복귀, 다시 베스트 조작 가능', async () => {
    const contract = await ctx.prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
    await api(ctx)
      .delete(`/api/v1/contracts/${contractId}/versions/${contract.currentVersionId}/signature`)
      .set(auth(ctx))
      .expect(200);
    expect((await flow()).status).toBe('DRAFT');
    // 베스트 포함 그대로 다시 서명해 완료 준비
    await sign();
  });

  // ---------- C. 계약완료 → 주문 ----------

  it('C1. [계약완료] — 주문 구성품에 상의·하의·베스트가 생긴다', async () => {
    await complete();
    expect((await flow()).status).toBe('COMPLETED');

    const orderItem = await ctx.prisma.orderItem.findFirstOrThrow({
      where: { sourceContractItemId: itemId },
      include: { components: true },
    });
    expect(orderItem.components.map((c) => c.componentType).sort()).toEqual(['JACKET', 'TROUSERS', 'VEST']);
    expect(await orderVestStatus()).toBe('CREATED');
  });

  it('C2. 계약완료 상태 — 계약서 수정·베스트 제외 잠김 (수정하기로만)', async () => {
    await saveLines(UNIT, 409);
    const res = await setVest(false).expect(409);
    expect(res.body.error.code).toBe('CONTRACT_NOT_DRAFT');
  });

  it('C3. [수정하기](버전업) 후 [베스트 제외] — 재완료 시 주문 베스트 구성품이 취소된다', async () => {
    await api(ctx)
      .post(`/api/v1/contracts/${contractId}/revisions`)
      .set(auth(ctx))
      .send({ changeReason: '고객 변심 — 베스트 제외' })
      .expect(201);
    expect((await flow()).status).toBe('DRAFT');

    // 품목 미진행(주문품목 CREATED)이므로 제외 허용
    await setVest(false).expect(200);
    expect(await vestComponentStatus()).toBe('CANCELLED');
    // 주문 구성품은 재완료 전까지 그대로다 (계약서 반영은 계약완료 시점)
    expect(await orderVestStatus()).toBe('CREATED');

    // 베스트 금액은 수기 조정 — 계약서에서 직접 깎는다.
    await saveLines(UNIT - VEST);
    expect(await totalAmount()).toBe(UNIT - VEST);

    await sign();
    await complete();
    expect(await orderVestStatus()).toBe('CANCELLED'); // 증분 동기화 — 미진행이라 취소됨

    // 주문품목은 중복 생성되지 않는다
    const orderItems = await ctx.prisma.orderItem.findMany({ where: { sourceContractItemId: itemId } });
    expect(orderItems).toHaveLength(1);
  });

  it('C4. 다시 [수정하기] → 베스트 재포함 → 재완료 — 주문 베스트 구성품이 되살아난다', async () => {
    await api(ctx)
      .post(`/api/v1/contracts/${contractId}/revisions`)
      .set(auth(ctx))
      .send({ changeReason: '추가 방문 — 베스트 추가' })
      .expect(201);
    await setVest(true).expect(200);
    expect(await vestComponentStatus()).toBe('CREATED');
    expect((await flow()).consulting.ready).toBe(false); // 베스트 단계 다시 선택해야 함

    await api(ctx).post(`/api/v1/contract-items/${itemId}/option-sessions`).set(auth(ctx)).send({}).expect(201);
    await confirmSession();
    await saveLines(UNIT); // 베스트 값을 다시 얹는 것도 수기
    await sign();
    await complete();

    expect(await orderVestStatus()).toBe('CREATED'); // 취소됐던 주문 구성품 되살림
    expect(await totalAmount()).toBe(UNIT);
  });

  // ---------- D. 제작 진행 중 ----------

  it('D1. 제작요청 이후 — [베스트 제외]가 차단된다', async () => {
    await api(ctx)
      .post(`/api/v1/contracts/${contractId}/revisions`)
      .set(auth(ctx))
      .send({ changeReason: '베스트 제외 시도(제작 중)' })
      .expect(201);
    const orderItem = await ctx.prisma.orderItem.findFirstOrThrow({ where: { sourceContractItemId: itemId } });
    await ctx.prisma.orderItem.update({ where: { id: orderItem.id }, data: { status: 'PRODUCTION_REQUESTED' } });

    const excluded = await setVest(false).expect(409);
    expect(excluded.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    expect(await vestComponentStatus()).toBe('CREATED'); // 그대로 유지
  });

  it('D2. [되돌리기]로 제작요청을 풀면 제외가 다시 가능하다', async () => {
    const orderItem = await ctx.prisma.orderItem.findFirstOrThrow({ where: { sourceContractItemId: itemId } });
    await ctx.prisma.orderItem.update({ where: { id: orderItem.id }, data: { status: 'CREATED' } });

    await setVest(false).expect(200);
    expect(await vestComponentStatus()).toBe('CANCELLED');
  });
});
