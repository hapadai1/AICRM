import { randomUUID } from 'crypto';
import ExcelJS from 'exceljs';
import * as fs from 'fs';
import JSZip from 'jszip';
import * as path from 'path';
import { WorkOrdersModule } from '../../backend/src/modules/work-orders/work-orders.module';
import { api, auth, createTestContext, TestContext, truncateBusinessData } from './helpers';

/** 서비스와 동일한 규칙으로 저장 경로를 계산한다 (FILE_STORAGE_PATH 기준). */
function storagePath(storageKey: string): string {
  return path.resolve(process.env.FILE_STORAGE_PATH ?? './storage', storageKey);
}

interface Fixture {
  customerId: string;
  contractId: string;
  orderId: string;
  orderNo: string;
  orderItemId: string;
  optionSessionId: string | null;
  measurementSessionId: string | null;
}

describe('작업지시서 (Phase 4: Excel 출력·버전·스냅샷)', () => {
  let ctx: TestContext;
  let adminId: string;
  let optionSetVersionId: string;
  let stageLapelId: string;
  let stageVentId: string;
  let choiceLapelId: string;
  let choiceVentId: string;
  let seq = 0;

  /** 옵션 세트 버전·단계·선택지 공용 구성 (SUIT 시드 option_set 재사용) */
  async function createOptionStructure(): Promise<void> {
    const imageFile = await ctx.prisma.file.create({
      data: {
        id: randomUUID(),
        storageKey: `test-images/${randomUUID()}.png`,
        originalName: 'choice.png',
        mimeType: 'image/png',
        sizeBytes: BigInt(10),
      },
    });
    const optionSet = await ctx.prisma.optionSet.findUniqueOrThrow({
      where: { productCategory: 'SUIT' },
    });
    optionSetVersionId = randomUUID();
    await ctx.prisma.optionSetVersion.create({
      data: {
        id: optionSetVersionId,
        optionSetId: optionSet.id,
        versionNo: 1,
        status: 'ACTIVE',
        createdBy: adminId,
      },
    });
    stageLapelId = randomUUID();
    stageVentId = randomUUID();
    await ctx.prisma.optionStage.createMany({
      data: [
        { id: stageLapelId, optionSetVersionId, stageCode: 'LAPEL', stageName: '라펠', sequenceNo: 1 },
        { id: stageVentId, optionSetVersionId, stageCode: 'VENT', stageName: '벤트', sequenceNo: 2 },
      ],
    });
    choiceLapelId = randomUUID();
    choiceVentId = randomUUID();
    await ctx.prisma.optionChoice.createMany({
      data: [
        {
          id: choiceLapelId,
          optionStageId: stageLapelId,
          choiceCode: 'A',
          choiceName: '노치드 라펠',
          factoryLabel: 'LAPEL-A',
          imageFileId: imageFile.id,
        },
        {
          id: choiceVentId,
          optionStageId: stageVentId,
          choiceCode: 'B',
          choiceName: '사이드 벤트',
          factoryLabel: 'VENT-B',
          imageFileId: imageFile.id,
        },
      ],
    });
  }

  /** 고객→계약→주문→품목→옵션 세션→채촌 세션·연결 전체 데이터 구성 */
  async function createFixture(
    opts: { confirmOption?: boolean; linkMeasurement?: boolean; productCategory?: string } = {},
  ): Promise<Fixture> {
    const { confirmOption = true, linkMeasurement = true, productCategory = 'SUIT' } = opts;
    seq += 1;
    const n = String(seq).padStart(3, '0');

    const customer = await ctx.prisma.customer.create({
      data: {
        id: randomUUID(),
        name: `테스트고객${n}`,
        phone: `010-9000-${n}0`,
        phoneNormalized: `0109000${n}0`,
        customerStatus: 'CONTRACTED',
      },
    });
    const contract = await ctx.prisma.contract.create({
      data: {
        id: randomUUID(),
        contractNo: `CTR-TEST-${n}`,
        customerId: customer.id,
        status: 'CONFIRMED',
        contractedAt: new Date(),
      },
    });
    const contractVersion = await ctx.prisma.contractVersion.create({
      data: {
        id: randomUUID(),
        contractId: contract.id,
        versionNo: 1,
        versionStatus: 'CONFIRMED',
        createdBy: adminId,
      },
    });
    const contractLine = await ctx.prisma.contractLine.create({
      data: {
        id: randomUUID(),
        contractVersionId: contractVersion.id,
        transactionType: 'CUSTOM',
        productCategory,
        quantity: 1,
      },
    });
    const order = await ctx.prisma.order.create({
      data: {
        id: randomUUID(),
        orderNo: `ORD-TEST-${n}`,
        contractId: contract.id,
        transactionType: 'CUSTOM',
      },
    });
    const orderItem = await ctx.prisma.orderItem.create({
      data: {
        id: randomUUID(),
        orderId: order.id,
        sourceContractLineId: contractLine.id,
        productCategory,
        sequenceNo: 1,
        displayName: productCategory === 'SHOES' ? '구두 #1' : '정장 #1',
      },
    });

    let optionSessionId: string | null = null;
    if (confirmOption) {
      optionSessionId = randomUUID();
      await ctx.prisma.optionSelectionSession.create({
        data: {
          id: optionSessionId,
          orderItemId: orderItem.id,
          optionSetVersionId,
          selectionVersionNo: 1,
          status: 'CONFIRMED',
          fabricName: 'Zegna Navy 1201',
          confirmedAt: new Date(),
          isCurrent: true,
        },
      });
      await ctx.prisma.optionSelectionValue.createMany({
        data: [
          {
            id: randomUUID(),
            selectionSessionId: optionSessionId,
            optionStageId: stageLapelId,
            optionChoiceId: choiceLapelId,
            selectedBy: adminId,
          },
          {
            id: randomUUID(),
            selectionSessionId: optionSessionId,
            optionStageId: stageVentId,
            optionChoiceId: choiceVentId,
            selectedBy: adminId,
          },
        ],
      });
    }

    let measurementSessionId: string | null = null;
    if (linkMeasurement) {
      measurementSessionId = await createAndLinkMeasurement(customer.id, orderItem.id, 1, 98.5);
    }

    return {
      customerId: customer.id,
      contractId: contract.id,
      orderId: order.id,
      orderNo: order.orderNo,
      orderItemId: orderItem.id,
      optionSessionId,
      measurementSessionId,
    };
  }

  /** 채촌 세션 생성 + 품목 현재 연결 (기존 연결은 is_current 해제) */
  async function createAndLinkMeasurement(
    customerId: string,
    orderItemId: string,
    versionNo: number,
    chestValue: number,
  ): Promise<string> {
    const sessionId = randomUUID();
    await ctx.prisma.measurementSession.create({
      data: {
        id: sessionId,
        customerId,
        versionNo,
        measurementDate: new Date('2026-07-01'),
        measurementType: versionNo === 1 ? 'INITIAL' : 'REMEASURE',
        createdBy: adminId,
      },
    });
    await ctx.prisma.measurementValue.createMany({
      data: [
        {
          id: randomUUID(),
          measurementSessionId: sessionId,
          bodySection: 'UPPER',
          measurementCode: 'CHEST',
          numericValue: chestValue,
          unit: 'CM',
          sortOrder: 1,
        },
        {
          id: randomUUID(),
          measurementSessionId: sessionId,
          bodySection: 'LOWER',
          measurementCode: 'WAIST',
          numericValue: 84,
          unit: 'CM',
          sortOrder: 2,
        },
        {
          id: randomUUID(),
          measurementSessionId: sessionId,
          bodySection: 'UPPER',
          measurementCode: 'SLEEVE',
          numericValue: 61.5,
          unit: 'CM',
          sortOrder: 3,
        },
      ],
    });
    await ctx.prisma.orderItemMeasurement.updateMany({
      where: { orderItemId },
      data: { isCurrent: false },
    });
    await ctx.prisma.orderItemMeasurement.create({
      data: {
        id: randomUUID(),
        orderItemId,
        measurementSessionId: sessionId,
        isCurrent: true,
        linkedBy: adminId,
      },
    });
    return sessionId;
  }

  beforeAll(async () => {
    ctx = await createTestContext([WorkOrdersModule]);
    await truncateBusinessData(ctx.prisma);
    const admin = await ctx.prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
    adminId = admin.id;
    await createOptionStructure();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe('전제 검증', () => {
    it('옵션 미확정·채촌 미연결이면 미리보기가 422 WORK_ORDER_PREREQUISITE_MISSING', async () => {
      const fixture = await createFixture({ confirmOption: false, linkMeasurement: false });
      const res = await api(ctx)
        .get(`/api/v1/order-items/${fixture.orderItemId}/work-order/preview`)
        .set(auth(ctx))
        .expect(422);
      expect(res.body.error.code).toBe('WORK_ORDER_PREREQUISITE_MISSING');
      expect(res.body.error.details.missing).toEqual(
        expect.arrayContaining(['OPTION_SESSION_CONFIRMED', 'MEASUREMENT_LINKED']),
      );
    });

    it('전제 미충족 시 Excel 출력도 422로 차단된다', async () => {
      const fixture = await createFixture({ confirmOption: true, linkMeasurement: false });
      const res = await api(ctx)
        .post(`/api/v1/order-items/${fixture.orderItemId}/work-order-versions`)
        .set(auth(ctx))
        .send({ note: '출력 시도' })
        .expect(422);
      expect(res.body.error.code).toBe('WORK_ORDER_PREREQUISITE_MISSING');
      expect(res.body.error.details.missing).toEqual(['MEASUREMENT_LINKED']);
    });
  });

  describe('미리보기·출력·버전', () => {
    let fixture: Fixture;
    let workOrderId: string;
    let v1Id: string;
    let v2Id: string;

    beforeAll(async () => {
      fixture = await createFixture();
    });

    it('미리보기는 확정 옵션(단계명·선택 옵션명·원단)과 채촌 값을 반환한다', async () => {
      const res = await api(ctx)
        .get(`/api/v1/order-items/${fixture.orderItemId}/work-order/preview`)
        .set(auth(ctx))
        .expect(200);
      const data = res.body.data;
      expect(data.orderNo).toBe(fixture.orderNo);
      expect(data.fabricName).toBe('Zegna Navy 1201');
      expect(data.status).toBe('UNORDERED');
      expect(data.option.stages).toEqual([
        expect.objectContaining({ stageName: '라펠', choiceName: '노치드 라펠', sequenceNo: 1 }),
        expect.objectContaining({ stageName: '벤트', choiceName: '사이드 벤트', sequenceNo: 2 }),
      ]);
      expect(data.measurement.values).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ measurementCode: 'CHEST', value: 98.5, unit: 'CM' }),
          expect.objectContaining({ measurementCode: 'WAIST', value: 84 }),
        ]),
      );
    });

    it('양식 미리보기는 출력 전 값이 채워진 HTML을 주고 버전을 만들지 않는다', async () => {
      const res = await api(ctx)
        .get(`/api/v1/order-items/${fixture.orderItemId}/work-order/form-preview`)
        .set(auth(ctx))
        .expect(200);
      const { html, versionNo } = res.body.data;
      // 아직 출력 전이므로 "다음에 붙을 버전"을 알려준다
      expect(versionNo).toBe(1);
      expect(html).toContain('테스트고객');
      expect(html).toContain('Zegna Navy 1201');

      // 미리보기만으로는 작업지시서·버전이 생기지 않는다
      const after = await api(ctx)
        .get(`/api/v1/order-items/${fixture.orderItemId}/work-order/preview`)
        .set(auth(ctx))
        .expect(200);
      expect(after.body.data.workOrderId).toBeNull();
      expect(after.body.data.currentVersionNo).toBeNull();
    });

    it('미리보기는 채촌 후보 목록을 함께 주고, measurementSessionId로 다른 버전을 미리볼 수 있다', async () => {
      // 같은 고객의 다른 채촌 버전 (연결은 다시 원래 버전으로 되돌린다)
      const otherSessionId = await createAndLinkMeasurement(
        fixture.customerId,
        fixture.orderItemId,
        90,
        101.5,
      );
      await ctx.prisma.orderItemMeasurement.updateMany({
        where: { orderItemId: fixture.orderItemId },
        data: { isCurrent: false },
      });
      await ctx.prisma.orderItemMeasurement.updateMany({
        where: { orderItemId: fixture.orderItemId, measurementSessionId: fixture.measurementSessionId! },
        data: { isCurrent: true },
      });

      const linked = await api(ctx)
        .get(`/api/v1/order-items/${fixture.orderItemId}/work-order/preview`)
        .set(auth(ctx))
        .expect(200);
      expect(linked.body.data.measurement.measurementSessionId).toBe(fixture.measurementSessionId);
      expect(linked.body.data.measurement.isLinked).toBe(true);
      expect(linked.body.data.measurementCandidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ measurementSessionId: otherSessionId, isLinked: false }),
          expect.objectContaining({
            measurementSessionId: fixture.measurementSessionId,
            isLinked: true,
          }),
        ]),
      );

      const switched = await api(ctx)
        .get(
          `/api/v1/order-items/${fixture.orderItemId}/work-order/preview?measurementSessionId=${otherSessionId}`,
        )
        .set(auth(ctx))
        .expect(200);
      expect(switched.body.data.measurement.measurementSessionId).toBe(otherSessionId);
      expect(switched.body.data.measurement.isLinked).toBe(false);
      expect(switched.body.data.measurement.values).toEqual(
        expect.arrayContaining([expect.objectContaining({ measurementCode: 'CHEST', value: 101.5 })]),
      );
    });

    it('다른 고객의 채촌 세션을 미리보기로 지정하면 404', async () => {
      const other = await createFixture();
      await api(ctx)
        .get(
          `/api/v1/order-items/${fixture.orderItemId}/work-order/preview?measurementSessionId=${other.measurementSessionId}`,
        )
        .set(auth(ctx))
        .expect(404);
    });

    it('출력 전에는 미주문(UNORDERED) 목록에 포함된다', async () => {
      const res = await api(ctx)
        .get('/api/v1/work-orders?status=UNORDERED')
        .set(auth(ctx))
        .expect(200);
      const row = res.body.data.find(
        (r: { orderItemId: string }) => r.orderItemId === fixture.orderItemId,
      );
      expect(row).toBeDefined();
      expect(row.status).toBe('UNORDERED');
      expect(row.customerName).toContain('테스트고객');
      expect(row.orderNo).toBe(fixture.orderNo);
      expect(row.itemLabel).toBe('정장 #1');
      expect(row.currentVersionNo).toBeNull();
    });

    it('첫 Excel 출력으로 V1이 생성되고 파일이 실제 저장된다', async () => {
      const res = await api(ctx)
        .post(`/api/v1/order-items/${fixture.orderItemId}/work-order-versions`)
        .set(auth(ctx))
        .send({ note: '최초 출력' })
        .expect(201);
      const data = res.body.data;
      expect(data.versionNo).toBe(1);
      expect(data.workOrderId).toBeDefined();
      expect(data.workOrderVersionId).toBeDefined();
      expect(data.file.fileName).toBe(`${fixture.orderNo}_SUIT-01_V1.xlsx`);
      expect(data.file.downloadUrl).toBe(`/api/v1/files/${data.file.id}`);
      workOrderId = data.workOrderId;
      v1Id = data.workOrderVersionId;

      const version = await ctx.prisma.workOrderVersion.findUniqueOrThrow({
        where: { id: v1Id },
        include: { outputFile: true },
      });
      expect(version.status).toBe('ISSUED');
      expect(version.sourceHash).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.existsSync(storagePath(version.outputFile.storageKey))).toBe(true);

      const workOrder = await ctx.prisma.workOrder.findUniqueOrThrow({
        where: { orderItemId: fixture.orderItemId },
      });
      expect(workOrder.currentVersionId).toBe(v1Id);

      // 출력 감사로그 (action=EXPORT)
      const auditRows = await ctx.prisma.auditLog.findMany({
        where: { action: 'EXPORT', entityId: v1Id },
      });
      expect(auditRows).toHaveLength(1);
    });

    it('스냅샷에 옵션명·치수가 보존된다', async () => {
      const version = await ctx.prisma.workOrderVersion.findUniqueOrThrow({ where: { id: v1Id } });
      const optionSnapshot = version.optionSnapshot as {
        fabricName: string;
        stages: Array<{ stageName: string; choiceName: string }>;
      };
      const measurementSnapshot = version.measurementSnapshot as {
        versionNo: number;
        measurementDate: string;
        values: Array<{ measurementCode: string; value: number | null }>;
      };
      expect(optionSnapshot.fabricName).toBe('Zegna Navy 1201');
      expect(optionSnapshot.stages).toEqual([
        expect.objectContaining({ stageName: '라펠', choiceName: '노치드 라펠' }),
        expect.objectContaining({ stageName: '벤트', choiceName: '사이드 벤트' }),
      ]);
      expect(measurementSnapshot.versionNo).toBe(1);
      expect(measurementSnapshot.measurementDate).toBe('2026-07-01');
      expect(measurementSnapshot.values).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ measurementCode: 'CHEST', value: 98.5 }),
          expect.objectContaining({ measurementCode: 'SLEEVE', value: 61.5 }),
        ]),
      );
    });

    it('출력 후에는 미주문 목록에서 제외되고 CURRENT로 판정된다', async () => {
      const unordered = await api(ctx)
        .get('/api/v1/work-orders?status=UNORDERED')
        .set(auth(ctx))
        .expect(200);
      expect(
        unordered.body.data.some(
          (r: { orderItemId: string }) => r.orderItemId === fixture.orderItemId,
        ),
      ).toBe(false);

      const current = await api(ctx)
        .get('/api/v1/work-orders?status=CURRENT')
        .set(auth(ctx))
        .expect(200);
      const row = current.body.data.find(
        (r: { orderItemId: string }) => r.orderItemId === fixture.orderItemId,
      );
      expect(row).toBeDefined();
      expect(row.currentVersionNo).toBe(1);
    });

    it('채촌 재연결 후 재출력 필요(REPRINT_NEEDED)로 판정된다', async () => {
      await createAndLinkMeasurement(fixture.customerId, fixture.orderItemId, 2, 99.5);
      const res = await api(ctx)
        .get('/api/v1/work-orders?status=REPRINT_NEEDED')
        .set(auth(ctx))
        .expect(200);
      const row = res.body.data.find(
        (r: { orderItemId: string }) => r.orderItemId === fixture.orderItemId,
      );
      expect(row).toBeDefined();
      expect(row.status).toBe('REPRINT_NEEDED');
    });

    it('재출력 시 V2가 생성되고 이전 버전은 SUPERSEDED가 된다', async () => {
      const res = await api(ctx)
        .post(`/api/v1/order-items/${fixture.orderItemId}/work-order-versions`)
        .set(auth(ctx))
        .send({ note: '채촌 변경 반영 재출력' })
        .expect(201);
      expect(res.body.data.versionNo).toBe(2);
      v2Id = res.body.data.workOrderVersionId;

      const v1 = await ctx.prisma.workOrderVersion.findUniqueOrThrow({ where: { id: v1Id } });
      expect(v1.status).toBe('SUPERSEDED');
      const workOrder = await ctx.prisma.workOrder.findUniqueOrThrow({ where: { id: workOrderId } });
      expect(workOrder.currentVersionId).toBe(v2Id);

      const v2 = await ctx.prisma.workOrderVersion.findUniqueOrThrow({ where: { id: v2Id } });
      const snapshot = v2.measurementSnapshot as {
        versionNo: number;
        values: Array<{ measurementCode: string; value: number | null }>;
      };
      expect(snapshot.versionNo).toBe(2);
      expect(snapshot.values).toEqual(
        expect.arrayContaining([expect.objectContaining({ measurementCode: 'CHEST', value: 99.5 })]),
      );
    });

    it('출력 이력은 최신 버전부터 반환한다', async () => {
      const res = await api(ctx)
        .get(`/api/v1/work-orders/${workOrderId}/versions`)
        .set(auth(ctx))
        .expect(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0]).toEqual(
        expect.objectContaining({ versionNo: 2, status: 'ISSUED' }),
      );
      expect(res.body.data[1]).toEqual(
        expect.objectContaining({ versionNo: 1, status: 'SUPERSEDED' }),
      );
      expect(res.body.data[0].file.downloadUrl).toMatch(/^\/api\/v1\/files\//);
    });

    it('작업지시서 상세는 현재 버전과 판정 상태를 반환한다', async () => {
      const res = await api(ctx)
        .get(`/api/v1/work-orders/${workOrderId}`)
        .set(auth(ctx))
        .expect(200);
      expect(res.body.data.status).toBe('CURRENT');
      expect(res.body.data.currentVersion.versionNo).toBe(2);
      expect(res.body.data.customerName).toContain('테스트고객');
    });

    it('저장된 Excel 파일을 다운로드(스트리밍)한다', async () => {
      const res = await api(ctx)
        .get(`/api/v1/work-order-versions/${v2Id}/file`)
        .set(auth(ctx))
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers['content-type']).toContain(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      const body = res.body as Buffer;
      expect(body.length).toBeGreaterThan(0);
      // xlsx(zip) 시그니처 PK
      expect(body.subarray(0, 2).toString('utf8')).toBe('PK');
    });

    it('출력물의 도식(도형·이미지)은 템플릿 원본 바이트 그대로다', async () => {
      // ExcelJS는 도형(xdr:sp — 빨간 동그라미·지시선)을 못 다뤄 다시 쓰면 도식이 깨진다.
      // 드로잉·이미지 부품은 템플릿에서 그대로 옮겨 붙이므로 바이트가 같아야 한다.
      const templatePath = path.resolve(
        __dirname,
        '../../backend/src/modules/work-orders/templates/suit-work-order.xlsx',
      );
      const version = await ctx.prisma.workOrderVersion.findUniqueOrThrow({
        where: { id: v2Id },
        include: { outputFile: true },
      });
      const [template, produced] = await Promise.all([
        JSZip.loadAsync(fs.readFileSync(templatePath)),
        JSZip.loadAsync(fs.readFileSync(storagePath(version.outputFile.storageKey))),
      ]);
      const drawingParts = Object.keys(template.files).filter(
        (name) => name.startsWith('xl/drawings/') || name.startsWith('xl/media/'),
      );
      expect(drawingParts.length).toBeGreaterThan(0);
      for (const name of drawingParts) {
        if (template.files[name].dir) continue;
        const [expected, actual] = await Promise.all([
          template.files[name].async('nodebuffer'),
          produced.file(name)!.async('nodebuffer'),
        ]);
        expect({ name, equal: expected.equals(actual) }).toEqual({ name, equal: true });
      }
    });

    it('저장된 출력본을 양식 HTML로 미리본다', async () => {
      const res = await api(ctx)
        .get(`/api/v1/work-order-versions/${v2Id}/form-preview`)
        .set(auth(ctx))
        .expect(200);
      const { html, versionNo } = res.body.data;
      expect(versionNo).toBe(2);
      expect(html).toContain('<table');
      // 인쇄값·채운 값이 모두 표에 나타난다
      expect(html).toContain('슈트에이전시(강남본점)');
      expect(html).toContain('테스트고객');
      // 병합은 colspan/rowspan으로 옮긴다
      expect(html).toContain('colspan=');
      // 도식도 함께 그린다 — 그림(data URI) · 지시선(svg line) · 빨간 동그라미
      expect(html).toContain('<img src="data:image/');
      expect(html).toContain('<line ');
      expect(html).toContain('border-radius:50%');
    });

    it('출력물은 실물 공장 양식(송파) 템플릿에 값이 채워져 있다', async () => {
      const res = await api(ctx)
        .get(`/api/v1/work-order-versions/${v2Id}/file`)
        .set(auth(ctx))
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      const wb = new ExcelJS.Workbook();
      // exceljs 타입이 요구하는 Buffer와 supertest가 주는 Buffer 정의가 달라 우회한다.
      await wb.xlsx.load(res.body as unknown as ArrayBuffer);
      // 템플릿은 매장 원본 그대로라 치수 대조표 시트가 함께 있고, 출력 시 숨긴다.
      const ws = wb.getWorksheet('작업지시서 (송파)')!;
      expect(ws.state).toBe('visible');
      expect(wb.worksheets.filter((sheet) => sheet.state === 'visible')).toHaveLength(1);
      // 양식 서식이 살아 있어야 한다 (병합)
      expect(ws.model.merges.length).toBeGreaterThan(200);
      // 인쇄된 매장명은 그대로 두고 값 칸만 채운다
      expect(ws.getCell('L1').value).toBe('슈트에이전시(강남본점)');
      expect(String(ws.getCell('AP1').value)).toContain('테스트고객');
      // 채촌 WAIST → 하의 '허리' 행의 신체 열(F61)=cm, 완성(인치) 열(P61)=round(84/2.54,1) (설계서 05 §3)
      expect(String(ws.getCell('F61').value)).toBe('84');
      expect(Number(ws.getCell('P61').value)).toBeCloseTo(33.1, 1);
      // 양식에 칸이 없는 채촌 항목(CHEST·SLEEVE)은 버리지 않고 추가요청사항으로 옮긴다
      expect(String(ws.getCell('AA41').value)).toContain('[치수]');
    });
  });

  describe('동시성·멱등성', () => {
    it('row_version 불일치 시 409 VERSION_CONFLICT', async () => {
      const fixture = await createFixture();
      const res = await api(ctx)
        .post(`/api/v1/order-items/${fixture.orderItemId}/work-order-versions`)
        .set(auth(ctx))
        .send({ note: '충돌 테스트', version: 99 })
        .expect(409);
      expect(res.body.error.code).toBe('VERSION_CONFLICT');
    });

    it('동일 Idempotency-Key 재요청은 동일 응답을 반환하고 버전을 추가 생성하지 않는다', async () => {
      const fixture = await createFixture();
      const key = `wo-idem-${randomUUID()}`;
      const first = await api(ctx)
        .post(`/api/v1/order-items/${fixture.orderItemId}/work-order-versions`)
        .set(auth(ctx))
        .set('Idempotency-Key', key)
        .send({ note: '멱등성 테스트' })
        .expect(201);
      const second = await api(ctx)
        .post(`/api/v1/order-items/${fixture.orderItemId}/work-order-versions`)
        .set(auth(ctx))
        .set('Idempotency-Key', key)
        .send({ note: '멱등성 테스트' })
        .expect(201);
      expect(second.body.data).toEqual(first.body.data);

      const count = await ctx.prisma.workOrderVersion.count({
        where: { workOrder: { orderItemId: fixture.orderItemId } },
      });
      expect(count).toBe(1);
    });
  });

  describe('앞마다/뒷마다 하의 요청사항 매핑 · 구두 간이 작업지시서 (설계서 05·06)', () => {
    /** 출력본 xlsx를 내려받아 워크북으로 로드한다. */
    async function downloadWorkbook(versionId: string): Promise<ExcelJS.Workbook> {
      const res = await api(ctx)
        .get(`/api/v1/work-order-versions/${versionId}/file`)
        .set(auth(ctx))
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body as unknown as ArrayBuffer);
      return wb;
    }

    it('FRONT_MADA/BACK_MADA는 신체열이 아니라 하의 추가요청사항(AA75)에 앞/뒤로 기입된다', async () => {
      const fixture = await createFixture();
      // 연결된 채촌 세션에 앞마다/뒷마다 값을 추가한다.
      await ctx.prisma.measurementValue.createMany({
        data: [
          {
            id: randomUUID(),
            measurementSessionId: fixture.measurementSessionId!,
            bodySection: 'LOWER',
            measurementCode: 'FRONT_MADA',
            numericValue: 3,
            unit: 'CM',
            sortOrder: 290,
          },
          {
            id: randomUUID(),
            measurementSessionId: fixture.measurementSessionId!,
            bodySection: 'LOWER',
            measurementCode: 'BACK_MADA',
            numericValue: 5,
            unit: 'CM',
            sortOrder: 300,
          },
        ],
      });

      const issued = await api(ctx)
        .post(`/api/v1/order-items/${fixture.orderItemId}/work-order-versions`)
        .set(auth(ctx))
        .send({ note: '하의 요청 확인' })
        .expect(201);

      const wb = await downloadWorkbook(issued.body.data.workOrderVersionId);
      const ws = wb.getWorksheet('작업지시서 (송파)')!;
      const lowerNote = String(ws.getCell('AA75').value);
      expect(lowerNote).toContain('[마다]');
      expect(lowerNote).toContain('앞: 3');
      expect(lowerNote).toContain('뒤: 5');
      // 하의 요청사항으로 나가므로 상의 비고 [치수]에는 앞마다/뒷마다가 들어가지 않는다.
      expect(String(ws.getCell('AA41').value)).not.toContain('마다');
    });

    it('구두(SHOES) 품목은 정장 템플릿이 아닌 간이 메모형 시트로 출력된다', async () => {
      const fixture = await createFixture({ productCategory: 'SHOES' });
      const issued = await api(ctx)
        .post(`/api/v1/order-items/${fixture.orderItemId}/work-order-versions`)
        .set(auth(ctx))
        .send({ note: '구두 간이 출력' })
        .expect(201);
      expect(issued.body.data.file.fileName).toBe(`${fixture.orderNo}_SHOES-01_V1.xlsx`);

      const wb = await downloadWorkbook(issued.body.data.workOrderVersionId);
      // 정장 송파 템플릿 시트는 없고, 간이 시트만 있다.
      expect(wb.getWorksheet('작업지시서 (송파)')).toBeUndefined();
      const ws = wb.getWorksheet('구두 작업지시서');
      expect(ws).toBeDefined();
      // 고객명이 메모형 시트에 나타난다.
      let found = false;
      ws!.eachRow((row) => {
        row.eachCell((cell) => {
          if (String(cell.value ?? '').includes('테스트고객')) found = true;
        });
      });
      expect(found).toBe(true);
    });
  });

  describe('고객 신체 정보 출력 (v2 A2 · 설계서 06 §2.5)', () => {
    /** 출력본 xlsx를 내려받아 워크북으로 로드한다. */
    async function downloadWorkbook(versionId: string): Promise<ExcelJS.Workbook> {
      const res = await api(ctx)
        .get(`/api/v1/work-order-versions/${versionId}/file`)
        .set(auth(ctx))
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body as unknown as ArrayBuffer);
      return wb;
    }

    it('정장 양식의 키/몸무게(J3)·연령대(Y3) 칸에 고객 신체 정보가 채워진다', async () => {
      const fixture = await createFixture();
      await ctx.prisma.customer.update({
        where: { id: fixture.customerId },
        data: { heightCm: 178, weightKg: 72.5, age: 34 },
      });

      const issued = await api(ctx)
        .post(`/api/v1/order-items/${fixture.orderItemId}/work-order-versions`)
        .set(auth(ctx))
        .send({ note: '신체 정보 확인' })
        .expect(201);

      const ws = (await downloadWorkbook(issued.body.data.workOrderVersionId)).getWorksheet(
        '작업지시서 (송파)',
      )!;
      expect(String(ws.getCell('J3').value)).toBe('178cm / 72.5kg');
      expect(String(ws.getCell('Y3').value)).toBe('34세');
      // 채촌 신체열(F)은 신체 정보와 별개다 — 서로 덮어쓰지 않는다.
      expect(String(ws.getCell('F61').value)).toBe('84');
    });

    it('신체 정보가 없으면 해당 칸을 비워 둔다(인쇄된 양식 그대로 손으로 적는다)', async () => {
      const fixture = await createFixture();
      const issued = await api(ctx)
        .post(`/api/v1/order-items/${fixture.orderItemId}/work-order-versions`)
        .set(auth(ctx))
        .send({ note: '신체 정보 미입력' })
        .expect(201);

      const ws = (await downloadWorkbook(issued.body.data.workOrderVersionId)).getWorksheet(
        '작업지시서 (송파)',
      )!;
      expect(ws.getCell('J3').value).toBeNull();
      expect(ws.getCell('Y3').value).toBeNull();
    });

    it('키만 있으면 키만, 구두 간이시트에도 동일하게 출력된다', async () => {
      const fixture = await createFixture({ productCategory: 'SHOES' });
      await ctx.prisma.customer.update({
        where: { id: fixture.customerId },
        data: { heightCm: 172, age: 41 },
      });

      const issued = await api(ctx)
        .post(`/api/v1/order-items/${fixture.orderItemId}/work-order-versions`)
        .set(auth(ctx))
        .send({ note: '구두 신체 정보' })
        .expect(201);

      const ws = (await downloadWorkbook(issued.body.data.workOrderVersionId)).getWorksheet(
        '구두 작업지시서',
      )!;
      const cells: string[] = [];
      ws.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.value ?? ''))));
      expect(cells).toContain('172cm');
      expect(cells).toContain('41세');
    });
  });
});
