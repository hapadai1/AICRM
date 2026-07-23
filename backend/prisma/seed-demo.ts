/**
 * AICRM 실서버 데모 시드 (연동정합화 계약 §12)
 * - 전제: prisma/seed.ts(기본 시드)가 먼저 실행된 상태 (admin·계약구분·옵션세트 존재)
 * - 재실행 안전: 데모 고객 전화번호(01012345678) 존재 시 스킵 후 종료
 * - 실행: npm run seed:demo  (ts-node prisma/seed-demo.ts, DATABASE_URL은 backend/.env)
 *
 * 생성 시나리오는 frontend/src/mocks/core-data.ts와 동일한 구성을 실 DB에 재현한다.
 *   고객 6 / 계약 3(확정 2·완료 1) / 주문 5 / 품목 10 / 구성품 16
 *   옵션 세트 활성 버전(정장 11·셔츠 3·구두 3단계, 단계별 A/B 선택지)
 *   옵션 세션(확정·진행중) / 채촌(김민준 2버전·이서연 1버전) / 작업지시서 V1·V2 이력
 *   렌탈 SKU 9·실물 20·배정 6(오늘 픽업 3·대여 중 2·반납 지연 1)·수선 중 실물 1
 *   수선 3 / 결제(계약금 완료·잔금 미수) / 알림 템플릿 3 / 공유 메모 2 / 예약 10·상담 2
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

const prisma = new PrismaClient();

/** 데모 시드 여부 감지용 고정 전화번호 (김민준) */
const DEMO_MARKER_PHONE = '01012345678';

// -----------------------------------------------------------------------------
// 공통 헬퍼
// -----------------------------------------------------------------------------

type Tx = Prisma.TransactionClient;

const uuid = (): string => randomUUID();

/** 오늘±offset 일을 @db.Date 컬럼용 UTC 자정 Date로 반환 */
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

/** 1x1 투명 PNG (옵션 선택지 placeholder 이미지) */
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * FILE_STORAGE_PATH에 실제 파일을 쓰고 files 레코드를 생성한다.
 * (레코드만 만들면 downloadUrl 접근 시 404가 나므로 빈/placeholder 버퍼라도 실제로 쓴다)
 */
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
// 옵션 세트 정의 (정장 11 / 셔츠 3 / 구두 3 단계, 각 단계 A/B 선택지)
// -----------------------------------------------------------------------------

interface StageDef {
  code: string;
  name: string;
  choiceA: string;
  choiceB: string;
}

const SUIT_STAGES: StageDef[] = [
  { code: 'FRONT_BUTTON', name: '앞여밈 단추', choiceA: '싱글 2버튼', choiceB: '싱글 3버튼' },
  { code: 'LAPEL', name: '라펠 형태', choiceA: '노치 라펠', choiceB: '피크 라펠' },
  { code: 'LAPEL_WIDTH', name: '라펠 너비', choiceA: '8cm 스탠다드', choiceB: '9.5cm 와이드' },
  { code: 'CHEST_POCKET', name: '가슴 포켓', choiceA: '웰트 포켓', choiceB: '바르카 포켓' },
  { code: 'SIDE_POCKET', name: '사이드 포켓', choiceA: '플랩 포켓', choiceB: '슬랜트 포켓' },
  { code: 'VENT', name: '뒤트임', choiceA: '사이드 벤트', choiceB: '센터 벤트' },
  { code: 'SLEEVE_BUTTON', name: '소매 단추', choiceA: '4버튼 키스버튼', choiceB: '3버튼 스탠다드' },
  { code: 'LINING', name: '안감', choiceA: '풀 라이닝 (비스코스)', choiceB: '하프 라이닝' },
  { code: 'TROUSER_PLEAT', name: '바지 주름', choiceA: '노 플리츠', choiceB: '원 플리츠' },
  { code: 'TROUSER_HEM', name: '바지 밑단', choiceA: '일자 마감', choiceB: '턴업 4cm' },
  { code: 'MONOGRAM', name: '이니셜 자수', choiceA: '이니셜 자수 (금사)', choiceB: '자수 없음' },
];

const SHIRT_STAGES: StageDef[] = [
  { code: 'COLLAR', name: '카라 형태', choiceA: '세미 와이드 카라', choiceB: '버튼다운 카라' },
  { code: 'CUFF', name: '커프스', choiceA: '배럴 커프스', choiceB: '프렌치 커프스' },
  { code: 'SHIRT_POCKET', name: '가슴 포켓', choiceA: '포켓 없음', choiceB: '원 포켓' },
];

const SHOES_STAGES: StageDef[] = [
  { code: 'TOE_STYLE', name: '토 스타일', choiceA: '스트레이트 팁', choiceB: '플레인 토' },
  { code: 'LEATHER', name: '가죽', choiceA: '카프 블랙', choiceB: '카프 다크브라운' },
  { code: 'OUTSOLE', name: '아웃솔', choiceA: '레더 솔', choiceB: '러버 솔' },
];

interface SeededStage {
  id: string;
  code: string;
  name: string;
  sequenceNo: number;
  choices: { A: { id: string; name: string }; B: { id: string; name: string } };
}

interface SeededOptionVersion {
  versionId: string;
  stages: SeededStage[];
}

/** 옵션 세트 버전 + 단계 + A/B 선택지(placeholder 이미지 파일 포함) 생성 후 활성화 */
async function createOptionVersion(
  tx: Tx,
  productCategory: string,
  stageDefs: StageDef[],
  adminId: string,
): Promise<SeededOptionVersion> {
  const optionSet = await tx.optionSet.findUnique({ where: { productCategory } });
  if (!optionSet) {
    throw new Error(
      `옵션 세트(${productCategory})가 없습니다. 기본 시드(prisma/seed.ts)를 먼저 실행하세요.`,
    );
  }
  const last = await tx.optionSetVersion.findFirst({
    where: { optionSetId: optionSet.id },
    orderBy: { versionNo: 'desc' },
    select: { versionNo: true },
  });
  const versionId = uuid();
  await tx.optionSetVersion.create({
    data: {
      id: versionId,
      optionSetId: optionSet.id,
      versionNo: (last?.versionNo ?? 0) + 1,
      status: 'ACTIVE',
      effectiveFrom: dateOnly(0),
      description: '데모 시드 활성 버전',
      createdBy: adminId,
    },
  });

  const stages: SeededStage[] = [];
  for (let i = 0; i < stageDefs.length; i += 1) {
    const def = stageDefs[i];
    const stageId = uuid();
    await tx.optionStage.create({
      data: {
        id: stageId,
        optionSetVersionId: versionId,
        stageCode: def.code,
        stageName: def.name,
        sequenceNo: i + 1,
        required: true,
        active: true,
      },
    });
    const choices: SeededStage['choices'] = { A: { id: '', name: '' }, B: { id: '', name: '' } };
    for (const [choiceCode, choiceName] of [
      ['A', def.choiceA],
      ['B', def.choiceB],
    ] as const) {
      const choiceId = uuid();
      const imageFileId = await createFile(tx, {
        storageKey: `demo/option-choices/${choiceId}.png`,
        originalName: `${productCategory}_${def.code}_${choiceCode}.png`,
        mimeType: 'image/png',
        buffer: PLACEHOLDER_PNG,
      });
      await tx.optionChoice.create({
        data: {
          id: choiceId,
          optionStageId: stageId,
          choiceCode,
          choiceName,
          factoryLabel: choiceName,
          imageFileId,
          active: true,
        },
      });
      choices[choiceCode] = { id: choiceId, name: choiceName };
    }
    stages.push({ id: stageId, code: def.code, name: def.name, sequenceNo: i + 1, choices });
  }

  // 기존 ACTIVE 버전은 RETIRED 처리 후 신규 버전 활성화 (백엔드 활성화 로직과 동일)
  await tx.optionSetVersion.updateMany({
    where: { optionSetId: optionSet.id, status: 'ACTIVE', id: { not: versionId } },
    data: { status: 'RETIRED' },
  });
  await tx.optionSet.update({
    where: { id: optionSet.id },
    data: { activeVersionId: versionId },
  });
  return { versionId, stages };
}

// -----------------------------------------------------------------------------
// 옵션 세션
// -----------------------------------------------------------------------------

interface SessionTimes {
  startedAt: Date;
  lastSavedAt: Date;
  reviewedAt?: Date;
  confirmedAt?: Date;
}

/**
 * 옵션 세션 + 선택값 생성.
 * picks: 단계 순서대로의 선택 코드 배열 (누락 단계는 미선택 = 진행중 재개 지점)
 */
