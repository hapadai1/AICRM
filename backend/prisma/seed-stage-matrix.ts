/**
 * 단계별 점검용 데모 데이터 (계약 · 컨설팅 · 제작)
 *
 * 화면마다 "이 상태는 어떻게 보이나"를 한 번에 확인하려면 각 상태에 놓인 데이터가
 * 실제로 있어야 한다. 이 시드는 세 도메인의 상태를 **빠짐없이 한 벌씩** 만든다.
 *
 *   계약   4상태: DRAFT / SIGNED / COMPLETED / CANCELLED
 *   컨설팅 4상태: NOT_STARTED / IN_PROGRESS / REVIEW / CONFIRMED (+재선택 2회차, 3피스)
 *   제작  14상태: CREATED ~ RELEASED 전 단계 + CANCELLED
 *
 * 고객 이름이 곧 그 상태다 (예: '제작07 가봉입고'). 목록에서 이름만 보고 바로 찾으면 된다.
 * 전화번호는 010-7777-#### 대역을 쓴다 — 기존 데모(010-1234-…)와 섞이지 않는다.
 *
 * - 전제: prisma/seed.ts(기본) → seed-demo.ts → 디자인 옵션 시드까지 끝난 상태.
 *         정장 옵션 세트에 ACTIVE 버전이 있어야 한다.
 * - 재실행 안전: 돌릴 때마다 **이 시드가 만든 010-7777 대역 데이터만** 지우고 다시 만든다.
 *         기존 데모(010-1234-…)나 마스터는 건드리지 않으므로 몇 번이든 다시 돌려도 된다.
 * - 실행: npm run seed:stages
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { confirmConsultingForContracts } from './consulting-seed';
import { ITEM_STATUS_FLOW } from '../src/modules/production/production-status';

const prisma = new PrismaClient();

type Tx = Prisma.TransactionClient;

const uuid = (): string => randomUUID();

/** 오늘±offset 일을 @db.Date 컬럼용 UTC 자정 Date로 */
function dateOnly(offsetDays: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays));
}

/** 오늘±offset 일의 지정 시각(로컬) timestamptz Date */
function at(offsetDays: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function storageRoot(): string {
  return resolve(process.env.FILE_STORAGE_PATH ?? './storage');
}

/** 1x1 투명 PNG — 서명 이미지 placeholder */
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** files 레코드와 실제 저장소 파일을 함께 만든다 (레코드만 있으면 다운로드가 404) */
async function createFile(
  tx: Tx,
  args: { storageKey: string; originalName: string; mimeType: string; buffer: Buffer },
): Promise<string> {
  const absolutePath = join(storageRoot(), args.storageKey);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, args.buffer);
  const record = await tx.file.create({
    data: {
      id: uuid(),
      storageKey: args.storageKey,
      originalName: args.originalName,
      mimeType: args.mimeType,
      sizeBytes: BigInt(args.buffer.length),
      checksumSha256: createHash('sha256').update(args.buffer).digest('hex'),
    },
  });
  return record.id;
}

// -----------------------------------------------------------------------------
// 옵션 마스터 로딩 — 활성 정장 버전의 단계·선택지
// -----------------------------------------------------------------------------

interface StageDef {
  id: string;
  sequenceNo: number;
  componentGroup: string | null;
  choices: Array<{ id: string; choiceCode: string; extraPrice: number }>;
}

interface SuitVersion {
  versionId: string;
  /** 2피스(자켓+바지) 품목이 골라야 하는 단계 — VEST 단계 제외 */
  twoPiece: StageDef[];
  /** 3피스(베스트 포함) 품목이 골라야 하는 단계 — 전체 */
  threePiece: StageDef[];
}

async function loadSuitVersion(): Promise<SuitVersion> {
  const set = await prisma.optionSet.findUniqueOrThrow({ where: { productCategory: 'SUIT' } });
  if (!set.activeVersionId)
    throw new Error('정장 옵션 세트에 ACTIVE 버전이 없습니다. 디자인 옵션 시드를 먼저 실행하세요.');
  const stages = await prisma.optionStage.findMany({
    where: { optionSetVersionId: set.activeVersionId, active: true },
    include: { choices: { where: { active: true } } },
    orderBy: { sequenceNo: 'asc' },
  });
  const all: StageDef[] = stages.map((s) => ({
    id: s.id,
    sequenceNo: s.sequenceNo,
    componentGroup: s.componentGroup,
    choices: [...s.choices]
      .sort((a, b) => a.choiceCode.localeCompare(b.choiceCode))
      .map((c) => ({ id: c.id, choiceCode: c.choiceCode, extraPrice: Number(c.extraPrice) })),
  }));
  return {
    versionId: set.activeVersionId,
    twoPiece: all.filter((s) => s.componentGroup !== 'VEST'),
    threePiece: all,
  };
}

/**
 * 단계별 선택 결정.
 * - 'cheap'  : 첫 선택지 (추가금 0 위주)
 * - 'premium': 추가금이 가장 비싼 선택지 — 계약금액 반영 데모용
 */
function pick(stage: StageDef, mode: 'cheap' | 'premium') {
  if (mode === 'cheap') return stage.choices[0];
  return stage.choices.reduce((best, c) => (c.extraPrice > best.extraPrice ? c : best), stage.choices[0]);
}

// -----------------------------------------------------------------------------
// 채촌
// -----------------------------------------------------------------------------

type MeasureRow = [string, string, number | null, string | null, string, number];

