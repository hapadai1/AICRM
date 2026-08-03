/**
 * 채촌 기록 점검용 데모 데이터
 *
 * 채촌 화면 맨 위 [저장한 채촌] 줄은 기록이 있을 때만 나온다(현업 확정 2026-08-01).
 * 그 두 갈래 — 있을 때 / 없을 때 — 를 눈으로 바로 확인하려면 양쪽 고객이 다 있어야 한다.
 * 이 시드는 세 명을 만든다.
 *
 *   채촌01 여러회차 : 4건 — 스타일 컨설팅 · 가봉 1회차 · 가봉 2회차 · 수선(작성중)
 *   채촌02 한건     : 1건 — 스타일 컨설팅 (한 건뿐이면 회차를 안 붙인다)
 *   채촌03 기록없음 : 0건 — [저장한 채촌] 줄이 아예 나오지 않아야 한다
 *
 * 전화번호는 010-7788-#### 대역을 쓴다 — 단계별 데모(010-7777-…)와 섞이지 않는다.
 *
 * - 전제: prisma/seed.ts(기본)로 admin 계정이 있어야 한다.
 * - 재실행 안전: 돌릴 때마다 **이 시드가 만든 010-7788 대역만** 지우고 다시 만든다.
 * - 실행: npm run seed:measurements
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

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

// -----------------------------------------------------------------------------
// 채촌 값
// -----------------------------------------------------------------------------

type MeasureRow = [string, string, number, string, number];

/**
 * 상·하의 한 벌치 치수.
 * drift 로 기록마다 살짝 흔든다 — 전부 같은 값이면 비교 화면에서 차이가 안 보인다.
 */
function measurementRows(drift: number): MeasureRow[] {
  const d = drift;
  return [
    ['JACKET_LENGTH', 'UPPER', 74 + d, 'CM', 10],
    ['SHOULDER', 'UPPER', 45 + d * 0.2, 'CM', 20],
    ['FRONT_WIDTH', 'UPPER', 39 + d * 0.3, 'CM', 30],
    ['BACK_WIDTH', 'UPPER', 42 + d * 0.3, 'CM', 40],
    ['CHEST_UPPER', 'UPPER', 100 + d, 'CM', 50],
    ['CHEST_MID', 'UPPER', 94 + d, 'CM', 60],
    ['CHEST_LOW', 'UPPER', 96 + d, 'CM', 70],
    ['SLEEVE_LEFT', 'UPPER', 62 + d * 0.2, 'CM', 80],
    ['SLEEVE_RIGHT', 'UPPER', 62 + d * 0.2, 'CM', 90],
    ['SLEEVE_WIDTH', 'UPPER', 34 + d * 0.3, 'CM', 100],
    ['SLEEVE_OPENING', 'UPPER', 15 + d * 0.2, 'CM', 110],
    ['WAIST', 'LOWER', 84 + d, 'CM', 210],
    ['HIP', 'LOWER', 98 + d, 'CM', 220],
    ['THIGH', 'LOWER', 58 + d * 0.5, 'CM', 230],
    ['FRONT_RISE', 'LOWER', 25 + d * 0.3, 'CM', 240],
    ['BACK_RISE', 'LOWER', 33 + d * 0.3, 'CM', 250],
    ['KNEE', 'LOWER', 44 + d * 0.5, 'CM', 260],
    ['PANTS_OPENING', 'LOWER', 19 + d * 0.2, 'CM', 270],
    ['PANTS_LENGTH', 'LOWER', 100 + d, 'CM', 280],
  ];
}

interface RecordSpec {
  /** 채촌 구분 — INITIAL(스타일 컨설팅) · FITTING(가봉) · REMEASURE(수선) */
  measurementType: string;
  /** 오늘 기준 며칠 전에 잰 기록인가 */
  daysAgo: number;
  /** false 면 '작성중'으로 남는다 */
  completed: boolean;
  /** 치수 흔들기 값 */
  drift: number;
  fitPreference?: string;
  notes?: string;
}

/** 한 고객의 채촌 기록을 오래된 것부터 순서대로 만든다 (직전 기록으로 사슬을 잇는다). */
async function createRecords(
  tx: Tx,
  args: { customerId: string; adminId: string; specs: RecordSpec[] },
): Promise<number> {
  let previousSessionId: string | null = null;
  let versionNo = 0;

  for (const spec of args.specs) {
    const id = uuid();
    versionNo += 1;
    await tx.measurementSession.create({
      data: {
        id,
        customerId: args.customerId,
        versionNo,
        measurementDate: dateOnly(-spec.daysAgo),
        measurementType: spec.measurementType,
        previousSessionId,
        fitPreference: spec.fitPreference ?? null,
        notes: spec.notes ?? null,
        completedAt: spec.completed ? at(-spec.daysAgo, 15) : null,
        createdBy: args.adminId,
      },
    });
    for (const [code, bodySection, numericValue, unit, sortOrder] of measurementRows(spec.drift)) {
      await tx.measurementValue.create({
        data: {
          id: uuid(),
          measurementSessionId: id,
          bodySection,
          measurementCode: code,
          numericValue,
          unit,
          sortOrder,
        },
      });
    }
    previousSessionId = id;
  }
  return args.specs.length;
}

