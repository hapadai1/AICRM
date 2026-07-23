/**
 * AICRM 진행 현황 보드 채우기 시드 — 멱등.
 *
 * 기본 진행 시드(seed-journeys.ts)는 "주문 있는 건"만 진행으로 만들기 때문에
 * 대부분의 단계 칸이 비어 보인다(진행이 한 단계에 몰림). 이 시드는 트랙별 각 단계마다
 * ACTIVE 진행이 최소 1건 놓이도록 빈 단계를 채워, 진행 현황 보드가 단계별로 고르게 보이게 한다.
 *
 * - 주문과 무관한 진행(orderId=null)을 만든다 — 주문 1:1 제약(seed-journeys)과 충돌하지 않는다.
 * - 이미 ACTIVE 진행이 있는 단계는 건너뛴다(재실행 안전).
 * - 각 단계까지의 전진 이벤트(완료 기록)를 남기고, updatedAt을 단계마다 다르게 과거로 돌려
 *   "머문 일수"가 다양하게(일부는 정체 강조 임계 이상) 보이도록 한다.
 *
 * 실행: npm run seed:journey-spread
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID as uuid } from 'crypto';

const prisma = new PrismaClient();

const DAY = 24 * 3600 * 1000;

async function main(): Promise<void> {
  const admin = await prisma.user.findUnique({ where: { loginId: 'admin' } });
  if (!admin) throw new Error('admin 사용자가 없습니다. 기본 시드를 먼저 실행하세요.');

  const customers = await prisma.customer.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (customers.length === 0) throw new Error('고객이 없습니다. 기본 시드를 먼저 실행하세요.');

  const stages = await prisma.journeyStage.findMany({
    where: { active: true },
    orderBy: [{ trackType: 'asc' }, { sequenceNo: 'asc' }],
    select: { id: true, trackType: true, code: true, sequenceNo: true },
  });
  const stagesByTrack = new Map<string, typeof stages>();
  for (const s of stages) {
    const list = stagesByTrack.get(s.trackType) ?? [];
    list.push(s);
    stagesByTrack.set(s.trackType, list);
  }

  const now = Date.now();
  let created = 0;
  let skipped = 0;
  let pick = 0;

  for (const [track, trackStages] of stagesByTrack) {
    for (const target of trackStages) {
      // 이 단계에 이미 진행 중인 건이 있으면 채우지 않는다.
      const existing = await prisma.customerJourney.findFirst({
        where: { trackType: track, currentStageCode: target.code, status: 'ACTIVE' },
        select: { id: true },
      });
      if (existing) {
        skipped += 1;
        continue;
      }

      const customer = customers[pick % customers.length];
      pick += 1;

      // 머문 일수를 단계마다 다르게 — 일부는 정체 임계(7일) 이상으로.
      const daysInStage = (target.sequenceNo * 3) % 11; // 0,3,6,9,1,4,7,10,2 ...
      const startedAt = new Date(now - (target.sequenceNo + 3) * DAY);

      const journeyId = uuid();
      await prisma.customerJourney.create({
        data: {
          id: journeyId,
          customerId: customer.id,
          orderId: null,
          trackType: track,
          currentStageCode: target.code,
          status: 'ACTIVE',
          startedAt,
          rowVersion: target.sequenceNo - 1,
        },
      });

      // 1 → target 까지 전진 이벤트(각 단계 완료 기록)를 남긴다.
      for (let seq = 2; seq <= target.sequenceNo; seq += 1) {
        const from = trackStages.find((s) => s.sequenceNo === seq - 1)!;
        const to = trackStages.find((s) => s.sequenceNo === seq)!;
        await prisma.journeyEvent.create({
          data: {
            id: uuid(),
            journeyId,
            stageId: to.id,
            fromStageCode: from.code,
            toStageCode: to.code,
            notificationOutcome: 'NONE',
            actorId: admin.id,
            changedAt: new Date(startedAt.getTime() + (seq - 1) * DAY),
          },
        });
      }

      // @updatedAt은 생성 시 now로 박히므로, 머문 일수를 위해 과거로 되돌린다.
      await prisma.$executeRaw`UPDATE customer_journeys SET updated_at = ${new Date(
        now - daysInStage * DAY,
      )} WHERE id = ${journeyId}::uuid`;

      created += 1;
    }
  }

  console.log(`진행 현황 채우기 완료 — 생성 ${created}건 / 기존 단계 유지 ${skipped}건`);
}

main()
  .catch((error) => {
    console.error('진행 현황 채우기 실패:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