function measurementRows(seedNo: number): MeasureRow[] {
  // 고객마다 조금씩 다른 값이 들어가도록 seedNo로 흔든다 (전부 같은 값이면 눈으로 구분이 안 된다).
  const d = (seedNo % 5) - 2;
  return [
    ['JACKET_LENGTH', 'UPPER', 74 + d, null, 'CM', 10],
    ['SHOULDER', 'UPPER', 45 + d * 0.5, null, 'CM', 20],
    ['FRONT_WIDTH', 'UPPER', 39 + d * 0.5, null, 'CM', 30],
    ['BACK_WIDTH', 'UPPER', 41 + d * 0.5, null, 'CM', 40],
    ['CHEST_UPPER', 'UPPER', 98 + d, null, 'CM', 50],
    ['CHEST_MID', 'UPPER', 96 + d, null, 'CM', 60],
    ['CHEST_LOW', 'UPPER', 94 + d, null, 'CM', 70],
    ['SLEEVE_LEFT', 'UPPER', 61 + d * 0.5, null, 'CM', 80],
    ['SLEEVE_RIGHT', 'UPPER', 61 + d * 0.5, null, 'CM', 90],
    ['SLEEVE_WIDTH', 'UPPER', 33 + d * 0.5, null, 'CM', 100],
    ['SLEEVE_OPENING', 'UPPER', 15 + d * 0.2, null, 'CM', 110],
    ['WAIST', 'LOWER', 84 + d, null, 'CM', 210],
    ['HIP', 'LOWER', 98 + d, null, 'CM', 220],
    ['THIGH', 'LOWER', 58 + d * 0.5, null, 'CM', 230],
    ['FRONT_RISE', 'LOWER', 25 + d * 0.3, null, 'CM', 240],
    ['BACK_RISE', 'LOWER', 33 + d * 0.3, null, 'CM', 250],
    ['KNEE', 'LOWER', 44 + d * 0.5, null, 'CM', 260],
    ['PANTS_OPENING', 'LOWER', 19 + d * 0.2, null, 'CM', 270],
    ['PANTS_LENGTH', 'LOWER', 100 + d, null, 'CM', 280],
  ];
}

interface SeededMeasurement {
  id: string;
  versionNo: number;
  measurementDate: Date;
  measurementType: string;
  rows: MeasureRow[];
}

async function createMeasurement(
  tx: Tx,
  args: { customerId: string; seedNo: number; measurementDate: Date; completedAt: Date; adminId: string },
): Promise<SeededMeasurement> {
  const id = uuid();
  const rows = measurementRows(args.seedNo);
  await tx.measurementSession.create({
    data: {
      id,
      customerId: args.customerId,
      versionNo: 1,
      measurementDate: args.measurementDate,
      measurementType: 'INITIAL',
      completedAt: args.completedAt,
      createdBy: args.adminId,
    },
  });
  for (const [code, bodySection, numericValue, textValue, unit, sortOrder] of rows) {
    await tx.measurementValue.create({
      data: {
        id: uuid(),
        measurementSessionId: id,
        bodySection,
        measurementCode: code,
        numericValue,
        textValue,
        unit,
        sortOrder,
      },
    });
  }
  return { id, versionNo: 1, measurementDate: args.measurementDate, measurementType: 'INITIAL', rows };
}

// -----------------------------------------------------------------------------
// 작업지시서
// -----------------------------------------------------------------------------

async function buildOptionSnapshot(tx: Tx, sessionId: string): Promise<Prisma.InputJsonValue> {
  const session = await tx.optionSelectionSession.findUniqueOrThrow({
    where: { id: sessionId },
    include: {
      values: {
        include: { optionStage: true, optionChoice: true },
        orderBy: { optionStage: { sequenceNo: 'asc' } },
      },
    },
  });
  return {
    optionSessionId: session.id,
    selectionVersionNo: session.selectionVersionNo,
    confirmedAt: session.confirmedAt?.toISOString() ?? null,
    fabricName: session.fabricName,
    stages: session.values.map((v) => ({
      stageCode: v.optionStage.stageCode,
      stageName: v.optionStage.stageName,
      sequenceNo: v.optionStage.sequenceNo,
      choiceCode: v.optionChoice.choiceCode,
      choiceName: v.optionChoice.choiceName,
      factoryLabel: v.optionChoice.factoryLabel,
    })),
  };
}

function buildMeasurementSnapshot(m: SeededMeasurement): Prisma.InputJsonValue {
  return {
    measurementSessionId: m.id,
    versionNo: m.versionNo,
    measurementDate: m.measurementDate.toISOString().slice(0, 10),
    measurementType: m.measurementType,
    values: m.rows.map(([code, bodySection, numericValue, textValue, unit, sortOrder]) => ({
      bodySection,
      measurementCode: code,
      value: numericValue,
      textValue,
      unit,
      sortOrder,
    })),
  };
}

/** 작업지시서 1건(V1) 발행. Excel 생성기 대신 빈 파일을 실제로 기록한다. */
async function issueWorkOrder(
  tx: Tx,
  args: {
    orderItemId: string;
    orderNo: string;
    sequenceNo: number;
    optionSessionId: string;
    measurement: SeededMeasurement;
    issuedAt: Date;
    adminId: string;
  },
): Promise<void> {
  const workOrderId = uuid();
  await tx.workOrder.create({ data: { id: workOrderId, orderItemId: args.orderItemId } });

  // 작업지시서는 품목당 파일 하나다 (2026-08-05) — 버전을 쌓지 않는다.
  const outputFileId = await createFile(tx, {
    storageKey: `work-orders/${workOrderId}.xlsx`,
    originalName: `${args.orderNo}_SUIT-${String(args.sequenceNo).padStart(2, '0')}.xlsx`,
    mimeType: XLSX_MIME,
    buffer: Buffer.alloc(0),
  });
  await tx.workOrder.update({
    where: { id: workOrderId },
    data: { outputFileId, issuedBy: args.adminId, issuedAt: args.issuedAt, status: 'COMPLETED' },
  });
}

// -----------------------------------------------------------------------------
// 계약 한 벌(고객 + 계약 + 버전 + 라인 + 품목) 생성
// -----------------------------------------------------------------------------

/** 정장 1벌 단가 */
const UNIT_PRICE = 1_500_000;
/** 베스트 추가 단가 */
const VEST_PRICE = 300_000;

interface SeededItem {
  id: string;
  sequenceNo: number;
  displayName: string;
  vest: boolean;
}

interface SeededContract {
  customerId: string;
  contractId: string;
  versionId: string;
  items: SeededItem[];
}