async function createCustomer(
  tx: Tx,
  args: { seq: number; name: string; adminId: string; specs: RecordSpec[] },
): Promise<{ name: string; count: number }> {
  const customerId = uuid();
  const tail = String(args.seq).padStart(4, '0');
  await tx.customer.create({
    data: {
      id: customerId,
      name: args.name,
      phone: `010-7788-${tail}`,
      phoneNormalized: `0107788${tail}`,
      customerStatus: 'PROSPECT',
      registeredAt: at(-60, 10),
      firstReservedAt: at(-62, 14),
      heightCm: 175 + (args.seq % 7),
      weightKg: 70 + (args.seq % 9),
      age: 30 + (args.seq % 12),
    },
  });
  const count = await createRecords(tx, { customerId, adminId: args.adminId, specs: args.specs });
  return { name: args.name, count };
}

// -----------------------------------------------------------------------------
// 재실행 정리 — 이 시드가 만든 010-7788 대역만 지운다
// -----------------------------------------------------------------------------

async function resetMeasurementDemo(): Promise<number> {
  const customerIds = (
    await prisma.customer.findMany({
      where: { phoneNormalized: { startsWith: '0107788' } },
      select: { id: true },
    })
  ).map((c) => c.id);
  if (customerIds.length === 0) return 0;

  const measurementIds = (
    await prisma.measurementSession.findMany({
      where: { customerId: { in: customerIds } },
      select: { id: true },
    })
  ).map((m) => m.id);

  await prisma.$transaction(async (tx) => {
    await tx.measurementValue.deleteMany({ where: { measurementSessionId: { in: measurementIds } } });
    // 사슬(previous_session_id)이 서로를 참조하므로 먼저 끊고 지운다.
    await tx.measurementSession.updateMany({
      where: { id: { in: measurementIds } },
      data: { previousSessionId: null },
    });
    await tx.measurementSession.deleteMany({ where: { id: { in: measurementIds } } });
    await tx.customer.deleteMany({ where: { id: { in: customerIds } } });
  });
  return customerIds.length;
}

// -----------------------------------------------------------------------------
// 본체
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const removed = await resetMeasurementDemo();
  if (removed > 0) console.log(`이전 채촌 데모 고객 ${removed}명을 지우고 다시 만듭니다.`);

  const admin = await prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });

  const made = await prisma.$transaction(
    async (tx) => {
      const adminId = admin.id;
      return [
        await createCustomer(tx, {
          seq: 1,
          name: '채촌01 여러회차',
          adminId,
          specs: [
            {
              measurementType: 'INITIAL',
              daysAgo: 40,
              completed: true,
              drift: 0,
              fitPreference: '슬림',
              notes: '첫 채촌 — 스타일 컨설팅에서 잰 값.',
            },
            {
              measurementType: 'FITTING',
              daysAgo: 20,
              completed: true,
              drift: -1,
              fitPreference: '슬림',
              notes: '1차 가봉 — 허리 1cm 줄임.',
            },
            {
              measurementType: 'FITTING',
              daysAgo: 7,
              completed: true,
              drift: -2,
              fitPreference: '슬림',
              notes: '2차 가봉 — 소매 길이 보정.',
            },
            {
              measurementType: 'REMEASURE',
              daysAgo: 1,
              completed: false,
              drift: -2,
              notes: '수선 접수 — 바지기장만 다시 재는 중.',
            },
          ],
        }),
        await createCustomer(tx, {
          seq: 2,
          name: '채촌02 한건',
          adminId,
          specs: [
            {
              measurementType: 'INITIAL',
              daysAgo: 10,
              completed: true,
              drift: 1,
              fitPreference: '레귤러',
              notes: '한 건뿐이라 회차 표기가 붙지 않는다.',
            },
          ],
        }),
        await createCustomer(tx, { seq: 3, name: '채촌03 기록없음', adminId, specs: [] }),
      ];
    },
    { timeout: 120_000 },
  );

  console.log('채촌 데모 데이터 생성 완료');
  for (const c of made) console.log(`  - ${c.name}: ${c.count}건`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