async function createOptionSession(
  tx: Tx,
  args: {
    orderItemId: string;
    version: SeededOptionVersion;
    picks: Array<'A' | 'B'>;
    status: 'IN_PROGRESS' | 'REVIEW' | 'CONFIRMED';
    fabricName?: string;
    times: SessionTimes;
    adminId: string;
  },
): Promise<string> {
  const sessionId = uuid();
  const nextStage = args.version.stages[args.picks.length] ?? null;
  await tx.optionSelectionSession.create({
    data: {
      id: sessionId,
      orderItemId: args.orderItemId,
      optionSetVersionId: args.version.versionId,
      selectionVersionNo: 1,
      status: args.status,
      currentStageId: args.status === 'CONFIRMED' ? null : (nextStage?.id ?? null),
      fabricName: args.fabricName ?? null,
      startedAt: args.times.startedAt,
      lastSavedAt: args.times.lastSavedAt,
      reviewedAt: args.times.reviewedAt ?? null,
      confirmedAt: args.times.confirmedAt ?? null,
      isCurrent: true,
    },
  });
  for (let i = 0; i < args.picks.length; i += 1) {
    const stage = args.version.stages[i];
    await tx.optionSelectionValue.create({
      data: {
        id: uuid(),
        selectionSessionId: sessionId,
        optionStageId: stage.id,
        optionChoiceId: stage.choices[args.picks[i]].id,
        selectedBy: args.adminId,
        selectedAt: args.times.lastSavedAt,
      },
    });
  }
  return sessionId;
}

// -----------------------------------------------------------------------------
// 채촌
// -----------------------------------------------------------------------------

/** [code, bodySection, numeric|null, text|null, unit, sortOrder] */
type MeasureRow = [string, string, number | null, string | null, string, number];

function measurementRows(v: {
  neck: number; shoulder: number; chest: number; sleeve: number; bodyLength: number; wrist: number;
  upperSize: string; waist: number; hip: number; rise: number; pantsLength: number; thigh: number;
  calf: number; lowerSize: string; shoeSize: number;
}): MeasureRow[] {
  return [
    ['JACKET_LENGTH', 'UPPER', v.bodyLength, null, 'CM', 10],
    ['SHOULDER', 'UPPER', v.shoulder, null, 'CM', 20],
    ['FRONT_WIDTH', 'UPPER', Math.round(v.chest * 0.4 * 10) / 10, null, 'CM', 30],
    ['BACK_WIDTH', 'UPPER', Math.round(v.chest * 0.42 * 10) / 10, null, 'CM', 40],
    ['CHEST_UPPER', 'UPPER', v.chest, null, 'CM', 50],
    ['CHEST_MID', 'UPPER', v.chest - 2, null, 'CM', 60],
    ['CHEST_LOW', 'UPPER', v.chest - 4, null, 'CM', 70],
    ['SLEEVE_LEFT', 'UPPER', v.sleeve, null, 'CM', 80],
    ['SLEEVE_RIGHT', 'UPPER', v.sleeve, null, 'CM', 90],
    ['SLEEVE_WIDTH', 'UPPER', v.wrist + 18, null, 'CM', 100],
    ['SLEEVE_OPENING', 'UPPER', v.wrist, null, 'CM', 110],
    ['WAIST', 'LOWER', v.waist, null, 'CM', 210],
    ['HIP', 'LOWER', v.hip, null, 'CM', 220],
    ['THIGH', 'LOWER', v.thigh, null, 'CM', 230],
    ['FRONT_RISE', 'LOWER', v.rise, null, 'CM', 240],
    ['BACK_RISE', 'LOWER', v.rise + 8, null, 'CM', 250],
    ['KNEE', 'LOWER', v.calf + 2, null, 'CM', 260],
    ['PANTS_OPENING', 'LOWER', Math.round(v.calf * 0.5 * 10) / 10, null, 'CM', 270],
    ['PANTS_LENGTH', 'LOWER', v.pantsLength, null, 'CM', 280],
    ['SHOE_SIZE', 'SHOES', v.shoeSize, null, 'MM', 310],
  ];
}

interface SeededMeasurement {
  id: string;
  versionNo: number;
  measurementDate: Date;
  measurementType: string;
  rows: MeasureRow[];
}

async function createMeasurementSession(
  tx: Tx,
  args: {
    customerId: string;
    relatedOrderId?: string;
    versionNo: number;
    measurementDate: Date;
    measurementType: 'INITIAL' | 'FITTING';
    previousSessionId?: string;
    fitPreference?: string;
    bodyNotes?: string;
    completedAt: Date;
    rows: MeasureRow[];
    adminId: string;
  },
): Promise<SeededMeasurement> {
  const sessionId = uuid();
  await tx.measurementSession.create({
    data: {
      id: sessionId,
      customerId: args.customerId,
      relatedOrderId: args.relatedOrderId ?? null,
      versionNo: args.versionNo,
      measurementDate: args.measurementDate,
      measurementType: args.measurementType,
      previousSessionId: args.previousSessionId ?? null,
      fitPreference: args.fitPreference ?? null,
      bodyNotes: args.bodyNotes ?? null,
      completedAt: args.completedAt,
      createdBy: args.adminId,
    },
  });
  for (const [code, bodySection, numericValue, textValue, unit, sortOrder] of args.rows) {
    await tx.measurementValue.create({
      data: {
        id: uuid(),
        measurementSessionId: sessionId,
        bodySection,
        measurementCode: code,
        numericValue,
        textValue,
        unit,
        sortOrder,
      },
    });
  }
  return {
    id: sessionId,
    versionNo: args.versionNo,
    measurementDate: args.measurementDate,
    measurementType: args.measurementType,
    rows: args.rows,
  };
}

// -----------------------------------------------------------------------------
// 작업지시서 (스냅샷은 work-orders.service의 build*Snapshot과 동일한 형태)
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

/**
 * 작업지시서 버전 생성. Excel 생성기는 사용하지 않고 빈 buffer 파일을
 * FILE_STORAGE_PATH에 실제로 기록해 files 레코드와 저장소 정합을 유지한다.
 */
async function issueWorkOrderVersion(
  tx: Tx,
  args: {
    workOrderId: string;
    versionNo: number;
    orderNo: string;
    productCategory: string;
    sequenceNo: number;
    optionSessionId: string;
    measurement: SeededMeasurement;
    issuedAt: Date;
    status: 'ISSUED' | 'SENT' | 'SUPERSEDED';
    changeReason?: string;
    adminId: string;
  },
): Promise<string> {
  const versionId = uuid();
  const optionSnapshot = await buildOptionSnapshot(tx, args.optionSessionId);
  const measurementSnapshot = buildMeasurementSnapshot(args.measurement);
  const sourceHash = createHash('sha256')
    .update(JSON.stringify({ option: optionSnapshot, measurement: measurementSnapshot }))
    .digest('hex');
  const fileName = `${args.orderNo}_${args.productCategory}-${String(args.sequenceNo).padStart(2, '0')}_V${args.versionNo}.xlsx`;
  const outputFileId = await createFile(tx, {
    storageKey: `work-orders/${versionId}.xlsx`,
    originalName: fileName,
    mimeType: XLSX_MIME,
    buffer: Buffer.alloc(0),
  });
  await tx.workOrderVersion.create({
    data: {
      id: versionId,
      workOrderId: args.workOrderId,
      versionNo: args.versionNo,
      sourceOptionSessionId: args.optionSessionId,
      sourceMeasurementSessionId: args.measurement.id,
      optionSnapshot,
      measurementSnapshot,
      sourceHash,
      changeReason: args.changeReason ?? null,
      outputFileId,
      status: args.status,
      issuedBy: args.adminId,
      issuedAt: args.issuedAt,
    },
  });
  return versionId;
}