async function createContract(
  tx: Tx,
  args: {
    seq: number;
    customerName: string;
    /** DRAFT | SIGNED | COMPLETED | CANCELLED */
    status: string;
    /** 품목 수 (모두 CUSTOM/SUIT) */
    itemCount: number;
    /** 베스트(3피스) 품목 여부 — 기본 2피스 */
    vest?: boolean;
    /** 옵션 추가금액 합계 — 계약금액에 이미 반영된 것으로 본다 */
    surcharge?: number;
    adminId: string;
  },
): Promise<SeededContract> {
  const { seq, status, itemCount } = args;
  const vest = args.vest ?? false;
  const completed = status === 'COMPLETED';
  const signed = status === 'SIGNED' || completed;

  const customerId = uuid();
  await tx.customer.create({
    data: {
      id: customerId,
      name: args.customerName,
      phone: `010-7777-${String(seq).padStart(4, '0')}`,
      phoneNormalized: `0107777${String(seq).padStart(4, '0')}`,
      customerStatus: completed ? 'CONTRACTED' : 'PROSPECT',
      registeredAt: at(-40, 10),
      firstReservedAt: at(-45, 14),
      contractedAt: completed ? at(-30, 15) : null,
      heightCm: 175 + (seq % 7),
      weightKg: 70 + (seq % 9),
      age: 30 + (seq % 12),
    },
  });

  const unit = UNIT_PRICE + (vest ? VEST_PRICE : 0);
  const total = unit * itemCount + (args.surcharge ?? 0);

  const contractId = uuid();
  const versionId = uuid();
  await tx.contract.create({
    data: {
      id: contractId,
      contractNo: `CTR-260731-${seq}`,
      customerId,
      status,
      contractedAt: signed ? at(-30, 15) : null,
    },
  });
  await tx.contractVersion.create({
    data: {
      id: versionId,
      contractId,
      versionNo: 1,
      // 계약완료 시점에만 버전이 확정(CONFIRMED)된다 — 그 전까지는 작성중 버전이다.
      versionStatus: completed ? 'CONFIRMED' : 'DRAFT',
      totalAmount: total,
      completionDueDate: dateOnly(20),
      photoDate: dateOnly(30),
      weddingDate: dateOnly(60),
      createdBy: args.adminId,
      confirmedBy: completed ? args.adminId : null,
      confirmedAt: completed ? at(-30, 15) : null,
      // 서명은 별도 테이블이 아니라 버전에 인라인으로 붙는다.
      signatureFileId: signed
        ? await createFile(tx, {
            storageKey: `signatures/${versionId}.png`,
            originalName: `${args.customerName}_서명.png`,
            mimeType: 'image/png',
            buffer: PLACEHOLDER_PNG,
          })
        : null,
      signedAt: signed ? at(-31, 11) : null,
      signerName: signed ? args.customerName.replace(/^\S+\s/, '') : null,
    },
  });
  await tx.contract.update({ where: { id: contractId }, data: { currentVersionId: versionId } });

  const lineId = uuid();
  await tx.contractLine.create({
    data: {
      id: lineId,
      contractVersionId: versionId,
      transactionType: 'CUSTOM',
      productCategory: 'SUIT',
      quantity: itemCount,
      unitPrice: UNIT_PRICE,
      vestUnitPrice: vest ? VEST_PRICE : null,
      vestIncluded: vest,
      lineAmount: unit * itemCount,
      sortOrder: 1,
    },
  });

  const items: SeededItem[] = [];
  for (let i = 1; i <= itemCount; i += 1) {
    const itemId = uuid();
    const displayName = `정장 #${i}`;
    await tx.contractItem.create({
      data: {
        id: itemId,
        contractId,
        sourceContractLineId: lineId,
        transactionType: 'CUSTOM',
        productCategory: 'SUIT',
        sequenceNo: i,
        displayName,
        status: status === 'CANCELLED' ? 'CANCELLED' : 'CREATED',
        cancelledReason: status === 'CANCELLED' ? '고객 요청으로 계약 취소' : null,
        cancelledAt: status === 'CANCELLED' ? at(-5, 16) : null,
      },
    });
    const componentTypes = vest ? ['JACKET', 'TROUSERS', 'VEST'] : ['JACKET', 'TROUSERS'];
    for (let c = 0; c < componentTypes.length; c += 1) {
      await tx.contractItemComponent.create({
        data: {
          id: uuid(),
          contractItemId: itemId,
          componentType: componentTypes[c],
          sequenceNo: c + 1,
          status: status === 'CANCELLED' ? 'CANCELLED' : 'CREATED',
        },
      });
    }
    items.push({ id: itemId, sequenceNo: i, displayName, vest });
  }

  return { customerId, contractId, versionId, items };
}

// -----------------------------------------------------------------------------
// 옵션 세션
// -----------------------------------------------------------------------------

/**
 * 옵션 세션 생성. pickCount 만큼만 앞 단계를 골라 진행중/검토대기를 표현한다.
 * 확정(CONFIRMED)이면 추가금액이 계약금액에 이미 반영된 것으로 보고 surchargeApplied를 채운다
 * (확정과 계약금액 반영은 한 동작이다 — 현업 확정 2026-07-31).
 */
async function createOptionSession(
  tx: Tx,
  args: {
    contractItemId: string;
    stages: StageDef[];
    pickCount: number;
    status: 'NOT_STARTED' | 'IN_PROGRESS' | 'REVIEW' | 'CONFIRMED';
    mode?: 'cheap' | 'premium';
    selectionVersionNo?: number;
    isCurrent?: boolean;
    /** 이전 라운드에서 이어받는 반영 누계 */
    surchargeApplied?: number;
    versionId: string;
    fabricName?: string;
    adminId: string;
    times: { started: Date; saved: Date; reviewed?: Date; confirmed?: Date };
  },
): Promise<{ sessionId: string; surchargeTotal: number }> {
  const sessionId = uuid();
  const mode = args.mode ?? 'cheap';
  const picks = args.stages.slice(0, args.pickCount).map((s) => ({ stage: s, choice: pick(s, mode) }));
  const surchargeTotal = picks.reduce((sum, p) => sum + p.choice.extraPrice, 0);
  const confirmed = args.status === 'CONFIRMED';
  const nextStage = args.stages[args.pickCount] ?? null;

  await tx.optionSelectionSession.create({
    data: {
      id: sessionId,
      contractItemId: args.contractItemId,
      optionSetVersionId: args.versionId,
      selectionVersionNo: args.selectionVersionNo ?? 1,
      status: args.status,
      currentStageId: confirmed ? null : (nextStage?.id ?? null),
      fabricName: args.fabricName ?? null,
      startedAt: args.status === 'NOT_STARTED' ? null : args.times.started,
      lastSavedAt: args.status === 'NOT_STARTED' ? null : args.times.saved,
      reviewedAt: args.times.reviewed ?? null,
      confirmedAt: args.times.confirmed ?? null,
      // 확정된 세션에는 미반영 차액이 남지 않는다.
      surchargeApplied: confirmed ? surchargeTotal : (args.surchargeApplied ?? 0),
      surchargeAppliedAt: confirmed ? (args.times.confirmed ?? args.times.saved) : null,
      isCurrent: args.isCurrent ?? true,
    },
  });

  for (const { stage, choice } of picks) {
    await tx.optionSelectionValue.create({
      data: {
        id: uuid(),
        selectionSessionId: sessionId,
        optionStageId: stage.id,
        optionChoiceId: choice.id,
        // 스냅샷을 안 넣으면 추가금액이 0으로 잡혀 금액 화면이 전부 0이 된다.
        extraPriceSnapshot: choice.extraPrice,
        selectedBy: args.adminId,
        selectedAt: args.times.saved,
      },
    });
  }
  return { sessionId, surchargeTotal };
}

