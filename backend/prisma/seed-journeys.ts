/**
 * AICRM 진행 단계(customer_journeys) 시드 — 멱등.
 *
 * 기본/데모 시드가 만든 주문마다 "진행 1건"을 만들어 고객 상세의 진행 단계 카드를
 * 비어 보이지 않게 채운다. 이미 진행이 있는 주문은 건너뛴다(재실행 안전).
 *
 * - RENTAL 주문(IN_PROGRESS): 렌탈 출고 단계까지 진행(연락 대기 → [고객 연락] 노출)
 * - CUSTOM 주문(IN_PROGRESS): 완성복 입고 단계까지 진행
 * - COMPLETED 주문: 마지막 단계까지 완료 처리
 * - CANCELLED 주문: 제외
 *
 * 실행: npm run seed:journeys  (또는 ts-node prisma/seed-journeys.ts)
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID as uuid } from 'crypto';

const prisma = new PrismaClient();

/** IN_PROGRESS일 때 멈출 단계 순번 (트랙별) */
const ACTIVE_TARGET_SEQ: Record<string, number> = {
  RENTAL: 6, // 렌탈 출고
  CUSTOM: 8, // 완성복 입고
};

async function main(): Promise<void> {
  const admin = await prisma.user.findUnique({ where: { loginId: 'admin' } });
  if (!admin) throw new Error('admin 사용자가 없습니다. 기본 시드를 먼저 실행하세요.');

  const allStages = await prisma.journeyStage.findMany({
    orderBy: [{ trackType: 'asc' }, { sequenceNo: 'asc' }],
    select: { id: true, trackType: true, code: true, sequenceNo: true },
  });
  const stagesByTrack = new Map<string, typeof allStages>();
  for (const s of allStages) {
    const list = stagesByTrack.get(s.trackType) ?? [];
    list.push(s);
    stagesByTrack.set(s.trackType, list);
  }

  const orders = await prisma.order.findMany({
    where: { status: { not: 'CANCELLED' } },
    select: {
      id: true,
      transactionType: true,
      status: true,
      createdAt: true,
      contract: { select: { customerId: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  let created = 0;
  let skipped = 0;

  for (const order of orders) {
    const track = order.transactionType;
    const stages = stagesByTrack.get(track);
    if (!stages || stages.length === 0) continue;

    // 이미 이 주문에 진행이 있으면 건너뛴다.
    const existing = await prisma.customerJourney.findFirst({
      where: { orderId: order.id, status: { not: 'CANCELLED' } },
      select: { id: true },
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    const isCompleted = order.status === 'COMPLETED';
    const targetSeq = isCompleted
      ? stages.length
      : Math.min(ACTIVE_TARGET_SEQ[track] ?? Math.ceil(stages.length / 2), stages.length);

    const currentStage = stages.find((s) => s.sequenceNo === targetSeq)!;
    const base = new Date(order.createdAt);
    const at = (dayOffset: number) => new Date(base.getTime() + dayOffset * 24 * 3600 * 1000);

    const journeyId = uuid();
    await prisma.customerJourney.create({
      data: {
        id: journeyId,
        customerId: order.contract.customerId,
        orderId: order.id,
        trackType: track,
        currentStageCode: currentStage.code,
        status: isCompleted ? 'COMPLETED' : 'ACTIVE',
        startedAt: at(0),
        completedAt: isCompleted ? at(targetSeq) : null,
        rowVersion: isCompleted ? targetSeq : targetSeq - 1,
      },
    });

    // 단계 1 → targetSeq 까지 전진 이벤트(각 단계의 완료 기록)를 남긴다.
    for (let seq = 2; seq <= targetSeq; seq += 1) {
      const from = stages.find((s) => s.sequenceNo === seq - 1)!;
      const to = stages.find((s) => s.sequenceNo === seq)!;
      await prisma.journeyEvent.create({
        data: {
          id: uuid(),
          journeyId,
          stageId: to.id,
          fromStageCode: from.code,
          toStageCode: to.code,
          notificationOutcome: 'NONE',
          actorId: admin.id,
          changedAt: at(seq - 1),
        },
      });
    }

    created += 1;
  }

  console.log(`진행 시드 완료 — 생성 ${created}건 / 기존 유지 ${skipped}건`);
}

main()
  .catch((error) => {
    console.error('진행 시드 실패:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