// -----------------------------------------------------------------------------
// 메인
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  // 재실행 감지: 데모 고객(김민준) 전화번호 존재 시 스킵
  const marker = await prisma.customer.findUnique({
    where: { phoneNormalized: DEMO_MARKER_PHONE },
  });
  if (marker) {
    console.log(
      `데모 시드 스킵: 데모 고객(전화 ${DEMO_MARKER_PHONE}, ${marker.name})이 이미 존재합니다.`,
    );
    return;
  }

  // 전제 확인: 기본 시드(prisma/seed.ts) 산출물
  const admin = await prisma.user.findUnique({ where: { loginId: 'admin' } });
  if (!admin) {
    throw new Error('admin 사용자가 없습니다. 기본 시드(prisma/seed.ts)를 먼저 실행하세요.');
  }
  const businessType = await prisma.contractType.findUnique({
    where: { code: 'BUSINESS_SUIT_CUSTOM' },
  });
  const weddingType = await prisma.contractType.findUnique({
    where: { code: 'WEDDING_PACKAGE_RENTAL' },
  });
  if (!businessType || !weddingType) {
    throw new Error(
      '계약 구분(BUSINESS_SUIT_CUSTOM/WEDDING_PACKAGE_RENTAL)이 없습니다. 기본 시드를 먼저 실행하세요.',
    );
  }
  const purposes = await prisma.appointmentPurpose.findMany();
  const purposeId = (code: string): string => {
    const found = purposes.find((p) => p.code === code);
    if (!found) {
      throw new Error(`예약 목적(${code})이 없습니다. 기본 시드를 먼저 실행하세요.`);
    }
    return found.id;
  };
  const adminId = admin.id;

  await prisma.$transaction(
    async (tx) => {
      // -----------------------------------------------------------------------
      // 1) 고객 6명
      // -----------------------------------------------------------------------
      const customer = async (args: {
        name: string;
        phone: string;
        email?: string;
        status: string;
        firstReservedAt?: Date;
        contractedAt?: Date;
        notes?: string;
      }): Promise<string> => {
        const id = uuid();
        await tx.customer.create({
          data: {
            id,
            name: args.name,
            phone: args.phone,
            phoneNormalized: args.phone.replace(/\D/g, ''),
            email: args.email ?? null,
            customerStatus: args.status,
            firstReservedAt: args.firstReservedAt ?? null,
            contractedAt: args.contractedAt ?? null,
            notes: args.notes ?? null,
          },
        });
        return id;
      };

      const 김민준 = await customer({
        name: '김민준', phone: '010-1234-5678', email: 'minjun@example.com', status: 'CONTRACTED',
        firstReservedAt: at(-40, 11), contractedAt: at(-30, 15),
        notes: '웨딩 촬영·예식 일정 촉박, 연락은 오후 선호',
      });
      const 이서연 = await customer({
        name: '이서연', phone: '010-2345-6789', status: 'CONTRACTED',
        firstReservedAt: at(-20, 14), contractedAt: at(-15, 16),
        notes: '비즈니스 정장 단골 고객',
      });
      const 박지훈 = await customer({
        name: '박지훈', phone: '010-3456-7890', status: 'PROSPECT',
        firstReservedAt: at(-3, 10), notes: '네이버 예약으로 유입, 초도상담 예정',
      });
      const 최수아 = await customer({
        name: '최수아', phone: '010-4567-8901', status: 'PROSPECT', firstReservedAt: at(-1, 17),
      });
      const 정우성 = await customer({
        name: '정우성', phone: '010-5678-9012', status: 'CONTRACTED',
        firstReservedAt: at(-90, 11), contractedAt: at(-85, 13),
        notes: '완료 고객, 수선 이력 있음',
      });
      const 강하늘 = await customer({
        name: '강하늘', phone: '010-6789-0123', status: 'INACTIVE',
      });
      console.log('customers: 6건');

      // -----------------------------------------------------------------------
      // 2) 옵션 세트 활성 버전 (정장 11 / 셔츠 3 / 구두 3)
      // -----------------------------------------------------------------------
      const suitOptions = await createOptionVersion(tx, 'SUIT', SUIT_STAGES, adminId);
      const shirtOptions = await createOptionVersion(tx, 'SHIRT', SHIRT_STAGES, adminId);
      await createOptionVersion(tx, 'SHOES', SHOES_STAGES, adminId);
      console.log('option_set_versions: 3건 (단계 17, 선택지 34, 이미지 파일 34)');

      // -----------------------------------------------------------------------
      // 3) 계약 3건 + 버전·라인 + 주문·품목·구성품
      // -----------------------------------------------------------------------
      interface LineDef {
        transactionType: string;
        productCategory: string;
        itemDescription: string;
        quantity: number;
        unitPrice: number;
      }
      const createVersion = async (
        contractId: string,
        versionNo: number,
        versionStatus: string,
        amounts: { total: number; deposit: number },
        dates: { confirmedAt?: Date; completionDueDate?: Date; photoDate?: Date; weddingDate?: Date },
        changeReason: string | null,
        lines: LineDef[],
      ): Promise<{ versionId: string; lineIds: string[] }> => {
        const versionId = uuid();
        await tx.contractVersion.create({
          data: {
            id: versionId,
            contractId,
            versionNo,
            versionStatus,
            changeReason,
            totalAmount: amounts.total,
            depositAmount: amounts.deposit,
            balanceAmount: amounts.total - amounts.deposit,
            completionDueDate: dates.completionDueDate ?? null,
            photoDate: dates.photoDate ?? null,
            weddingDate: dates.weddingDate ?? null,
            confirmedBy: dates.confirmedAt ? adminId : null,
            confirmedAt: dates.confirmedAt ?? null,
            createdBy: adminId,
          },
        });
        const lineIds: string[] = [];
        for (let i = 0; i < lines.length; i += 1) {
          const l = lines[i];
          const lineId = uuid();
          await tx.contractLine.create({
            data: {
              id: lineId,
              contractVersionId: versionId,
              transactionType: l.transactionType,
              productCategory: l.productCategory,
              itemDescription: l.itemDescription,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              lineAmount: l.unitPrice * l.quantity,
              sortOrder: i + 1,
            },
          });
          lineIds.push(lineId);
        }
        return { versionId, lineIds };
      };

      // 계약 1: 김민준 웨딩패키지 (CONFIRMED, v2 — 정장 1벌 추가 변경계약, 잔금 지연 데모)
      const ct1 = uuid();
      await tx.contract.create({
        data: {
          id: ct1,
          contractNo: 'CTR-260620-001',
          customerId: 김민준,
          contractTypeId: weddingType.id,
          status: 'CONFIRMED',
          contractedAt: at(-30, 15),
          balanceDueDate: dateOnly(-5), // 잔금 결제 지연 데모 (과거 예정일 + 미수 잔액)
        },
      });
      await createVersion(
        ct1, 1, 'SUPERSEDED',
        { total: 1850000, deposit: 1000000 },
        { confirmedAt: at(-30, 15), completionDueDate: dateOnly(14), photoDate: dateOnly(20), weddingDate: dateOnly(45) },
        null,
        [
          { transactionType: 'CUSTOM', productCategory: 'SUIT', itemDescription: '맞춤 예복 정장', quantity: 1, unitPrice: 1350000 },
          { transactionType: 'RENTAL', productCategory: 'SUIT', itemDescription: '렌탈 촬영용 정장', quantity: 1, unitPrice: 350000 },
          { transactionType: 'RENTAL', productCategory: 'SHOES', itemDescription: '렌탈 구두', quantity: 1, unitPrice: 150000 },
        ],
      );
      const ct1v2 = await createVersion(
        ct1, 2, 'CONFIRMED',
        { total: 3200000, deposit: 1000000 },
        { confirmedAt: at(-25, 14), completionDueDate: dateOnly(14), photoDate: dateOnly(20), weddingDate: dateOnly(45) },
        '혼주 정장 1벌 추가',
        [
          { transactionType: 'CUSTOM', productCategory: 'SUIT', itemDescription: '맞춤 예복 정장', quantity: 2, unitPrice: 1350000 },
          { transactionType: 'RENTAL', productCategory: 'SUIT', itemDescription: '렌탈 촬영용 정장', quantity: 1, unitPrice: 350000 },
          { transactionType: 'RENTAL', productCategory: 'SHOES', itemDescription: '렌탈 구두', quantity: 1, unitPrice: 150000 },
        ],
      );
      await tx.contract.update({ where: { id: ct1 }, data: { currentVersionId: ct1v2.versionId } });

      // 계약 2: 이서연 비즈니스 정장 맞춤 (CONFIRMED, v1)
      const ct2 = uuid();
      await tx.contract.create({
        data: {
          id: ct2,
          contractNo: 'CTR-260705-001',
          customerId: 이서연,
          contractTypeId: businessType.id,
          status: 'CONFIRMED',
          contractedAt: at(-15, 16),
          balanceDueDate: dateOnly(10),
        },
      });
      const ct2v1 = await createVersion(
        ct2, 1, 'CONFIRMED',
        { total: 1800000, deposit: 500000 },
        { confirmedAt: at(-15, 16), completionDueDate: dateOnly(10) },
        null,
        [
          { transactionType: 'CUSTOM', productCategory: 'SUIT', itemDescription: '맞춤 비즈니스 정장', quantity: 1, unitPrice: 1200000 },
          { transactionType: 'CUSTOM', productCategory: 'SHIRT', itemDescription: '맞춤 셔츠', quantity: 2, unitPrice: 300000 },
        ],
      );
      await tx.contract.update({ where: { id: ct2 }, data: { currentVersionId: ct2v1.versionId } });

      // 계약 3: 정우성 (COMPLETED, 맞춤 정장 + 렌탈 — 렌탈 대여 중·반납 지연 데모의 근거 주문)
      const ct3 = uuid();
      await tx.contract.create({
        data: {
          id: ct3,
          contractNo: 'CTR-260420-002',
          customerId: 정우성,
          contractTypeId: businessType.id,
          status: 'COMPLETED',
          contractedAt: at(-85, 13),
          balanceDueDate: null, // 완납 — 지연 판정 제외
        },
      });
      const ct3v1 = await createVersion(
        ct3, 1, 'CONFIRMED',
        { total: 1500000, deposit: 500000 },
        { confirmedAt: at(-85, 13), completionDueDate: dateOnly(-60) },
        null,
        [
          { transactionType: 'CUSTOM', productCategory: 'SUIT', itemDescription: '맞춤 비즈니스 정장', quantity: 1, unitPrice: 1270000 },
          { transactionType: 'RENTAL', productCategory: 'SUIT', itemDescription: '렌탈 행사용 정장', quantity: 1, unitPrice: 150000 },
          { transactionType: 'RENTAL', productCategory: 'SHOES', itemDescription: '렌탈 구두', quantity: 1, unitPrice: 80000 },
        ],
      );
      await tx.contract.update({ where: { id: ct3 }, data: { currentVersionId: ct3v1.versionId } });
      console.log('contracts: 3건 (버전 4, 라인 8)');

      // 주문 5건 -------------------------------------------------------------
      const order = async (args: {
        orderNo: string; contractId: string; transactionType: string; status: string;
        completionDueDate?: Date; photoDate?: Date; weddingDate?: Date;
      }): Promise<string> => {
        const id = uuid();
        await tx.order.create({
          data: {
            id,
            orderNo: args.orderNo,
            contractId: args.contractId,
            transactionType: args.transactionType,
            status: args.status,
            completionDueDate: args.completionDueDate ?? null,
            photoDate: args.photoDate ?? null,
            weddingDate: args.weddingDate ?? null,
          },
        });
        return id;
      };
      const o1 = await order({ orderNo: 'ORD-260620-001', contractId: ct1, transactionType: 'CUSTOM', status: 'IN_PROGRESS', completionDueDate: dateOnly(14), photoDate: dateOnly(20), weddingDate: dateOnly(45) });
      const o2 = await order({ orderNo: 'ORD-260620-002', contractId: ct1, transactionType: 'RENTAL', status: 'IN_PROGRESS', completionDueDate: dateOnly(20), photoDate: dateOnly(20), weddingDate: dateOnly(45) });
      const o3 = await order({ orderNo: 'ORD-260705-001', contractId: ct2, transactionType: 'CUSTOM', status: 'IN_PROGRESS', completionDueDate: dateOnly(10) });
      const o4 = await order({ orderNo: 'ORD-260420-001', contractId: ct3, transactionType: 'CUSTOM', status: 'COMPLETED', completionDueDate: dateOnly(-60) });
      const o5 = await order({ orderNo: 'ORD-260420-002', contractId: ct3, transactionType: 'RENTAL', status: 'IN_PROGRESS' });

      // 품목·구성품 ----------------------------------------------------------
      const orderItem = async (args: {
        orderId: string; lineId: string; productCategory: string; sequenceNo: number;
        displayName: string; status: string;
      }): Promise<string> => {
        const id = uuid();
        await tx.orderItem.create({
          data: {
            id,
            orderId: args.orderId,
            sourceContractLineId: args.lineId,
            productCategory: args.productCategory,
            sequenceNo: args.sequenceNo,
            displayName: args.displayName,
            status: args.status,
          },
        });
        return id;
      };
      const component = async (args: {
        orderItemId: string; componentType: string; status: string;
        expectedInboundDate?: Date; actualInboundAt?: Date; actualOutboundAt?: Date; notes?: string;
      }): Promise<string> => {
        const id = uuid();
        await tx.orderItemComponent.create({
          data: {
            id,
            orderItemId: args.orderItemId,
            componentType: args.componentType,
            sequenceNo: 1,
            status: args.status,
            expectedInboundDate: args.expectedInboundDate ?? null,
            actualInboundAt: args.actualInboundAt ?? null,
            actualOutboundAt: args.actualOutboundAt ?? null,
            notes: args.notes ?? null,
          },
        });
        return id;
      };

      // 김민준 맞춤(o1): 정장 #1(주문 준비 완료) / 정장 #2(옵션 진행 중)
      const oi1 = await orderItem({ orderId: o1, lineId: ct1v2.lineIds[0], productCategory: 'SUIT', sequenceNo: 1, displayName: '정장 #1', status: 'READY_TO_ORDER' });
      const oi2 = await orderItem({ orderId: o1, lineId: ct1v2.lineIds[0], productCategory: 'SUIT', sequenceNo: 2, displayName: '정장 #2', status: 'OPTION_PENDING' });
      await component({ orderItemId: oi1, componentType: 'JACKET', status: 'CREATED' });
      await component({ orderItemId: oi1, componentType: 'TROUSERS', status: 'CREATED' });
      await component({ orderItemId: oi2, componentType: 'JACKET', status: 'CREATED' });
      await component({ orderItemId: oi2, componentType: 'TROUSERS', status: 'CREATED' });

      // 김민준 렌탈(o2): 렌탈 정장 #1 / 렌탈 구두 #1 (오늘 픽업 예약 배정)
      const oi3 = await orderItem({ orderId: o2, lineId: ct1v2.lineIds[1], productCategory: 'SUIT', sequenceNo: 1, displayName: '렌탈 정장 #1', status: 'CREATED' });
      const oi4 = await orderItem({ orderId: o2, lineId: ct1v2.lineIds[2], productCategory: 'SHOES', sequenceNo: 1, displayName: '렌탈 구두 #1', status: 'CREATED' });
      const cmpMjJacket = await component({ orderItemId: oi3, componentType: 'JACKET', status: 'RESERVED' });
      const cmpMjTrousers = await component({ orderItemId: oi3, componentType: 'TROUSERS', status: 'RESERVED' });
      const cmpMjShoes = await component({ orderItemId: oi4, componentType: 'SHOES', status: 'RESERVED' });

      // 이서연 맞춤(o3): 정장 #1(부분 입고) / 셔츠 #1(입고) / 셔츠 #2(입고 지연)
      const oi5 = await orderItem({ orderId: o3, lineId: ct2v1.lineIds[0], productCategory: 'SUIT', sequenceNo: 1, displayName: '정장 #1', status: 'PARTIALLY_RECEIVED' });
      const oi6 = await orderItem({ orderId: o3, lineId: ct2v1.lineIds[1], productCategory: 'SHIRT', sequenceNo: 1, displayName: '셔츠 #1', status: 'RECEIVED' });
      const oi7 = await orderItem({ orderId: o3, lineId: ct2v1.lineIds[1], productCategory: 'SHIRT', sequenceNo: 2, displayName: '셔츠 #2', status: 'PRODUCTION_IN_PROGRESS' });
      const cmpSyJacket = await component({ orderItemId: oi5, componentType: 'JACKET', status: 'RECEIVED', expectedInboundDate: dateOnly(-2), actualInboundAt: at(-1, 11) });
      const cmpSyTrousers = await component({ orderItemId: oi5, componentType: 'TROUSERS', status: 'PRODUCTION_IN_PROGRESS', expectedInboundDate: dateOnly(3) });
      const cmpSyShirt1 = await component({ orderItemId: oi6, componentType: 'SHIRT', status: 'RECEIVED', expectedInboundDate: dateOnly(-5), actualInboundAt: at(-4, 10) });
      const cmpSyShirt2 = await component({ orderItemId: oi7, componentType: 'SHIRT', status: 'PRODUCTION_IN_PROGRESS', expectedInboundDate: dateOnly(-1), notes: '공장 입고 지연 확인 필요' });

      // 정우성 맞춤(o4): 정장 #1 (출고 완료)
      const oi8 = await orderItem({ orderId: o4, lineId: ct3v1.lineIds[0], productCategory: 'SUIT', sequenceNo: 1, displayName: '정장 #1', status: 'RELEASED' });
      await component({ orderItemId: oi8, componentType: 'JACKET', status: 'RELEASED', expectedInboundDate: dateOnly(-65), actualInboundAt: at(-63, 11), actualOutboundAt: at(-60, 15) });
      await component({ orderItemId: oi8, componentType: 'TROUSERS', status: 'RELEASED', expectedInboundDate: dateOnly(-65), actualInboundAt: at(-63, 11), actualOutboundAt: at(-60, 15) });

      // 정우성 렌탈(o5): 렌탈 정장 #1(대여 중) / 렌탈 구두 #1(반납 지연)
      const oi9 = await orderItem({ orderId: o5, lineId: ct3v1.lineIds[1], productCategory: 'SUIT', sequenceNo: 1, displayName: '렌탈 정장 #1', status: 'RELEASED' });
      const oi10 = await orderItem({ orderId: o5, lineId: ct3v1.lineIds[2], productCategory: 'SHOES', sequenceNo: 1, displayName: '렌탈 구두 #1', status: 'RELEASED' });
      const cmpWsJacket = await component({ orderItemId: oi9, componentType: 'JACKET', status: 'RELEASED', actualOutboundAt: at(-10, 14) });
      const cmpWsTrousers = await component({ orderItemId: oi9, componentType: 'TROUSERS', status: 'RELEASED', actualOutboundAt: at(-10, 14) });
      const cmpWsShoes = await component({ orderItemId: oi10, componentType: 'SHOES', status: 'RELEASED', actualOutboundAt: at(-10, 14) });
      console.log('orders: 5건 / order_items: 10건 / components: 16건');

      // -----------------------------------------------------------------------
      // 4) 옵션 세션
      // -----------------------------------------------------------------------
      // 김민준 정장 #1: 전체 확정 (미주문 데모 — 작업지시서 출력 0건)
      await createOptionSession(tx, {
        orderItemId: oi1, version: suitOptions,
        picks: ['A', 'B', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'B', 'A'],
        status: 'CONFIRMED', fabricName: 'VBC 110수 네이비 솔리드',
        times: { startedAt: at(-24, 14), lastSavedAt: at(-24, 15), reviewedAt: at(-24, 15, 30), confirmedAt: at(-23, 11) },
        adminId,
      });
      // 김민준 정장 #2: 진행 중 (11단계 중 4단계 선택, 5단계 재개 지점)
      await createOptionSession(tx, {
        orderItemId: oi2, version: suitOptions,
        picks: ['A', 'A', 'B', 'A'],
        status: 'IN_PROGRESS', fabricName: '제냐 트로피컬 차콜',
        times: { startedAt: at(-2, 16), lastSavedAt: at(-2, 16, 40) },
        adminId,
      });
      // 이서연 품목들: 모두 확정
      const sessionSy1 = await createOptionSession(tx, {
        orderItemId: oi5, version: suitOptions,
        picks: ['A', 'A', 'A', 'B', 'A', 'A', 'B', 'A', 'B', 'A', 'B'],
        status: 'CONFIRMED', fabricName: '캐논 120수 미디엄그레이',
        times: { startedAt: at(-12, 10), lastSavedAt: at(-12, 11), reviewedAt: at(-12, 11, 20), confirmedAt: at(-9, 10) },
        adminId,
      });
      const sessionSy2 = await createOptionSession(tx, {
        orderItemId: oi6, version: shirtOptions,
        picks: ['A', 'A', 'A'],
        status: 'CONFIRMED', fabricName: '토마스메이슨 화이트 옥스포드',
        times: { startedAt: at(-12, 11, 30), lastSavedAt: at(-12, 11, 50), reviewedAt: at(-12, 12), confirmedAt: at(-9, 10, 10) },
        adminId,
      });
      const sessionSy3 = await createOptionSession(tx, {
        orderItemId: oi7, version: shirtOptions,
        picks: ['B', 'A', 'B'],
        status: 'CONFIRMED', fabricName: '토마스메이슨 스카이블루',
        times: { startedAt: at(-12, 12, 10), lastSavedAt: at(-12, 12, 30), reviewedAt: at(-12, 12, 40), confirmedAt: at(-9, 10, 20) },
        adminId,
      });
      // 정우성 정장 #1: 확정 (완료 계약 이력)
      const sessionWs = await createOptionSession(tx, {
        orderItemId: oi8, version: suitOptions,
        picks: ['B', 'A', 'A', 'A', 'B', 'A', 'A', 'B', 'A', 'A', 'B'],
        status: 'CONFIRMED', fabricName: '레다 130수 다크네이비',
        times: { startedAt: at(-80, 14), lastSavedAt: at(-80, 15), reviewedAt: at(-80, 15, 10), confirmedAt: at(-78, 11) },
        adminId,
      });
      console.log('option_selection_sessions: 6건 (확정 5·진행중 1)');

      // -----------------------------------------------------------------------
      // 5) 채촌 (김민준 2버전 INITIAL/FITTING, 이서연 1버전, 정우성 1버전)
      // -----------------------------------------------------------------------
      const mjV1 = await createMeasurementSession(tx, {
        customerId: 김민준, relatedOrderId: o1, versionNo: 1,
        measurementDate: dateOnly(-28), measurementType: 'INITIAL',
        fitPreference: '슬림하게, 허리 여유 최소',
        bodyNotes: '오른쪽 어깨가 살짝 처짐',
        completedAt: at(-28, 15),
        rows: measurementRows({
          neck: 38.5, shoulder: 45.0, chest: 96.0, sleeve: 61.0, bodyLength: 72.0, wrist: 16.5,
          upperSize: '100', waist: 82.0, hip: 96.5, rise: 26.0, pantsLength: 104.0, thigh: 58.0,
          calf: 38.0, lowerSize: '32', shoeSize: 265,
        }),
        adminId,
      });
      const mjV2 = await createMeasurementSession(tx, {
        customerId: 김민준, relatedOrderId: o1, versionNo: 2,
        measurementDate: dateOnly(-7), measurementType: 'FITTING',
        previousSessionId: mjV1.id,
        fitPreference: '슬림하게, 허리 여유 최소',
        bodyNotes: '가봉 후 가슴 +1cm, 허리 -0.5cm 보정',
        completedAt: at(-7, 16),
        rows: measurementRows({
          neck: 38.5, shoulder: 45.0, chest: 97.0, sleeve: 61.5, bodyLength: 72.0, wrist: 16.5,
          upperSize: '100', waist: 81.5, hip: 96.5, rise: 26.0, pantsLength: 103.5, thigh: 57.5,
          calf: 38.0, lowerSize: '32', shoeSize: 265,
        }),
        adminId,
      });
      const syV1 = await createMeasurementSession(tx, {
        customerId: 이서연, relatedOrderId: o3, versionNo: 1,
        measurementDate: dateOnly(-10), measurementType: 'INITIAL',
        fitPreference: '표준핏, 팔 움직임 여유',
        completedAt: at(-10, 11),
        rows: measurementRows({
          neck: 34.0, shoulder: 40.5, chest: 88.0, sleeve: 56.0, bodyLength: 64.0, wrist: 15.0,
          upperSize: '90', waist: 68.0, hip: 92.0, rise: 25.0, pantsLength: 98.0, thigh: 52.0,
          calf: 34.0, lowerSize: '27', shoeSize: 240,
        }),
        adminId,
      });
      const wsV1 = await createMeasurementSession(tx, {
        customerId: 정우성, relatedOrderId: o4, versionNo: 1,
        measurementDate: dateOnly(-80), measurementType: 'INITIAL',
        completedAt: at(-80, 16),
        rows: measurementRows({
          neck: 40.0, shoulder: 47.0, chest: 100.0, sleeve: 63.0, bodyLength: 75.0, wrist: 17.0,
          upperSize: '105', waist: 86.0, hip: 99.0, rise: 27.0, pantsLength: 107.0, thigh: 60.0,
          calf: 39.5, lowerSize: '34', shoeSize: 275,
        }),
        adminId,
      });

      // 품목 연결 (is_current)
      const linkMeasurement = async (
        orderItemId: string, sessionId: string, isCurrent: boolean, linkedAt: Date,
      ): Promise<void> => {
        await tx.orderItemMeasurement.create({
          data: { id: uuid(), orderItemId, measurementSessionId: sessionId, isCurrent, linkedBy: adminId, linkedAt },
        });
      };
      await linkMeasurement(oi1, mjV1.id, false, at(-27, 10)); // 이전 연결 이력
      await linkMeasurement(oi1, mjV2.id, true, at(-7, 17));
      await linkMeasurement(oi5, syV1.id, true, at(-2, 15)); // V1 출력 이후 재연결 → 재출력 필요 데모
      await linkMeasurement(oi6, syV1.id, true, at(-9, 11));
      await linkMeasurement(oi7, syV1.id, true, at(-9, 11));
      await linkMeasurement(oi8, wsV1.id, true, at(-78, 12));
      console.log('measurement_sessions: 4건 (값 60, 품목 연결 6)');

      // -----------------------------------------------------------------------
      // 6) 작업지시서 (이서연 정장 #1 V1·V2 이력, 김민준 정장 #1은 출력 0건)
      // -----------------------------------------------------------------------
      const createWorkOrder = async (orderItemId: string): Promise<string> => {
        const id = uuid();
        await tx.workOrder.create({ data: { id, orderItemId } });
        return id;
      };
      // 이서연 정장 #1: V1(대체됨) → V2(현재)
      const woSy1 = await createWorkOrder(oi5);
      await issueWorkOrderVersion(tx, {
        workOrderId: woSy1, versionNo: 1, orderNo: 'ORD-260705-001', productCategory: 'SUIT', sequenceNo: 1,
        optionSessionId: sessionSy1, measurement: syV1, issuedAt: at(-8, 14), status: 'SUPERSEDED', adminId,
      });
      const woSy1v2 = await issueWorkOrderVersion(tx, {
        workOrderId: woSy1, versionNo: 2, orderNo: 'ORD-260705-001', productCategory: 'SUIT', sequenceNo: 1,
        optionSessionId: sessionSy1, measurement: syV1, issuedAt: at(-8, 16), status: 'ISSUED',
        changeReason: '원단 로트 변경 반영 재출력', adminId,
      });
      await tx.workOrder.update({ where: { id: woSy1 }, data: { currentVersionId: woSy1v2 } });
      // 이서연 셔츠 #1·#2: V1 (셔츠 #1은 이후 채촌 재연결로 재출력 필요 상태)
      const woSy2 = await createWorkOrder(oi6);
      const woSy2v1 = await issueWorkOrderVersion(tx, {
        workOrderId: woSy2, versionNo: 1, orderNo: 'ORD-260705-001', productCategory: 'SHIRT', sequenceNo: 1,
        optionSessionId: sessionSy2, measurement: syV1, issuedAt: at(-8, 14, 20), status: 'ISSUED', adminId,
      });
      await tx.workOrder.update({ where: { id: woSy2 }, data: { currentVersionId: woSy2v1 } });
      const woSy3 = await createWorkOrder(oi7);
      const woSy3v1 = await issueWorkOrderVersion(tx, {
        workOrderId: woSy3, versionNo: 1, orderNo: 'ORD-260705-001', productCategory: 'SHIRT', sequenceNo: 2,
        optionSessionId: sessionSy3, measurement: syV1, issuedAt: at(-8, 14, 40), status: 'ISSUED', adminId,
      });
      await tx.workOrder.update({ where: { id: woSy3 }, data: { currentVersionId: woSy3v1 } });
      // 정우성 정장 #1: V1 (완료 이력)
      const woWs = await createWorkOrder(oi8);
      const woWsV1 = await issueWorkOrderVersion(tx, {
        workOrderId: woWs, versionNo: 1, orderNo: 'ORD-260420-001', productCategory: 'SUIT', sequenceNo: 1,
        optionSessionId: sessionWs, measurement: wsV1, issuedAt: at(-75, 10), status: 'SENT', adminId,
      });
      await tx.workOrder.update({ where: { id: woWs }, data: { currentVersionId: woWsV1 } });
      console.log('work_orders: 4건 / work_order_versions: 5건 (이서연 정장 V1·V2)');

      // -----------------------------------------------------------------------
      // 7) 제작 이벤트 (부분 입고·입고 지연 이력)
      // -----------------------------------------------------------------------
      const productionEvent = async (args: {
        orderItemId: string; componentId?: string; eventType: string;
        previousStatus?: string; newStatus: string; expectedDate?: Date; eventDate: Date; notes?: string;
      }): Promise<void> => {
        await tx.productionEvent.create({
          data: {
            id: uuid(),
            orderItemId: args.orderItemId,
            componentId: args.componentId ?? null,
            eventType: args.eventType,
            previousStatus: args.previousStatus ?? null,
            newStatus: args.newStatus,
            expectedDate: args.expectedDate ?? null,
            eventDate: args.eventDate,
            notes: args.notes ?? null,
            actorId: adminId,
          },
        });
      };
      await productionEvent({ orderItemId: oi5, componentId: cmpSyJacket, eventType: 'PRODUCTION_IN_PROGRESS', previousStatus: 'CREATED', newStatus: 'PRODUCTION_IN_PROGRESS', expectedDate: dateOnly(-2), eventDate: dateOnly(-8) });
      await productionEvent({ orderItemId: oi5, componentId: cmpSyJacket, eventType: 'RECEIVED', previousStatus: 'PRODUCTION_IN_PROGRESS', newStatus: 'RECEIVED', eventDate: dateOnly(-1), notes: '자켓 입고' });
      await productionEvent({ orderItemId: oi5, componentId: cmpSyTrousers, eventType: 'PRODUCTION_IN_PROGRESS', previousStatus: 'CREATED', newStatus: 'PRODUCTION_IN_PROGRESS', expectedDate: dateOnly(3), eventDate: dateOnly(-8) });
      await productionEvent({ orderItemId: oi5, eventType: 'ITEM_STATUS_AGGREGATED', previousStatus: 'PRODUCTION_IN_PROGRESS', newStatus: 'PARTIALLY_RECEIVED', eventDate: dateOnly(-1), notes: '자켓만 입고 (부분 입고)' });
      await productionEvent({ orderItemId: oi6, componentId: cmpSyShirt1, eventType: 'RECEIVED', previousStatus: 'PRODUCTION_IN_PROGRESS', newStatus: 'RECEIVED', eventDate: dateOnly(-4) });
      await productionEvent({ orderItemId: oi7, componentId: cmpSyShirt2, eventType: 'PRODUCTION_IN_PROGRESS', previousStatus: 'CREATED', newStatus: 'PRODUCTION_IN_PROGRESS', expectedDate: dateOnly(-1), eventDate: dateOnly(-8), notes: '입고 예정일 경과 — 지연 데모' });
      console.log('production_events: 6건');

      // -----------------------------------------------------------------------
      // 8) 렌탈 SKU·실물 20·배정
      // -----------------------------------------------------------------------
      const sku = async (componentType: string, design: string, color: string, size: string): Promise<string> => {
        const id = uuid();
        await tx.rentalSku.create({ data: { id, componentType, design, color, size, active: true } });
        return id;
      };
      const skuJktBlk100 = await sku('JACKET', '클래식 원버튼 턱시도', 'BLACK', '100');
      const skuJktBlk105 = await sku('JACKET', '클래식 원버튼 턱시도', 'BLACK', '105');
      const skuJktNvy100 = await sku('JACKET', '모던 스트라이프', 'NAVY', '100');
      const skuPntBlk32 = await sku('TROUSERS', '클래식 턱시도 팬츠', 'BLACK', '32');
      const skuPntBlk34 = await sku('TROUSERS', '클래식 턱시도 팬츠', 'BLACK', '34');
      const skuVstBlk100 = await sku('VEST', '클래식 베스트', 'BLACK', '100');
      const skuShtWht100 = await sku('SHIRT', '윙칼라 셔츠', 'WHITE', '100');
      const skuShoBlk270 = await sku('SHOES', '스트레이트팁 옥스포드', 'BLACK', '270');
      const skuShoBlk275 = await sku('SHOES', '스트레이트팁 옥스포드', 'BLACK', '275');

      const inventoryItems: Record<string, string> = {};
      const inventory = async (managementCode: string, rentalSkuId: string, status: string, extra?: {
        availableFrom?: Date; notes?: string;
      }): Promise<string> => {
        const id = uuid();
        await tx.rentalInventoryItem.create({
          data: {
            id,
            managementCode,
            rentalSkuId,
            status,
            availableFrom: extra?.availableFrom ?? null,
            notes: extra?.notes ?? null,
            active: true,
            acquiredAt: dateOnly(-180),
          },
        });
        inventoryItems[managementCode] = id;
        return id;
      };
      await inventory('JKT-BLK-100-001', skuJktBlk100, 'RESERVED'); // 김민준 배정
      await inventory('JKT-BLK-100-002', skuJktBlk100, 'AVAILABLE');
      await inventory('JKT-BLK-100-003', skuJktBlk100, 'ALTERATION', { availableFrom: dateOnly(7), notes: '소매 안감 수선 중' }); // 수선 중 실물
      await inventory('JKT-BLK-105-001', skuJktBlk105, 'CHECKED_OUT'); // 정우성 대여 중
      await inventory('JKT-BLK-105-002', skuJktBlk105, 'AVAILABLE');
      await inventory('JKT-NVY-100-001', skuJktNvy100, 'AVAILABLE');
      await inventory('PNT-BLK-32-001', skuPntBlk32, 'AVAILABLE');
      await inventory('PNT-BLK-32-002', skuPntBlk32, 'AVAILABLE');
      await inventory('PNT-BLK-32-003', skuPntBlk32, 'AVAILABLE');
      await inventory('PNT-BLK-32-004', skuPntBlk32, 'RESERVED'); // 김민준 배정
      await inventory('PNT-BLK-34-001', skuPntBlk34, 'CHECKED_OUT'); // 정우성 대여 중
      await inventory('PNT-BLK-34-002', skuPntBlk34, 'AVAILABLE');
      await inventory('VST-BLK-100-001', skuVstBlk100, 'AVAILABLE');
      await inventory('VST-BLK-100-002', skuVstBlk100, 'AVAILABLE');
      await inventory('SHT-WHT-100-001', skuShtWht100, 'AVAILABLE');
      await inventory('SHT-WHT-100-002', skuShtWht100, 'AVAILABLE');
      await inventory('SHO-BLK-270-001', skuShoBlk270, 'CHECKED_OUT'); // 정우성 반납 지연
      await inventory('SHO-BLK-270-002', skuShoBlk270, 'RESERVED'); // 김민준 배정
      await inventory('SHO-BLK-270-003', skuShoBlk270, 'AVAILABLE');
      await inventory('SHO-BLK-275-001', skuShoBlk275, 'AVAILABLE');

      const allocation = async (args: {
        componentId: string; managementCode: string; pickupDate: Date; returnDueDate: Date;
        availabilityEndDate: Date; status: 'RESERVED' | 'CHECKED_OUT'; assignedAt: Date; actualPickupAt?: Date;
      }): Promise<void> => {
        const id = uuid();
        const itemId = inventoryItems[args.managementCode];
        await tx.rentalAllocation.create({
          data: {
            id,
            orderItemComponentId: args.componentId,
            rentalInventoryItemId: itemId,
            pickupDate: args.pickupDate,
            returnDueDate: args.returnDueDate,
            availabilityEndDate: args.availabilityEndDate,
            actualPickupAt: args.actualPickupAt ?? null,
            status: args.status,
            assignedBy: adminId,
            assignedAt: args.assignedAt,
          },
        });
        await tx.rentalAllocationEvent.create({
          data: {
            id: uuid(), rentalAllocationId: id, eventType: 'ASSIGNED',
            newInventoryItemId: itemId, actorId: adminId, occurredAt: args.assignedAt,
          },
        });
        if (args.status === 'CHECKED_OUT' && args.actualPickupAt) {
          await tx.rentalAllocationEvent.create({
            data: {
              id: uuid(), rentalAllocationId: id, eventType: 'PICKED_UP',
              newInventoryItemId: itemId, actorId: adminId, occurredAt: args.actualPickupAt,
            },
          });
        }
      };

      // 김민준: 오늘 픽업 예약 3건 (RESERVED)
      await allocation({ componentId: cmpMjJacket, managementCode: 'JKT-BLK-100-001', pickupDate: dateOnly(0), returnDueDate: dateOnly(3), availabilityEndDate: dateOnly(5), status: 'RESERVED', assignedAt: at(-2, 11) });
      await allocation({ componentId: cmpMjTrousers, managementCode: 'PNT-BLK-32-004', pickupDate: dateOnly(0), returnDueDate: dateOnly(3), availabilityEndDate: dateOnly(5), status: 'RESERVED', assignedAt: at(-2, 11) });
      await allocation({ componentId: cmpMjShoes, managementCode: 'SHO-BLK-270-002', pickupDate: dateOnly(0), returnDueDate: dateOnly(3), availabilityEndDate: dateOnly(5), status: 'RESERVED', assignedAt: at(-2, 11) });
      // 정우성: 렌탈 정장 대여 중 (자켓·팬츠, 반납 예정 +3)
      await allocation({ componentId: cmpWsJacket, managementCode: 'JKT-BLK-105-001', pickupDate: dateOnly(-10), returnDueDate: dateOnly(3), availabilityEndDate: dateOnly(5), status: 'CHECKED_OUT', assignedAt: at(-12, 10), actualPickupAt: at(-10, 14) });
      await allocation({ componentId: cmpWsTrousers, managementCode: 'PNT-BLK-34-001', pickupDate: dateOnly(-10), returnDueDate: dateOnly(3), availabilityEndDate: dateOnly(5), status: 'CHECKED_OUT', assignedAt: at(-12, 10), actualPickupAt: at(-10, 14) });
      // 정우성: 렌탈 구두 반납 지연 (반납 예정 -2 경과, CHECKED_OUT 유지)
      await allocation({ componentId: cmpWsShoes, managementCode: 'SHO-BLK-270-001', pickupDate: dateOnly(-10), returnDueDate: dateOnly(-2), availabilityEndDate: dateOnly(0), status: 'CHECKED_OUT', assignedAt: at(-12, 10), actualPickupAt: at(-10, 14) });

      // 수선 중 실물 상태 이력
      await tx.rentalInventoryStatusEvent.create({
        data: {
          id: uuid(), rentalInventoryItemId: inventoryItems['JKT-BLK-100-003'],
          previousStatus: 'AVAILABLE', newStatus: 'ALTERATION', availableFrom: dateOnly(7),
          reason: '소매 안감 수선', actorId: adminId, occurredAt: at(-3, 10),
        },
      });
      console.log('rental_skus: 9건 / rental_inventory_items: 20건 / rental_allocations: 6건');

      // -----------------------------------------------------------------------
      // 9) 수선 3건 (맞춤 사후 / 렌탈 실물 / 일반)
      // -----------------------------------------------------------------------
      const repair = async (args: {
        customerId: string; repairType: string; requestDate: Date; dueDate?: Date; status: string;
        description: string; cost?: number; orderId?: string; orderItemId?: string;
        rentalInventoryItemId?: string; notes?: string;
        events: Array<{ previousStatus?: string; newStatus: string; eventDate: Date }>;
      }): Promise<void> => {
        const id = uuid();
        await tx.repairRequest.create({
          data: {
            id,
            customerId: args.customerId,
            orderId: args.orderId ?? null,
            orderItemId: args.orderItemId ?? null,
            rentalInventoryItemId: args.rentalInventoryItemId ?? null,
            repairType: args.repairType,
            requestDate: args.requestDate,
            dueDate: args.dueDate ?? null,
            status: args.status,
            description: args.description,
            cost: args.cost ?? null,
            notes: args.notes ?? null,
          },
        });
        for (const e of args.events) {
          await tx.repairStatusEvent.create({
            data: {
              id: uuid(), repairRequestId: id, previousStatus: e.previousStatus ?? null,
              newStatus: e.newStatus, eventDate: e.eventDate, actorId: adminId,
            },
          });
        }
      };
      // 맞춤 사후 수선: 정우성 정장 #1 바지 기장
      await repair({
        customerId: 정우성, repairType: 'AFTER_SALE', requestDate: dateOnly(-7), dueDate: dateOnly(2),
        status: 'IN_PROGRESS', description: '바지 기장 1.5cm 줄임', cost: 30000,
        orderId: o4, orderItemId: oi8,
        events: [
          { newStatus: 'RECEIVED', eventDate: dateOnly(-7) },
          { previousStatus: 'RECEIVED', newStatus: 'IN_PROGRESS', eventDate: dateOnly(-5) },
        ],
      });
      // 렌탈 실물 수선: JKT-BLK-100-003 (반납 후 수선 중)
      await repair({
        customerId: 정우성, repairType: 'RENTAL_POST', requestDate: dateOnly(-3), dueDate: dateOnly(7),
        status: 'IN_PROGRESS', description: '자켓 소매 안감 뜯어짐 수선',
        rentalInventoryItemId: inventoryItems['JKT-BLK-100-003'],
        notes: '반납 검수 중 발견',
        events: [
          { newStatus: 'RECEIVED', eventDate: dateOnly(-3) },
          { previousStatus: 'RECEIVED', newStatus: 'IN_PROGRESS', eventDate: dateOnly(-2) },
        ],
      });
      // 일반 수선: 강하늘 (외부 의류 반입)
      await repair({
        customerId: 강하늘, repairType: 'GENERAL', requestDate: dateOnly(-1), dueDate: dateOnly(5),
        status: 'RECEIVED', description: '외부 구입 자켓 소매 기장 수선', cost: 20000,
        events: [{ newStatus: 'RECEIVED', eventDate: dateOnly(-1) }],
      });
      console.log('repair_requests: 3건');

      // -----------------------------------------------------------------------
      // 10) 결제 (계약금 완료 · 김민준 잔금 미수, 정우성 완납)
      // -----------------------------------------------------------------------
      const payment = async (args: {
        contractId: string; paymentType: string; amount: number; paymentDate: Date;
        paymentMethod: string; memo?: string;
      }): Promise<void> => {
        await tx.payment.create({
          data: {
            id: uuid(),
            contractId: args.contractId,
            paymentType: args.paymentType,
            amount: args.amount,
            paymentDate: args.paymentDate,
            paymentMethod: args.paymentMethod,
            status: 'COMPLETED',
            memo: args.memo ?? null,
            createdBy: adminId,
          },
        });
      };
      await payment({ contractId: ct1, paymentType: 'DEPOSIT', amount: 1000000, paymentDate: dateOnly(-30), paymentMethod: 'CARD', memo: '입금자: 김민준' });
      await payment({ contractId: ct2, paymentType: 'DEPOSIT', amount: 500000, paymentDate: dateOnly(-15), paymentMethod: 'TRANSFER', memo: '입금자: 이서연' });
      await payment({ contractId: ct3, paymentType: 'DEPOSIT', amount: 500000, paymentDate: dateOnly(-85), paymentMethod: 'CARD' });
      await payment({ contractId: ct3, paymentType: 'BALANCE', amount: 1000000, paymentDate: dateOnly(-60), paymentMethod: 'CARD', memo: '잔금 완납' });
      console.log('payments: 4건 (김민준 잔금 2,200,000 미수·예정일 경과)');

      // -----------------------------------------------------------------------
      // 11) 알림 템플릿 3종 (승인 상태)
      // -----------------------------------------------------------------------
      const templates = [
        {
          code: 'FITTING_REMINDER', name: '가봉 예약 안내', channel: 'ALIMTALK',
          body: '[테일러샵] #{고객명}님, #{예약일시} 가봉 예약 안내드립니다. 방문 전 변경이 필요하면 연락 부탁드립니다.',
        },
        {
          code: 'PICKUP_READY', name: '제품 준비 완료 안내', channel: 'ALIMTALK',
          body: '[테일러샵] #{고객명}님, 주문하신 #{품목명}이 준비되었습니다. 편하신 시간에 방문해 주세요.',
        },
        {
          code: 'RENTAL_RETURN_REMINDER', name: '렌탈 반납 예정 안내', channel: 'SMS',
          body: '[테일러샵] #{고객명}님, 렌탈 반납 예정일은 #{반납예정일}입니다. 기한 내 반납 부탁드립니다.',
        },
      ];
      for (const t of templates) {
        await tx.notificationTemplate.create({
          data: { id: uuid(), code: t.code, name: t.name, channel: t.channel, body: t.body, approvalStatus: 'APPROVED' },
        });
      }
      console.log('notification_templates: 3건 (APPROVED)');

      // -----------------------------------------------------------------------
      // 12) 공유 메모 2건
      // -----------------------------------------------------------------------
      await tx.sharedNote.create({
        data: {
          id: uuid(),
          content: '김민준 고객 웨딩 촬영 일정이 앞당겨질 수 있음 — 오늘 렌탈 픽업 시 일정 재확인 필요',
          authorId: adminId, status: 'ACTIVE', createdAt: at(-1, 18),
        },
      });
      await tx.sharedNote.create({
        data: {
          id: uuid(),
          content: '이번 주 금요일 공장 휴무 — 발주·입고 일정 확인 후 고객 안내할 것',
          authorId: adminId, status: 'ACTIVE', createdAt: at(0, 9),
        },
      });
      console.log('shared_notes: 2건');

      // -----------------------------------------------------------------------
      // 13) 예약 10건 (오늘 6건 분산, NAVER/CRM 혼합) + 상담 2건
      // -----------------------------------------------------------------------
      const appointment = async (args: {
        customerId: string; purposeCode: string; start: Date; end: Date; status: string;
        source?: 'CRM' | 'NAVER'; externalId?: string; notes?: string;
        naverUpdatedAt?: Date; syncedAt?: Date;
      }): Promise<string> => {
        const id = uuid();
        await tx.appointment.create({
          data: {
            id,
            customerId: args.customerId,
            source: args.source ?? 'CRM',
            externalId: args.externalId ?? null,
            purposeId: purposeId(args.purposeCode),
            scheduledStart: args.start,
            scheduledEnd: args.end,
            status: args.status,
            notes: args.notes ?? null,
            naverUpdatedAt: args.naverUpdatedAt ?? null,
            syncedAt: args.syncedAt ?? null,
          },
        });
        return id;
      };

      // 오늘 6건
      await appointment({ customerId: 정우성, purposeCode: 'RENTAL_RETURN', start: at(0, 9, 30), end: at(0, 10), status: 'RESERVED', notes: '렌탈 구두 반납(지연분 포함) 예정' });
      await appointment({ customerId: 김민준, purposeCode: 'RENTAL_PICKUP', start: at(0, 10, 30), end: at(0, 11), status: 'CONFIRMED', notes: '촬영용 렌탈 정장·구두 픽업' });
      const apPjh = await appointment({
        customerId: 박지훈, purposeCode: 'INITIAL_CONSULTATION', start: at(0, 11, 30), end: at(0, 12),
        status: 'RESERVED', source: 'NAVER', externalId: 'NV-DEMO-0001',
        naverUpdatedAt: at(-3, 10), syncedAt: at(0, 8), notes: '네이버 예약 유입',
      });
      await appointment({
        customerId: 최수아, purposeCode: 'INITIAL_CONSULTATION', start: at(0, 13, 30), end: at(0, 14),
        status: 'RESERVED', source: 'NAVER', externalId: 'NV-DEMO-0002',
        naverUpdatedAt: at(0, 7, 30), syncedAt: at(-1, 18), notes: '네이버에서 시간 변경됨 — 동기화 확인 필요',
      });
      await appointment({ customerId: 이서연, purposeCode: 'FITTING', start: at(0, 15), end: at(0, 16), status: 'CONFIRMED', notes: '정장 #1 가봉 (자켓 입고분)' });
      await appointment({ customerId: 정우성, purposeCode: 'REPAIR_PICKUP', start: at(0, 17), end: at(0, 17, 30), status: 'RESERVED', notes: '바지 기장 수선 픽업' });
      // 과거 2건 (초도상담 이력)
      const apMj = await appointment({ customerId: 김민준, purposeCode: 'INITIAL_CONSULTATION', start: at(-40, 11), end: at(-40, 12), status: 'VISITED' });
      const apSy = await appointment({ customerId: 이서연, purposeCode: 'INITIAL_CONSULTATION', start: at(-20, 14), end: at(-20, 15), status: 'VISITED' });
      // 미래 2건
      await appointment({ customerId: 김민준, purposeCode: 'FITTING', start: at(2, 14), end: at(2, 15), status: 'RESERVED', notes: '정장 #1 가봉' });
      await appointment({ customerId: 이서연, purposeCode: 'PICKUP', start: at(7, 15), end: at(7, 15, 30), status: 'RESERVED', notes: '셔츠 #1 픽업 (입고 완료분)' });

      // 상담 2건
      await tx.consultation.create({
        data: {
          id: uuid(), customerId: 김민준, appointmentId: apMj, consultedAt: at(-40, 11, 30),
          consultationCategory: '웨딩,맞춤정장,렌탈',
          content: '웨딩 촬영·예식용 패키지 상담. 촬영 일정 촉박해 렌탈 우선 배정 요청. 예산 300만원대.',
          staffId: adminId,
        },
      });
      await tx.consultation.create({
        data: {
          id: uuid(), customerId: 이서연, appointmentId: apSy, consultedAt: at(-20, 14, 30),
          consultationCategory: '비즈니스,맞춤정장',
          content: '출근용 정장 1벌 + 셔츠 2장 맞춤 상담. 그레이 계열 선호, 표준핏 요청.',
          staffId: adminId,
        },
      });
      void apPjh;
      console.log('appointments: 10건 (오늘 6·NAVER 2) / consultations: 2건');
    },
    { maxWait: 15000, timeout: 300000 },
  );

  console.log('데모 시드 완료');
}

main()
  .catch((error) => {
    console.error('데모 시드 실패:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