// -----------------------------------------------------------------------------
// 주문(제작) — 계약완료 시 물리화되는 부분을 시드에서 재현
// -----------------------------------------------------------------------------

/** 품목 상태 → 그 시점의 구성품 상태 */
const COMPONENT_STATUS_OF: Record<string, string> = {
  CREATED: 'CREATED',
  OPTION_PENDING: 'CREATED',
  MEASUREMENT_PENDING: 'CREATED',
  READY_TO_ORDER: 'CREATED',
  PRODUCTION_REQUESTED: 'PRODUCTION_REQUESTED',
  PRODUCTION_IN_PROGRESS: 'PRODUCTION_IN_PROGRESS',
  BASTING_RECEIVED: 'BASTING_RECEIVED',
  FITTING_COMPLETED: 'BASTING_RECEIVED',
  PRODUCTION_COMPLETED: 'PRODUCTION_COMPLETED',
  PARTIALLY_RECEIVED: 'PRODUCTION_COMPLETED',
  RECEIVED: 'RECEIVED',
  PARTIALLY_RELEASED: 'RECEIVED',
  RELEASED: 'RELEASED',
  CANCELLED: 'CANCELLED',
};

/**
 * 맞춤 진행 단계 → 그 단계를 지난 것으로 보는 품목 상태(reachedAt).
 * 프론트 production-stages.ts의 CUSTOM_STAGES와 같은 표다 — 이게 어긋나면
 * 상단 진행률(itemStatus 기준)과 진행 카드(단계 완료 기록 기준)가 다시 갈린다.
 * 준비(STYLE_CONSULTING)는 첫 발주 때 함께 완료로 찍히므로 발주 임계(PRODUCTION_REQUESTED)를 쓴다
 * (ProductionFlowCard.completeMutation: 첫 단계 처리 시 준비 완료도 함께 남긴다).
 */
const CUSTOM_STAGE_REACHED: Array<{ code: string; reachedAt: string }> = [
  { code: 'STYLE_CONSULTING', reachedAt: 'PRODUCTION_REQUESTED' },
  { code: 'ORDER_REQUESTED', reachedAt: 'PRODUCTION_REQUESTED' },
  { code: 'BASTING_RECEIVED', reachedAt: 'BASTING_RECEIVED' },
  { code: 'FITTING_DONE', reachedAt: 'FITTING_COMPLETED' },
  { code: 'PRODUCT_RECEIVED', reachedAt: 'RECEIVED' },
  { code: 'RELEASED', reachedAt: 'RELEASED' },
];

/** 품목 제작 상태의 흐름 순위 (CANCELLED 등 흐름 밖은 -1) */
const itemRank = (status: string): number => (ITEM_STATUS_FLOW as readonly string[]).indexOf(status);

/** 품목 상태까지 오는 동안 남았을 이벤트 이력 (제작 요청 이후 단계만 기록된다) */
const EVENT_CHAIN = [
  'PRODUCTION_REQUESTED',
  'PRODUCTION_IN_PROGRESS',
  'BASTING_RECEIVED',
  'FITTING_COMPLETED',
  'PRODUCTION_COMPLETED',
  'RECEIVED',
  'RELEASED',
];

