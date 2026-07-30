import { randomUUID } from 'crypto';
import { api, auth, createTestContext, TestContext, truncateBusinessData } from './helpers';

/** 로컬 자정 기준 타임스탬프 (timestamptz 컬럼용 — 서버 버킷도 로컬 달력을 쓴다) */
function ts(y: number, m: number, d: number, hour = 10): Date {
  return new Date(y, m - 1, d, hour, 0, 0);
}

/** UTC 자정 기준 Date (@db.Date 컬럼용) */
function dbDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

interface Series {
  key: string;
  label: string;
  colorIndex: number;
}
interface Bucket {
  period: string;
  label: string;
  total: number;
  values: Record<string, number>;
}
interface Counts {
  series: Series[];
  buckets: Bucket[];
  total: number;
  basis: string;
  valueKind: 'COUNT' | 'AMOUNT';
  sourceCount: number;
}

/**
 * 2026-03-02는 월요일이다 — 주 버킷(월요일 시작) 검증의 기준점으로 쓴다.
 * 3/8은 같은 주 일요일, 3/9는 다음 주 월요일.
 */
describe('건수 통계 (stats)', () => {
  let ctx: TestContext;
  let adminId: string;
  let customerId: string;
  let purposeCodes: string[];

  const counts = async (query: Record<string, string>): Promise<Counts> => {
    const qs = new URLSearchParams(query).toString();
    const res = await api(ctx).get(`/api/v1/stats/counts?${qs}`).set(auth(ctx)).expect(200);
    return res.body.data as Counts;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    await truncateBusinessData(ctx.prisma);

    const admin = await ctx.prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
    adminId = admin.id;

    customerId = randomUUID();
    await ctx.prisma.customer.create({
      data: { id: customerId, name: '홍길동', phone: '010-1111-2222', phoneNormalized: '01011112222' },
    });

    // --- 예약 ---
    const purposes = await ctx.prisma.appointmentPurpose.findMany({ orderBy: { sortOrder: 'asc' } });
    purposeCodes = purposes.map((p) => p.code);
    expect(purposes.length).toBeGreaterThan(7); // 색 슬롯 상한을 넘겨 '기타' 접힘을 검증할 수 있어야 한다

    // 3/2에 목적별 1건씩 — 계열이 상한을 넘으므로 상위 7종 + 기타로 접혀야 한다.
    for (const purpose of purposes) {
      await ctx.prisma.appointment.create({
        data: {
          id: randomUUID(),
          customerId,
          source: 'CRM',
          purposeId: purpose.id,
          scheduledStart: ts(2026, 3, 2),
          status: 'RESERVED',
        },
      });
    }
    // 주·월 버킷 검증용 (같은 주 일요일 / 다음 주 월요일)
    for (const day of [8, 9]) {
      await ctx.prisma.appointment.create({
        data: {
          id: randomUUID(),
          customerId,
          source: 'CRM',
          purposeId: purposes[0].id,
          scheduledStart: ts(2026, 3, day),
          status: 'CONFIRMED',
        },
      });
    }
    // 취소 예약은 집계에서 빠진다.
    await ctx.prisma.appointment.create({
      data: {
        id: randomUUID(),
        customerId,
        source: 'CRM',
        purposeId: purposes[0].id,
        scheduledStart: ts(2026, 3, 10),
        status: 'CANCELLED',
      },
    });

    // --- 계약·주문·구성품 ---
    const contractId = randomUUID();
    const versionId = randomUUID();
    await ctx.prisma.contract.create({
      data: {
        id: contractId,
        contractNo: 'CTR-260306-001',
        customerId,
        status: 'CONFIRMED',
        contractedAt: ts(2026, 3, 6),
      },
    });
    await ctx.prisma.contractVersion.create({
      data: {
        id: versionId,
        contractId,
        versionNo: 1,
        versionStatus: 'CONFIRMED',
        createdBy: adminId,
        // 계약 총액 = 계약줄 합(3,000,000) + 옵션 추가금액(150,000+200,000).
        // 옵션 추가금액은 계약 총액에만 더해지고 계약줄 금액에는 반영되지 않는다.
        totalAmount: 3_350_000,
      },
    });
    await ctx.prisma.contract.update({
      where: { id: contractId },
      data: { currentVersionId: versionId },
    });
    const suitLineId = randomUUID();
    await ctx.prisma.contractLine.createMany({
      data: [
        {
          id: suitLineId,
          contractVersionId: versionId,
          transactionType: 'CUSTOM',
          productCategory: 'SUIT',
          quantity: 2,
          lineAmount: 2_000_000,
        },
        {
          id: randomUUID(),
          contractVersionId: versionId,
          transactionType: 'CUSTOM',
          productCategory: 'SHOES',
          quantity: 1,
          lineAmount: 1_000_000,
        },
      ],
    });
    // 취소 계약은 계약·계약품목 집계에서 빠진다.
    const cancelledContractId = randomUUID();
    const cancelledVersionId = randomUUID();
    await ctx.prisma.contract.create({
      data: {
        id: cancelledContractId,
        contractNo: 'CTR-260306-002',
        customerId,
        status: 'CANCELLED',
        contractedAt: ts(2026, 3, 6),
      },
    });
    await ctx.prisma.contractVersion.create({
      data: {
        id: cancelledVersionId,
        contractId: cancelledContractId,
        versionNo: 1,
        createdBy: adminId,
        // 취소 계약의 금액이 매출에 새면 바로 티가 나도록 큰 값을 넣는다.
        totalAmount: 9_999_000,
      },
    });
    await ctx.prisma.contract.update({
      where: { id: cancelledContractId },
      data: { currentVersionId: cancelledVersionId },
    });
    await ctx.prisma.contractLine.create({
      data: {
        id: randomUUID(),
        contractVersionId: cancelledVersionId,
        transactionType: 'CUSTOM',
        productCategory: 'SUIT',
        quantity: 5,
        lineAmount: 9_999_000,
      },
    });

    // 계약 품목 — 컨설팅(옵션 세션)의 앵커이며 주문 품목의 원천이다. 계약 소유다(버전 아님).
    const contractItemIds = [1, 2, 3, 4].map(() => randomUUID());
    for (let i = 0; i < contractItemIds.length; i += 1) {
      await ctx.prisma.contractItem.create({
        data: {
          id: contractItemIds[i],
          contractId,
          sourceContractLineId: suitLineId,
          transactionType: 'CUSTOM',
          productCategory: 'SUIT',
          sequenceNo: i + 1,
          displayName: `정장 ${i + 1}`,
        },
      });
    }

    const orderId = randomUUID();
    await ctx.prisma.order.create({
      data: { id: orderId, orderNo: 'ORD-260306-001', contractId, transactionType: 'CUSTOM' },
    });
    const orderItemId = randomUUID();
    await ctx.prisma.orderItem.create({
      data: {
        id: orderItemId,
        orderId,
        sourceContractItemId: contractItemIds[0],
        productCategory: 'SUIT',
        sequenceNo: 1,
        displayName: '정장 1',
      },
    });

    // 제작 입고·출고 — 입고 1건(3/6), 출고 1건(3/7)
    const componentId = randomUUID();
    await ctx.prisma.orderItemComponent.create({
      data: {
        id: componentId,
        orderItemId,
        componentType: 'JACKET',
        actualInboundAt: ts(2026, 3, 6),
        actualOutboundAt: ts(2026, 3, 7),
      },
    });

    // --- 렌탈 출고·반납 ---
    // 같은 SKU를 두 벌 보유한다 — 실물이 아니라 SKU로 묶어 세는지 확인하기 위해서다.
    const jacketSkuId = randomUUID();
    const trousersSkuId = randomUUID();
    const jacketItem1 = randomUUID();
    const jacketItem2 = randomUUID();
    const trousersItem = randomUUID();
    await ctx.prisma.rentalSku.createMany({
      data: [
        { id: jacketSkuId, componentType: 'JACKET', color: 'BLACK', size: '48' },
        { id: trousersSkuId, componentType: 'TROUSERS', color: 'GRAY', size: '82' },
      ],
    });
    await ctx.prisma.rentalInventoryItem.createMany({
      data: [
        { id: jacketItem1, managementCode: 'J-001', rentalSkuId: jacketSkuId },
        { id: jacketItem2, managementCode: 'J-002', rentalSkuId: jacketSkuId },
        { id: trousersItem, managementCode: 'T-001', rentalSkuId: trousersSkuId },
      ],
    });
    // 기간 중복 EXCLUDE 제약이 있으므로 같은 실물에 겹치는 기간을 배정하지 않는다.
    const allocations: Array<{
      itemId: string;
      pickup: [number, number];
      pickedUpAt: Date | null;
      returnedAt: Date | null;
      status: string;
    }> = [
      { itemId: jacketItem1, pickup: [3, 6], pickedUpAt: ts(2026, 3, 6), returnedAt: ts(2026, 3, 7), status: 'RETURNED' },
      { itemId: jacketItem2, pickup: [3, 10], pickedUpAt: ts(2026, 3, 10), returnedAt: null, status: 'PICKED_UP' },
      { itemId: trousersItem, pickup: [3, 11], pickedUpAt: ts(2026, 3, 11), returnedAt: null, status: 'PICKED_UP' },
      // 출고 전 배정 — 인기 품목 집계에 들어가면 안 된다.
      { itemId: jacketItem1, pickup: [4, 1], pickedUpAt: null, returnedAt: null, status: 'RESERVED' },
    ];
    for (const a of allocations) {
      const [month, day] = a.pickup;
      await ctx.prisma.rentalAllocation.create({
        data: {
          id: randomUUID(),
          orderItemComponentId: componentId,
          rentalInventoryItemId: a.itemId,
          pickupDate: dbDate(2026, month, day),
          returnDueDate: dbDate(2026, month, day + 1),
          availabilityEndDate: dbDate(2026, month, day + 2),
          actualPickupAt: a.pickedUpAt,
          actualReturnAt: a.returnedAt,
          status: a.status,
          assignedBy: adminId,
          assignedAt: ts(2026, 3, 1),
        },
      });
    }

    // --- 수선 (@db.Date 컬럼) ---
    await ctx.prisma.repairRequest.create({
      data: {
        id: randomUUID(),
        customerId,
        repairType: 'GENERAL',
        requestDate: dbDate(2026, 3, 5),
        status: 'RECEIVED',
        description: '기장 수선',
      },
    });
    await ctx.prisma.repairRequest.create({
      data: {
        id: randomUUID(),
        customerId,
        repairType: 'AFTER_SALE',
        requestDate: dbDate(2026, 3, 5),
        status: 'CANCELLED',
        description: '취소된 접수',
      },
    });

    // --- 옵션 인기도 ---
    const fileId = randomUUID();
    await ctx.prisma.file.create({
      data: {
        id: fileId,
        storageKey: `stats-test/${fileId}`,
        originalName: 'choice.png',
        mimeType: 'image/png',
        sizeBytes: BigInt(1),
      },
    });
    const optionSet = await ctx.prisma.optionSet.findUniqueOrThrow({
      where: { productCategory: 'SUIT' },
    });
    const optionSetVersionId = randomUUID();
    await ctx.prisma.optionSetVersion.create({
      data: {
        id: optionSetVersionId,
        optionSetId: optionSet.id,
        versionNo: 1,
        status: 'ACTIVE',
        createdBy: adminId,
      },
    });
    // 활성 버전이어야 선택지 전체 목록의 기준이 된다.
    await ctx.prisma.optionSet.update({
      where: { id: optionSet.id },
      data: { activeVersionId: optionSetVersionId },
    });
    const stageId = randomUUID();
    await ctx.prisma.optionStage.create({
      data: {
        id: stageId,
        optionSetVersionId,
        stageCode: 'LAPEL',
        stageName: '라펠 디자인',
        sequenceNo: 1,
        componentGroup: 'JACKET',
      },
    });
    // 하의 단계도 하나 둔다 — 구성품으로 갈라 조회되는지 확인용
    const trousersStageId = randomUUID();
    await ctx.prisma.optionStage.create({
      data: {
        id: trousersStageId,
        optionSetVersionId,
        stageCode: 'TROUSERS_FIT',
        stageName: '바지 디자인',
        sequenceNo: 2,
        componentGroup: 'TROUSERS',
      },
    });
    await ctx.prisma.optionChoice.create({
      data: {
        id: randomUUID(),
        optionStageId: trousersStageId,
        choiceCode: 'A',
        choiceName: '노턱',
        imageFileId: fileId,
      },
    });
    // 선택지 3개 중 C는 아무도 고르지 않는다 — 0건도 목록에 남아야 한다.
    const choiceIds = { A: randomUUID(), B: randomUUID(), C: randomUUID() };
    await ctx.prisma.optionChoice.createMany({
      data: [
        {
          id: choiceIds.A,
          optionStageId: stageId,
          choiceCode: 'A',
          choiceName: '노치드',
          imageFileId: fileId,
        },
        {
          id: choiceIds.B,
          optionStageId: stageId,
          choiceCode: 'B',
          choiceName: '피크드',
          imageFileId: fileId,
        },
        {
          id: choiceIds.C,
          optionStageId: stageId,
          choiceCode: 'C',
          choiceName: '숄',
          imageFileId: fileId,
        },
      ],
    });
    // 확정 세션 3건 (A 2건 / B 1건) + 미확정 세션 1건.
    // 옵션 추가금액은 2건에만 붙는다 — 반영일(surchargeAppliedAt) 기준으로 매출 지표에 들어간다.
    const sessionChoices: Array<{
      optionChoiceId: string;
      confirmedAt: Date | null;
      surcharge?: { amount: number; appliedAt: Date };
    }> = [
      {
        optionChoiceId: choiceIds.A,
        confirmedAt: ts(2026, 3, 6),
        surcharge: { amount: 150_000, appliedAt: ts(2026, 3, 6) },
      },
      {
        optionChoiceId: choiceIds.A,
        confirmedAt: ts(2026, 3, 7),
        surcharge: { amount: 200_000, appliedAt: ts(2026, 3, 7) },
      },
      { optionChoiceId: choiceIds.B, confirmedAt: ts(2026, 3, 7) },
      { optionChoiceId: choiceIds.A, confirmedAt: null },
    ];
    for (let i = 0; i < sessionChoices.length; i += 1) {
      const { optionChoiceId, confirmedAt, surcharge } = sessionChoices[i];
      const sessionId = randomUUID();
      await ctx.prisma.optionSelectionSession.create({
        data: {
          id: sessionId,
          contractItemId: contractItemIds[i],
          optionSetVersionId,
          selectionVersionNo: 1,
          status: confirmedAt ? 'CONFIRMED' : 'IN_PROGRESS',
          confirmedAt,
          isCurrent: true,
          ...(surcharge
            ? { surchargeApplied: surcharge.amount, surchargeAppliedAt: surcharge.appliedAt }
            : {}),
        },
      });
      await ctx.prisma.optionSelectionValue.create({
        data: {
          id: randomUUID(),
          selectionSessionId: sessionId,
          optionStageId: stageId,
          optionChoiceId,
          selectedBy: adminId,
        },
      });
    }
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe('예약 건수 — 버킷 단위', () => {
    it('일 단위는 기간 안의 모든 날짜를 0으로 채워 반환한다', async () => {
      const data = await counts({
        metric: 'APPOINTMENT',
        granularity: 'DAY',
        from: '2026-03-02',
        to: '2026-03-09',
      });
      expect(data.buckets).toHaveLength(8);
      expect(data.buckets[0]).toMatchObject({ period: '2026-03-02', total: purposeCodes.length });
      expect(data.buckets[1]).toMatchObject({ period: '2026-03-03', total: 0 });
      expect(data.buckets[6]).toMatchObject({ period: '2026-03-08', total: 1 });
      expect(data.buckets[7]).toMatchObject({ period: '2026-03-09', total: 1 });
      expect(data.total).toBe(purposeCodes.length + 2);
    });

    it('주 단위는 월요일 시작으로 접는다 (같은 주 일요일은 앞 버킷에 들어간다)', async () => {
      const data = await counts({
        metric: 'APPOINTMENT',
        granularity: 'WEEK',
        from: '2026-03-02',
        to: '2026-03-15',
      });
      expect(data.buckets.map((b) => b.period)).toEqual(['2026-03-02', '2026-03-09']);
      expect(data.buckets[0].total).toBe(purposeCodes.length + 1); // 3/2 전체 + 3/8(일요일)
      expect(data.buckets[1].total).toBe(1); // 3/9
    });

    it('월 단위는 1일 시작 한 칸으로 접고 취소 예약은 세지 않는다', async () => {
      const data = await counts({
        metric: 'APPOINTMENT',
        granularity: 'MONTH',
        from: '2026-03-01',
        to: '2026-03-31',
      });
      expect(data.buckets).toHaveLength(1);
      expect(data.buckets[0].period).toBe('2026-03-01');
      // 3/10 취소 예약은 제외 → 목적별 1건씩 + 3/8 + 3/9
      expect(data.buckets[0].total).toBe(purposeCodes.length + 2);
    });
  });

  describe('예약 건수 — 계열 분해', () => {
    it('분해하지 않으면 합계 1계열만 반환한다', async () => {
      const data = await counts({
        metric: 'APPOINTMENT',
        granularity: 'DAY',
        from: '2026-03-02',
        to: '2026-03-02',
        breakdown: 'false',
      });
      expect(data.series).toEqual([{ key: 'TOTAL', label: '합계', colorIndex: 0 }]);
      expect(data.buckets[0].values).toEqual({ TOTAL: purposeCodes.length });
    });

    it('계열이 색 슬롯 상한을 넘으면 상위 7종만 남기고 기타로 접는다', async () => {
      const data = await counts({
        metric: 'APPOINTMENT',
        granularity: 'DAY',
        from: '2026-03-02',
        to: '2026-03-02',
        breakdown: 'true',
      });
      expect(data.series).toHaveLength(8);
      // 색 슬롯은 0..6이 순서대로 배정되고 기타만 -1이다.
      expect(data.series.slice(0, 7).map((s) => s.colorIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      const other = data.series[7];
      expect(other.key).toBe('__OTHER__');
      expect(other.colorIndex).toBe(-1);
      expect(other.label).toBe(`기타 ${purposeCodes.length - 7}종`);
      // 접힌 계열의 건수가 기타로 합산되어 합계가 보존된다.
      expect(data.buckets[0].values['__OTHER__']).toBe(purposeCodes.length - 7);
      const summed = Object.values(data.buckets[0].values).reduce((a, b) => a + b, 0);
      expect(summed).toBe(purposeCodes.length);
    });

    it('남는 계열의 색 슬롯은 마스터 정렬 순서를 따른다', async () => {
      const data = await counts({
        metric: 'APPOINTMENT',
        granularity: 'DAY',
        from: '2026-03-02',
        to: '2026-03-02',
        breakdown: 'true',
      });
      expect(data.series.slice(0, 7).map((s) => s.key)).toEqual(purposeCodes.slice(0, 7));
    });
  });

  describe('계약·계약 품목', () => {
    it('계약은 확정일 기준으로 세고 취소 계약을 제외한다', async () => {
      const data = await counts({
        metric: 'CONTRACT',
        granularity: 'DAY',
        from: '2026-03-06',
        to: '2026-03-06',
        breakdown: 'true',
      });
      expect(data.total).toBe(1);
      expect(data.basis).toContain('계약 확정일');
    });

    it('계약 품목은 현재 버전 계약줄의 수량 합이다', async () => {
      const data = await counts({
        metric: 'CONTRACT_ITEM',
        granularity: 'DAY',
        from: '2026-03-06',
        to: '2026-03-06',
        breakdown: 'true',
      });
      // 정장 2 + 구두 1 (취소 계약의 정장 5는 제외)
      expect(data.total).toBe(3);
      const values = data.buckets[0].values;
      expect(values.SUIT).toBe(2);
      expect(values.SHOES).toBe(1);
    });
  });

  describe('매출(금액) 지표', () => {
    it('계약 매출은 확정 계약의 총 금액 합이고 취소 계약 금액은 새지 않는다', async () => {
      const data = await counts({
        metric: 'CONTRACT_AMOUNT',
        granularity: 'DAY',
        from: '2026-03-06',
        to: '2026-03-06',
      });
      expect(data.valueKind).toBe('AMOUNT');
      expect(data.total).toBe(3_350_000); // 취소 계약 9,999,000 제외
      expect(data.sourceCount).toBe(1); // 건당 평균 = 3,350,000
      expect(data.buckets[0].values).toEqual({ TOTAL: 3_350_000 });
    });

    it('계약 매출을 계약 구분별로 쪼갤 수 있다', async () => {
      const data = await counts({
        metric: 'CONTRACT_AMOUNT',
        granularity: 'DAY',
        from: '2026-03-06',
        to: '2026-03-06',
        breakdown: 'true',
      });
      // 시드 계약 구분을 붙이지 않았으므로 '구분 미지정' 한 계열로 모인다.
      expect(data.series).toHaveLength(1);
      expect(data.series[0]).toMatchObject({ key: 'UNSPECIFIED', label: '구분 미지정' });
      expect(data.total).toBe(3_350_000);
    });

    it('품목별 매출은 계약줄 금액에 옵션 추가금액을 별도 항목으로 더한다', async () => {
      const data = await counts({
        metric: 'CONTRACT_ITEM_AMOUNT',
        granularity: 'DAY',
        from: '2026-03-06',
        to: '2026-03-06',
        breakdown: 'true',
      });
      expect(data.valueKind).toBe('AMOUNT');
      // 정장 2,000,000 + 구두 1,000,000 + 옵션(150,000+200,000)
      expect(data.buckets[0].values).toMatchObject({
        SUIT: 2_000_000,
        SHOES: 1_000_000,
        __OPTION__: 350_000,
      });
      expect(data.total).toBe(3_350_000);
      // 계약줄 2줄 + 옵션 추가금액이 붙은 세션 2건
      expect(data.sourceCount).toBe(4);
    });

    it("'옵션' 계열은 품목 뒤에 오고 색 슬롯도 품목 다음을 받는다", async () => {
      const data = await counts({
        metric: 'CONTRACT_ITEM_AMOUNT',
        granularity: 'DAY',
        from: '2026-03-06',
        to: '2026-03-06',
        breakdown: 'true',
      });
      const last = data.series[data.series.length - 1];
      expect(last).toMatchObject({ key: '__OPTION__', label: '옵션' });
      // '기타' 묶음이 아니라 정식 계열이므로 colorIndex가 음수가 아니다.
      expect(last.colorIndex).toBeGreaterThanOrEqual(0);
    });

    it('옵션 추가금액은 반영 시각이 아니라 계약 확정일 버킷에 들어간다', async () => {
      // 세션 추가금액 반영일은 3/6·3/7이지만 계약 확정일은 3/6이다.
      const data = await counts({
        metric: 'CONTRACT_ITEM_AMOUNT',
        granularity: 'DAY',
        from: '2026-03-06',
        to: '2026-03-07',
        breakdown: 'true',
      });
      expect(data.buckets[0].values.__OPTION__).toBe(350_000); // 3/6에 전액
      expect(data.buckets[1].values.__OPTION__).toBe(0); // 3/7은 0
    });

    /**
     * total_amount는 수기 입력값이고 옵션 확정 시 increment된다(option-sessions.service).
     * 시스템이 `total_amount = Σ line_amount + Σ surcharge`를 보장하지 않으므로
     * 두 지표가 반드시 같지는 않다. 이 픽스처는 일치하도록 맞춰 둔 경우다.
     */
    it('이 픽스처에서는 계약 매출과 품목별 매출 합계가 맞는다', async () => {
      const range = { granularity: 'DAY' as const, from: '2026-03-01', to: '2026-03-31' };
      const byContract = await counts({ metric: 'CONTRACT_AMOUNT', ...range });
      const byItem = await counts({ metric: 'CONTRACT_ITEM_AMOUNT', ...range });
      expect(byItem.total).toBe(byContract.total);
      expect(byItem.basis).toContain('수기 입력값이라 이 합계와 다를 수 있다');
    });

    it('추가금액이 반영되지 않은 세션은 옵션 항목에 넣지 않는다', async () => {
      const data = await counts({
        metric: 'CONTRACT_ITEM_AMOUNT',
        granularity: 'MONTH',
        from: '2026-03-01',
        to: '2026-03-31',
        breakdown: 'true',
      });
      // 확정 3건 중 추가금액이 붙은 2건만 (0원 세션·미확정 세션은 제외)
      expect(data.buckets[0].values.__OPTION__).toBe(350_000);
    });

    it('건수 지표는 valueKind가 COUNT다', async () => {
      const data = await counts({
        metric: 'CONTRACT',
        granularity: 'DAY',
        from: '2026-03-06',
        to: '2026-03-06',
      });
      expect(data.valueKind).toBe('COUNT');
    });
  });

  describe('입출고·렌탈 — 계열 고정 지표', () => {
    it('제작 입고·출고는 분해 여부와 무관하게 두 계열을 반환한다', async () => {
      for (const breakdown of ['true', 'false']) {
        const data = await counts({
          metric: 'PRODUCTION_FLOW',
          granularity: 'DAY',
          from: '2026-03-06',
          to: '2026-03-07',
          breakdown,
        });
        expect(data.series.map((s) => s.key)).toEqual(['INBOUND', 'OUTBOUND']);
        expect(data.buckets[0].values).toEqual({ INBOUND: 1, OUTBOUND: 0 });
        expect(data.buckets[1].values).toEqual({ INBOUND: 0, OUTBOUND: 1 });
      }
    });

    it('렌탈은 실제 출고일·반납일로 각각 센다', async () => {
      const data = await counts({
        metric: 'RENTAL_FLOW',
        granularity: 'DAY',
        from: '2026-03-06',
        to: '2026-03-07',
      });
      expect(data.series.map((s) => s.key)).toEqual(['PICKUP', 'RETURN']);
      expect(data.buckets[0].values).toEqual({ PICKUP: 1, RETURN: 0 });
      expect(data.buckets[1].values).toEqual({ PICKUP: 0, RETURN: 1 });
    });
  });

  describe('수선 — @db.Date 컬럼 경계', () => {
    it('접수일이 속한 날짜에만 잡히고 앞뒤 날짜로 밀리지 않는다', async () => {
      const onDay = await counts({
        metric: 'REPAIR',
        granularity: 'DAY',
        from: '2026-03-05',
        to: '2026-03-05',
      });
      expect(onDay.total).toBe(1); // 취소 접수 1건은 제외

      for (const day of ['2026-03-04', '2026-03-06']) {
        const off = await counts({
          metric: 'REPAIR',
          granularity: 'DAY',
          from: day,
          to: day,
        });
        expect(off.total).toBe(0);
      }
    });
  });

  describe('입력 검증', () => {
    it('지원하지 않는 지표는 400', async () => {
      await api(ctx)
        .get('/api/v1/stats/counts?metric=NOPE&granularity=DAY&from=2026-03-01&to=2026-03-02')
        .set(auth(ctx))
        .expect(400);
    });

    it('존재하지 않는 날짜는 400', async () => {
      const res = await api(ctx)
        .get('/api/v1/stats/counts?metric=REPAIR&granularity=DAY&from=2026-02-30&to=2026-03-02')
        .set(auth(ctx))
        .expect(400);
      expect(res.body.error.message).toContain('시작일');
    });

    it('시작일이 종료일보다 늦으면 400', async () => {
      await api(ctx)
        .get('/api/v1/stats/counts?metric=REPAIR&granularity=DAY&from=2026-05-01&to=2026-01-01')
        .set(auth(ctx))
        .expect(400);
    });

    it('버킷 상한을 넘는 기간은 400', async () => {
      const res = await api(ctx)
        .get('/api/v1/stats/counts?metric=REPAIR&granularity=DAY&from=2020-01-01&to=2026-03-01')
        .set(auth(ctx))
        .expect(400);
      expect(res.body.error.message).toContain('기간이 너무 넓습니다');
    });
  });

  describe('구성품별 인기 옵션', () => {
    const optionPopularity = async (componentType: string, from = '2026-03-01', to = '2026-03-31') => {
      const res = await api(ctx)
        .get(
          `/api/v1/stats/option-popularity?componentType=${componentType}&from=${from}&to=${to}`,
        )
        .set(auth(ctx))
        .expect(200);
      return res.body.data;
    };

    it('확정 세션만 세고 선택지는 많이 선택된 순으로 준다', async () => {
      const data = await optionPopularity('JACKET');
      expect(data.sessionCount).toBe(3); // 미확정 세션 1건 제외
      expect(data.stages).toHaveLength(1);
      const stage = data.stages[0];
      expect(stage.stageCode).toBe('LAPEL');
      expect(stage.componentGroup).toBe('JACKET');
      expect(stage.total).toBe(3);
      expect(stage.choices.map((c: { choiceCode: string }) => c.choiceCode)).toEqual(['A', 'B', 'C']);
    });

    it('아무도 고르지 않은 선택지도 0건으로 목록에 남는다', async () => {
      const data = await optionPopularity('JACKET');
      expect(data.stages[0].choices).toEqual([
        { choiceCode: 'A', choiceName: '노치드', count: 2, share: 66.7, retired: false },
        { choiceCode: 'B', choiceName: '피크드', count: 1, share: 33.3, retired: false },
        { choiceCode: 'C', choiceName: '숄', count: 0, share: 0, retired: false },
      ]);
    });

    it('구성품으로 단계를 갈라 준다 (상의 선택 시 하의 단계는 나오지 않는다)', async () => {
      const jacket = await optionPopularity('JACKET');
      const trousers = await optionPopularity('TROUSERS');
      expect(jacket.stages.map((s: { stageCode: string }) => s.stageCode)).toEqual(['LAPEL']);
      expect(trousers.stages.map((s: { stageCode: string }) => s.stageCode)).toEqual([
        'TROUSERS_FIT',
      ]);
    });

    it('선택 이력이 없는 구성품도 선택지 목록은 0건으로 채워 준다', async () => {
      const data = await optionPopularity('TROUSERS');
      expect(data.sessionCount).toBe(0);
      expect(data.stages[0].total).toBe(0);
      expect(data.stages[0].choices).toEqual([
        { choiceCode: 'A', choiceName: '노턱', count: 0, share: 0, retired: false },
      ]);
    });

    it('기간 밖이면 건수만 0이고 선택지 목록은 그대로다', async () => {
      const data = await optionPopularity('JACKET', '2026-01-01', '2026-01-31');
      expect(data.sessionCount).toBe(0);
      expect(data.stages[0].choices).toHaveLength(3);
      expect(data.stages[0].choices.every((c: { count: number }) => c.count === 0)).toBe(true);
    });

    it('옵션 단계가 없는 구성품 코드는 400', async () => {
      await api(ctx)
        .get('/api/v1/stats/option-popularity?componentType=HAT&from=2026-03-01&to=2026-03-31')
        .set(auth(ctx))
        .expect(400);
    });
  });

  describe('렌탈 출고 인기 품목', () => {
    it('출고된 배정을 SKU별로 묶어 많이 나간 순으로 준다', async () => {
      const res = await api(ctx)
        .get('/api/v1/stats/rental-popularity?from=2026-03-01&to=2026-03-31&limit=5')
        .set(auth(ctx))
        .expect(200);
      const data = res.body.data;
      // 상의 블랙 48이 2건(3/6·3/10), 하의 그레이 82가 1건
      expect(data.total).toBe(3);
      expect(data.rows).toHaveLength(2);
      expect(data.rows[0]).toMatchObject({
        componentType: 'JACKET',
        color: 'BLACK',
        size: '48',
        count: 2,
        share: 66.7,
      });
      expect(data.rows[1]).toMatchObject({ componentType: 'TROUSERS', count: 1, share: 33.3 });
      expect(data.omittedSkus).toBe(0);
    });

    it('limit 밖 SKU 종류 수를 omittedSkus로 알린다', async () => {
      const res = await api(ctx)
        .get('/api/v1/stats/rental-popularity?from=2026-03-01&to=2026-03-31&limit=1')
        .set(auth(ctx))
        .expect(200);
      expect(res.body.data.rows).toHaveLength(1);
      expect(res.body.data.omittedSkus).toBe(1);
      // 상위 N개를 잘라도 total은 기간 전체 출고 건수를 유지한다.
      expect(res.body.data.total).toBe(3);
    });

    it('구성품으로 좁혀 볼 수 있다', async () => {
      const res = await api(ctx)
        .get('/api/v1/stats/rental-popularity?from=2026-03-01&to=2026-03-31&componentType=TROUSERS')
        .set(auth(ctx))
        .expect(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.rows).toHaveLength(1);
      expect(res.body.data.rows[0].componentType).toBe('TROUSERS');
    });

    it('출고 전 배정(actualPickupAt 없음)은 세지 않는다', async () => {
      const res = await api(ctx)
        .get('/api/v1/stats/rental-popularity?from=2026-04-01&to=2026-04-30')
        .set(auth(ctx))
        .expect(200);
      expect(res.body.data.total).toBe(0);
      expect(res.body.data.rows).toEqual([]);
    });
  });
});