async function createOrderForContract(
  tx: Tx,
  args: {
    seq: number;
    contract: SeededContract;
    /** items 순서대로의 목표 제작 상태 */
    itemStatuses: string[];
    adminId: string;
    /** 이 주문의 진행이 서 있을 단계 (기본: 계약 확정 직후) */
    journeyStageCode?: string;
  },
): Promise<void> {
  const orderId = uuid();
  const orderNo = `ORD-260731-${args.seq}`;
  await tx.order.create({
    data: {
      id: orderId,
      orderNo,
      contractId: args.contract.contractId,
      transactionType: 'CUSTOM',
      // 주문 자체는 CREATED/CANCELLED만 쓴다 — 진행 상태는 품목이 들고 있다.
      status: 'CREATED',
      completionDueDate: dateOnly(20),
      photoDate: dateOnly(30),
      weddingDate: dateOnly(60),
    },
  });

  const createdItems: Array<{ orderItemId: string; status: string }> = [];
  for (let i = 0; i < args.contract.items.length; i += 1) {
    const item = args.contract.items[i];
    const status = args.itemStatuses[i];
    const orderItemId = uuid();
    await tx.orderItem.create({
      data: {
        id: orderItemId,
        orderId,
        sourceContractItemId: item.id,
        productCategory: 'SUIT',
        sequenceNo: item.sequenceNo,
        displayName: item.displayName,
        status,
      },
    });
    createdItems.push({ orderItemId, status });

    const componentTypes = item.vest ? ['JACKET', 'TROUSERS', 'VEST'] : ['JACKET', 'TROUSERS'];
    const componentIds: string[] = [];
    for (let c = 0; c < componentTypes.length; c += 1) {
      const componentId = uuid();
      componentIds.push(componentId);
      // 부분 입고/출고는 구성품 상태가 갈릴 때 나오는 집계값이다 — 첫 구성품만 앞서 나간다.
      let componentStatus = COMPONENT_STATUS_OF[status] ?? 'CREATED';
      if (status === 'PARTIALLY_RECEIVED' && c === 0) componentStatus = 'RECEIVED';
      if (status === 'PARTIALLY_RELEASED' && c === 0) componentStatus = 'RELEASED';
      await tx.orderItemComponent.create({
        data: {
          id: componentId,
          orderItemId,
          componentType: componentTypes[c],
          sequenceNo: c + 1,
          status: componentStatus,
          active: status !== 'CANCELLED',
        },
      });
    }

    // 제작 이벤트 이력 — 현재 상태에 이르기까지 거쳐온 단계를 날짜순으로 남긴다.
    const reached = EVENT_CHAIN.slice(0, EVENT_CHAIN.indexOf(status) + 1);
    const chain = reached.length > 0 ? reached : [];
    let previous: string | null = 'CREATED';
    for (let e = 0; e < chain.length; e += 1) {
      await tx.productionEvent.create({
        data: {
          id: uuid(),
          orderItemId,
          eventType: chain[e],
          previousStatus: previous,
          newStatus: chain[e],
          eventDate: dateOnly(-20 + e * 3),
          expectedDate: chain[e] === 'PRODUCTION_REQUESTED' ? dateOnly(10) : null,
          actorId: args.adminId,
        },
      });
      previous = chain[e];
    }
    // 집계로만 나오는 상태는 별도 이벤트로 남긴다 (서비스도 ITEM_STATUS_AGGREGATED로 기록한다).
    if (status === 'PARTIALLY_RECEIVED' || status === 'PARTIALLY_RELEASED') {
      await tx.productionEvent.create({
        data: {
          id: uuid(),
          orderItemId,
          componentId: componentIds[0],
          eventType: 'ITEM_STATUS_AGGREGATED',
          previousStatus: previous,
          newStatus: status,
          eventDate: dateOnly(-2),
          actorId: args.adminId,
          notes: '구성품 일부만 진행되어 집계된 상태',
        },
      });
    }
  }

  /*
    계약완료 경로(ensureJourneysForOrders)와 같이 주문 1건당 진행 1건을 세운다.
    진행이 없는 주문은 제작 관리에서 아예 빠지므로(계약완료 + 진행이 노출 조건),
    이 데모 계약도 진행을 세워 둬야 제작 화면에 나온다.
    거쳐 온 단계는 이벤트로 남겨 각 단계의 완료일이 화면에 찍히게 한다.
  */
  /*
    진행이 서 있는 현재 단계 — 전 품목이 지난 마지막 단계 다음, 즉 "아직 다 못 지난 첫 단계".
    품목 상태가 제각각인 데모 계약이라도 진행 포인터가 실제와 맞도록 상태에서 계산한다
    (예전엔 journeyStageCode를 그대로 박아, 출고완료로 세워 놓고 완료 기록은 0건이었다).
    발주 전(어떤 품목도 제작요청에 못 닿음)이면 넘겨받은 기본 단계(준비/계약확정)에 그대로 둔다.
  */
  const activeRanks = createdItems.map((ci) => itemRank(ci.status)).filter((r) => r >= 0);
  let target = args.journeyStageCode ?? 'CONTRACT_CONFIRMED';
  for (const st of CUSTOM_STAGE_REACHED) {
    if (st.code === 'STYLE_CONSULTING') continue; // 준비는 이 카드 밖 단계라 포인터로 세우지 않는다
    const need = itemRank(st.reachedAt);
    if (activeRanks.some((r) => r >= need)) target = st.code;
    if (!activeRanks.every((r) => r >= need)) break;
  }
  const stages = await tx.journeyStage.findMany({
    where: { trackType: 'CUSTOM', active: true },
    orderBy: { sequenceNo: 'asc' },
    select: { id: true, code: true },
  });
  const targetIndex = stages.findIndex((s) => s.code === target);
  if (targetIndex < 0) throw new Error(`CUSTOM 진행 단계 ${target} 가 없습니다.`);
  // 진행은 계약 확정부터 목표 단계까지 밟아 온 것으로 둔다(상담 예약은 계약 전 단계라 건너뛴다).
  const path = stages.slice(stages.findIndex((s) => s.code === 'CONTRACT_CONFIRMED'), targetIndex + 1);

  const journeyId = uuid();
  await tx.customerJourney.create({
    data: {
      id: journeyId,
      customerId: args.contract.customerId,
      orderId,
      trackType: 'CUSTOM',
      currentStageCode: target,
      status: 'ACTIVE',
      startedAt: at(-30, 10),
    },
  });
  for (let i = 0; i < path.length; i += 1) {
    await tx.journeyEvent.create({
      data: {
        id: uuid(),
        journeyId,
        stageId: path[i].id,
        fromStageCode: i === 0 ? null : path[i - 1].code,
        toStageCode: path[i].code,
        notificationOutcome: 'NONE',
        actorId: args.adminId,
        changedAt: at(-30 + i * 3, 10),
      },
    });
  }

  /*
    단계별 품목 완료 기록 — 제작 화면(진행 카드)이 "몇 개 끝났나"를 읽는 유일한 근거다.
    itemStatus만 앞서고 이 기록이 없으면 상단 진행률(88%)과 카드(0/5)가 어긋난다.
    실제 발주 흐름이 상태 전진과 함께 이 기록을 남기는 것과 같게, 각 품목이 제작 상태로
    지난 단계마다 완료를 찍는다(취소 품목은 대상이 아니다 — resolveTargets도 제외한다).
  */
  for (const ci of createdItems) {
    const rank = itemRank(ci.status);
    if (rank < 0) continue;
    for (let s = 0; s < CUSTOM_STAGE_REACHED.length; s += 1) {
      const st = CUSTOM_STAGE_REACHED[s];
      if (rank < itemRank(st.reachedAt)) continue;
      await tx.journeyStageItemCompletion.create({
        data: {
          id: uuid(),
          journeyId,
          stageCode: st.code,
          targetType: 'ORDER_ITEM',
          targetId: ci.orderItemId,
          completedAt: at(-24 + s * 3, 11),
          completedBy: args.adminId,
        },
      });
    }
  }
}

// -----------------------------------------------------------------------------
// 재실행 준비 — 이 시드가 만든 것만 지운다
// -----------------------------------------------------------------------------

/**
 * 010-7777 대역 고객에 딸린 데이터를 FK 순서대로 지운다.
 * 다른 시드(기존 데모·마스터)는 건드리지 않으므로 이 스크립트만 몇 번이든 다시 돌릴 수 있다.
 */
async function resetStageMatrix(): Promise<number> {
  const customerIds = (
    await prisma.customer.findMany({
      where: { phoneNormalized: { startsWith: '0107777' } },
      select: { id: true },
    })
  ).map((c) => c.id);
  if (customerIds.length === 0) return 0;

  const contractIds = (
    await prisma.contract.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } })
  ).map((c) => c.id);
  const versions = await prisma.contractVersion.findMany({
    where: { contractId: { in: contractIds } },
    select: { id: true, signatureFileId: true, excelFileId: true },
  });
  const versionIds = versions.map((v) => v.id);
  const contractItemIds = (
    await prisma.contractItem.findMany({ where: { contractId: { in: contractIds } }, select: { id: true } })
  ).map((i) => i.id);
  const sessionIds = (
    await prisma.optionSelectionSession.findMany({
      where: { contractItemId: { in: contractItemIds } },
      select: { id: true },
    })
  ).map((s) => s.id);
  const orderIds = (
    await prisma.order.findMany({ where: { contractId: { in: contractIds } }, select: { id: true } })
  ).map((o) => o.id);
  const orderItemIds = (
    await prisma.orderItem.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } })
  ).map((o) => o.id);
  const workOrderIds = (
    await prisma.workOrder.findMany({ where: { orderItemId: { in: orderItemIds } }, select: { id: true } })
  ).map((w) => w.id);
  const workOrderFileIds = (
    await prisma.workOrder.findMany({
      where: { id: { in: workOrderIds } },
      select: { outputFileId: true, uploadedFileId: true },
    })
  ).flatMap((w) => [w.outputFileId, w.uploadedFileId].filter((id): id is string => !!id));
  const measurementIds = (
    await prisma.measurementSession.findMany({
      where: { customerId: { in: customerIds } },
      select: { id: true },
    })
  ).map((m) => m.id);
  const fileIds = [
    ...workOrderFileIds,
    ...versions.flatMap((v) => [v.signatureFileId, v.excelFileId]).filter((id): id is string => !!id),
  ];

  await prisma.$transaction(
    async (tx) => {
      await tx.productionEvent.deleteMany({ where: { orderItemId: { in: orderItemIds } } });
      // work_orders 가 파일을 참조하므로 파일을 지우기 전에 연결을 끊는다.
      await tx.workOrder.updateMany({
        where: { id: { in: workOrderIds } },
        data: { outputFileId: null, uploadedFileId: null },
      });
      await tx.workOrder.deleteMany({ where: { id: { in: workOrderIds } } });
      await tx.orderItemMeasurement.deleteMany({ where: { orderItemId: { in: orderItemIds } } });
      await tx.orderItemComponent.deleteMany({ where: { orderItemId: { in: orderItemIds } } });
      await tx.journeyStageItemCompletion.deleteMany({
        where: { journey: { customerId: { in: customerIds } } },
      });
      await tx.journeyEvent.deleteMany({ where: { journey: { customerId: { in: customerIds } } } });
      await tx.customerJourney.deleteMany({ where: { customerId: { in: customerIds } } });
      await tx.orderItem.deleteMany({ where: { id: { in: orderItemIds } } });
      await tx.order.deleteMany({ where: { id: { in: orderIds } } });
      await tx.optionSelectionValue.deleteMany({ where: { selectionSessionId: { in: sessionIds } } });
      await tx.optionSelectionComponentAttr.deleteMany({
        where: { selectionSessionId: { in: sessionIds } },
      });
      await tx.optionSelectionSession.deleteMany({ where: { id: { in: sessionIds } } });
      await tx.measurementValue.deleteMany({ where: { measurementSessionId: { in: measurementIds } } });
      await tx.measurementSession.deleteMany({ where: { id: { in: measurementIds } } });
      await tx.contractItemComponent.deleteMany({ where: { contractItemId: { in: contractItemIds } } });
      await tx.contractItem.deleteMany({ where: { id: { in: contractItemIds } } });
      // contracts.current_version_id 도 같은 이유로 먼저 끊는다.
      await tx.contract.updateMany({ where: { id: { in: contractIds } }, data: { currentVersionId: null } });
      await tx.contractLine.deleteMany({ where: { contractVersionId: { in: versionIds } } });
      await tx.contractVersion.deleteMany({ where: { id: { in: versionIds } } });
      await tx.contract.deleteMany({ where: { id: { in: contractIds } } });
      await tx.customer.deleteMany({ where: { id: { in: customerIds } } });
      await tx.file.deleteMany({ where: { id: { in: fileIds } } });
    },
    { timeout: 120_000 },
  );
  return customerIds.length;
}

// -----------------------------------------------------------------------------
// 본체
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  // 이 시드는 자기가 만든 것만 지우고 다시 만든다 — 몇 번을 돌려도 같은 결과가 된다.
  const removed = await resetStageMatrix();
  if (removed > 0) console.log(`이전 단계별 데모 고객 ${removed}명을 지우고 다시 만듭니다.`);

  const admin = await prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
  const suit = await loadSuitVersion();
  console.log(
    `정장 옵션 활성 버전: 2피스 ${suit.twoPiece.length}단계 / 3피스 ${suit.threePiece.length}단계`,
  );

  await prisma.$transaction(
    async (tx) => {
      const adminId = admin.id;

      // ---------------------------------------------------------------------
      // 1) 계약 4상태
      // ---------------------------------------------------------------------
      const c1 = await createContract(tx, {
        seq: 101, customerName: '계약01 작성중', status: 'DRAFT', itemCount: 1, adminId,
      });
      // 작성중 계약은 컨설팅 전 — 세션을 만들지 않는다 (선택 미시작 화면).

      const c2 = await createContract(tx, {
        seq: 102, customerName: '계약02 서명완료', status: 'SIGNED', itemCount: 1, adminId,
      });
      // 서명하려면 컨설팅이 확정돼 있어야 한다.
      const c2opt = await createOptionSession(tx, {
        contractItemId: c2.items[0].id, stages: suit.twoPiece, pickCount: suit.twoPiece.length,
        status: 'CONFIRMED', versionId: suit.versionId, fabricName: '네이비 울 100%', adminId,
        times: { started: at(-35, 10), saved: at(-34, 14), reviewed: at(-34, 14), confirmed: at(-33, 11) },
      });
      await tx.contractVersion.update({
        where: { id: c2.versionId },
        data: { totalAmount: UNIT_PRICE + c2opt.surchargeTotal },
      });

      const c3 = await createContract(tx, {
        seq: 103, customerName: '계약03 계약완료', status: 'COMPLETED', itemCount: 1, adminId,
      });
      const c3opt = await createOptionSession(tx, {
        contractItemId: c3.items[0].id, stages: suit.twoPiece, pickCount: suit.twoPiece.length,
        status: 'CONFIRMED', versionId: suit.versionId, fabricName: '차콜 그레이 울', adminId,
        times: { started: at(-35, 10), saved: at(-34, 14), reviewed: at(-34, 14), confirmed: at(-33, 11) },
      });
      await tx.contractVersion.update({
        where: { id: c3.versionId },
        data: { totalAmount: UNIT_PRICE + c3opt.surchargeTotal },
      });
      await createOrderForContract(tx, {
        // 옵션은 확정했고 채촌은 아직 — 계약완료 직후 정상 상태다(준비 판정과 같은 값).
        seq: 103, contract: c3, itemStatuses: ['MEASUREMENT_PENDING'], adminId,
      });

      await createContract(tx, {
        seq: 104, customerName: '계약04 취소', status: 'CANCELLED', itemCount: 1, adminId,
      });

      // ---------------------------------------------------------------------
      // 2) 컨설팅 6가지 — 계약은 모두 작성중(DRAFT)이라 수정 가능한 상태다
      // ---------------------------------------------------------------------
      const k1 = await createContract(tx, {
        seq: 201, customerName: '컨설팅01 미시작', status: 'DRAFT', itemCount: 1, adminId,
      });
      await createOptionSession(tx, {
        contractItemId: k1.items[0].id, stages: suit.twoPiece, pickCount: 0,
        status: 'NOT_STARTED', versionId: suit.versionId, adminId,
        times: { started: at(-10, 10), saved: at(-10, 10) },
      });

      const k2 = await createContract(tx, {
        seq: 202, customerName: '컨설팅02 진행중', status: 'DRAFT', itemCount: 1, adminId,
      });
      await createOptionSession(tx, {
        contractItemId: k2.items[0].id, stages: suit.twoPiece,
        pickCount: Math.max(1, Math.floor(suit.twoPiece.length / 3)),
        status: 'IN_PROGRESS', versionId: suit.versionId, fabricName: '블랙 울 혼방', adminId,
        times: { started: at(-6, 13), saved: at(-4, 16) },
      });

      const k3 = await createContract(tx, {
        seq: 203, customerName: '컨설팅03 검토대기', status: 'DRAFT', itemCount: 1, adminId,
      });
      await createOptionSession(tx, {
        contractItemId: k3.items[0].id, stages: suit.twoPiece, pickCount: suit.twoPiece.length,
        status: 'REVIEW', versionId: suit.versionId, fabricName: '미디엄 그레이 울', adminId,
        times: { started: at(-5, 10), saved: at(-2, 15), reviewed: at(-2, 15) },
      });

      // 확정 — 비싼 선택지로 골라 추가금액이 계약금액에 반영된 모습을 보여준다.
      const k4 = await createContract(tx, {
        seq: 204, customerName: '컨설팅04 확정', status: 'DRAFT', itemCount: 1, adminId,
      });
      const k4opt = await createOptionSession(tx, {
        contractItemId: k4.items[0].id, stages: suit.twoPiece, pickCount: suit.twoPiece.length,
        status: 'CONFIRMED', mode: 'premium', versionId: suit.versionId,
        fabricName: '네이비 캐시미어 혼방', adminId,
        times: { started: at(-8, 11), saved: at(-6, 14), reviewed: at(-6, 14), confirmed: at(-5, 10) },
      });
      await tx.contractVersion.update({
        where: { id: k4.versionId },
        data: { totalAmount: UNIT_PRICE + k4opt.surchargeTotal },
      });

      // 재선택 — 1회차 확정본은 이력으로 남고, 2회차가 현재 세션이다.
      const k5 = await createContract(tx, {
        seq: 205, customerName: '컨설팅05 재선택중', status: 'DRAFT', itemCount: 1, adminId,
      });
      const k5first = await createOptionSession(tx, {
        contractItemId: k5.items[0].id, stages: suit.twoPiece, pickCount: suit.twoPiece.length,
        status: 'CONFIRMED', mode: 'premium', versionId: suit.versionId,
        selectionVersionNo: 1, isCurrent: false, fabricName: '네이비 울', adminId,
        times: { started: at(-20, 10), saved: at(-18, 15), reviewed: at(-18, 15), confirmed: at(-17, 11) },
      });
      await createOptionSession(tx, {
        contractItemId: k5.items[0].id, stages: suit.twoPiece,
        pickCount: Math.max(1, suit.twoPiece.length - 2),
        status: 'IN_PROGRESS', versionId: suit.versionId,
        selectionVersionNo: 2, isCurrent: true,
        // 1회차에서 반영한 금액은 이어받는다 — 이걸 0으로 두면 같은 금액을 두 번 더하게 된다.
        surchargeApplied: k5first.surchargeTotal,
        fabricName: '네이비 울', adminId,
        times: { started: at(-3, 10), saved: at(-1, 16) },
      });
      await tx.contractVersion.update({
        where: { id: k5.versionId },
        data: { totalAmount: UNIT_PRICE + k5first.surchargeTotal },
      });

      // 3피스 — 베스트 단계까지 포함된 확정본
      const k6 = await createContract(tx, {
        seq: 206, customerName: '컨설팅06 3피스확정', status: 'DRAFT', itemCount: 1, vest: true, adminId,
      });
      const k6opt = await createOptionSession(tx, {
        contractItemId: k6.items[0].id, stages: suit.threePiece, pickCount: suit.threePiece.length,
        status: 'CONFIRMED', versionId: suit.versionId, fabricName: '차콜 3피스 울', adminId,
        times: { started: at(-9, 10), saved: at(-7, 15), reviewed: at(-7, 15), confirmed: at(-6, 12) },
      });
      await tx.contractVersion.update({
        where: { id: k6.versionId },
        data: { totalAmount: UNIT_PRICE + VEST_PRICE + k6opt.surchargeTotal },
      });

      // ---------------------------------------------------------------------
      // 3) 제작 14상태 — 계약완료(주문 생성)된 계약 3건에 나눠 담는다
      // ---------------------------------------------------------------------
      const productionGroups: Array<{ seq: number; name: string; statuses: string[] }> = [
        {
          seq: 301,
          name: '제작01 발주대기',
          /*
            준비 단계 상태는 옵션 확정·채촌 연결에서 자동으로 나온다(2026-08-04 현업 확정).
            계약완료 계약은 전 품목 컨설팅이 확정돼 있어야 하므로(서명 게이트) `옵션대기`는
            여기서 나올 수 없다 — 남는 갈림길은 채촌뿐이라 채촌대기·발주가능 둘로 나눈다.
          */
          statuses: ['MEASUREMENT_PENDING', 'MEASUREMENT_PENDING', 'READY_TO_ORDER', 'READY_TO_ORDER'],
        },
        {
          seq: 302,
          name: '제작02 제작중',
          statuses: [
            'PRODUCTION_REQUESTED',
            'PRODUCTION_IN_PROGRESS',
            'BASTING_RECEIVED',
            'FITTING_COMPLETED',
            'PRODUCTION_COMPLETED',
          ],
        },
        {
          seq: 303,
          name: '제작03 입출고',
          statuses: ['PARTIALLY_RECEIVED', 'RECEIVED', 'PARTIALLY_RELEASED', 'RELEASED', 'CANCELLED'],
        },
      ];

      for (const group of productionGroups) {
        const contract = await createContract(tx, {
          seq: group.seq,
          customerName: group.name,
          status: 'COMPLETED',
          itemCount: group.statuses.length,
          adminId,
        });

        // 제작에 들어가려면 컨설팅 확정과 채촌이 있어야 한다 — 작업지시서의 전제조건이다.
        const measurement = await createMeasurement(tx, {
          customerId: contract.customerId, seedNo: group.seq,
          measurementDate: dateOnly(-28), completedAt: at(-28, 15), adminId,
        });

        /*
          계약완료 계약이므로 컨설팅은 전 품목 확정이다(서명 게이트). 준비의 갈림길은 채촌뿐 —
          채촌대기 품목에는 채촌을 붙이지 않고, 그 뒤 상태의 품목에만 붙인다.
        */
        const measureLinkedOf = (status: string) =>
          status !== 'CREATED' && status !== 'OPTION_PENDING' && status !== 'MEASUREMENT_PENDING';

        let surchargeSum = 0;
        const sessionByItem = new Map<string, string>();
        for (const item of contract.items) {
          const opt = await createOptionSession(tx, {
            contractItemId: item.id, stages: suit.twoPiece, pickCount: suit.twoPiece.length,
            status: 'CONFIRMED', versionId: suit.versionId, fabricName: '네이비 울 100%', adminId,
            times: {
              started: at(-32, 10), saved: at(-31, 14), reviewed: at(-31, 14), confirmed: at(-30, 11),
            },
          });
          surchargeSum += opt.surchargeTotal;
          sessionByItem.set(item.id, opt.sessionId);
        }
        await tx.contractVersion.update({
          where: { id: contract.versionId },
          data: { totalAmount: UNIT_PRICE * contract.items.length + surchargeSum },
        });

        await createOrderForContract(tx, {
          seq: group.seq, contract, itemStatuses: group.statuses, adminId,
          // 진행 단계(고객 여정)도 주문과 함께 선다 — 계약완료된 건은 CUSTOM 트랙에 올라가 있다.
          journeyStageCode:
            group.seq === 301 ? 'STYLE_CONSULTING' : group.seq === 302 ? 'ORDER_REQUESTED' : 'RELEASED',
        });

        const orderItems = await tx.orderItem.findMany({
          where: { sourceContractItemId: { in: contract.items.map((i) => i.id) } },
          orderBy: { sequenceNo: 'asc' },
        });
        const order = await tx.order.findFirstOrThrow({ where: { contractId: contract.contractId } });

        for (const orderItem of orderItems) {
          // 채촌은 그 품목의 준비가 거기까지 간 경우에만 붙어 있다(옵션대기·채촌대기는 아직 없다).
          if (measureLinkedOf(orderItem.status)) {
            await tx.orderItemMeasurement.create({
              data: {
                id: uuid(),
                orderItemId: orderItem.id,
                measurementSessionId: measurement.id,
                isCurrent: true,
                linkedAt: at(-28, 16),
                linkedBy: adminId,
              },
            });
          }
          // 작업지시서는 발주(제작요청) 이후 품목에만 발행돼 있다.
          if (EVENT_CHAIN.includes(orderItem.status)) {
            await issueWorkOrder(tx, {
              orderItemId: orderItem.id,
              orderNo: order.orderNo,
              sequenceNo: orderItem.sequenceNo,
              optionSessionId: sessionByItem.get(orderItem.sourceContractItemId)!,
              measurement,
              issuedAt: at(-26, 10),
              adminId,
            });
          }
        }

        // 작업지시서 '재출력 필요'도 한 건 만든다.
        // 이 상태는 컬럼이 아니라 계산값이다 — 채촌 연결 시각이 지시서 발행 시각보다 뒤면 재출력 대상이 된다.
        if (group.seq === 302) {
          const target = orderItems.find((o) => o.status === 'PRODUCTION_IN_PROGRESS');
          if (target)
            await tx.orderItemMeasurement.updateMany({
              where: { orderItemId: target.id },
              data: { linkedAt: at(-2, 15) },
            });
        }

      }

      /*
        계약완료 계약은 전 품목 컨설팅이 확정돼 있어야 한다 — 앱이 서명 단계에서 그걸 막는다
        (assertSignable → CONSULTING_NOT_CONFIRMED). 이 시드 밖에서 만들어진 계약까지 함께 맞춘다.
      */
      const completed = await tx.contract.findMany({ where: { status: 'COMPLETED' }, select: { id: true } });
      const consulting = await confirmConsultingForContracts(tx, {
        contractIds: completed.map((c) => c.id),
        adminId,
        confirmedAt: at(-30, 11),
      });
      if (consulting.customConfirmed + consulting.rentalConfirmed > 0)
        console.log(
          `컨설팅 확정 보정: 맞춤 ${consulting.customConfirmed} / 렌탈 ${consulting.rentalConfirmed}`,
        );
    },
    { timeout: 120_000 },
  );

  const mine = { customer: { phoneNormalized: { startsWith: '0107777' } } };
  const [customers, contracts, orders, orderItems, sessions, workOrders] = await Promise.all([
    prisma.customer.count({ where: mine.customer }),
    prisma.contract.count({ where: mine }),
    prisma.order.count({ where: { contract: mine } }),
    prisma.orderItem.count({ where: { order: { contract: mine } } }),
    prisma.optionSelectionSession.count({ where: { contractItem: { contract: mine } } }),
    prisma.workOrder.count({ where: { orderItem: { order: { contract: mine } } } }),
  ]);
  console.log(
    `단계별 데모 완료 — 고객 ${customers} / 계약 ${contracts} / 주문 ${orders} / 주문품목 ${orderItems} / 옵션세션 ${sessions} / 작업지시서 ${workOrders}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
