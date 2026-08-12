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
import { ITEM_STATUS_FLOW } from '../src/modules/production/production-status';

const prisma = new PrismaClient();

/** 품목 제작 상태의 흐름 순위. COMPLETED는 종단(모든 단계 통과), 흐름 밖(CANCELLED 등)은 -1. */
const rankOf = (s: string): number =>
  s === 'COMPLETED' ? ITEM_STATUS_FLOW.length : (ITEM_STATUS_FLOW as readonly string[]).indexOf(s);

/**
 * 진행 단계 → 그 단계를 지난 것으로 보는 품목 상태(reachedAt). 프론트 production-stages.ts와 같은 표다.
 * 여기 없는 단계(상담예약·계약확정·렌탈반납)는 품목 상태와 무관해 진행 위치 게이트로 쓰지 않는다.
 */
const REACHED_AT: Record<string, string> = {
  ORDER_REQUESTED: 'PRODUCTION_REQUESTED',
  BASTING_RECEIVED: 'BASTING_RECEIVED',
  FITTING_DONE: 'FITTING_COMPLETED',
  PRODUCT_RECEIVED: 'RECEIVED',
  RELEASED: 'RELEASED',
  RENTAL_REPAIR_REQUESTED: 'PRODUCTION_REQUESTED',
  RENTAL_REPAIR_RECEIVED: 'RECEIVED',
  RENTAL_REPAIR_CHECKED_OUT: 'RELEASED',
};
/**
 * 완료 기록을 남기는 단계 = 위 제작 단계 + 준비(스타일 컨설팅).
 * 준비는 첫 발주 때 함께 완료로 찍히므로(발주 임계) 완료 기록에만 넣고 진행 위치 계산에선 뺀다.
 */
const COMPLETION_REACHED_AT: Record<string, string> = {
  STYLE_CONSULTING: 'PRODUCTION_REQUESTED',
  ...REACHED_AT,
};

/**
 * 렌탈 반납(진행 RENTAL_RETURNED 기록) ↔ 품목 상태(COMPLETED)를 일치시킨다 (방안 A 정합화, 2026-08-12).
 *
 * 반납은 진행 단계 기록에만 남고 품목 상태를 바꾸지 않던 모델이라, 시드/구데이터에서 두 계층이 어긋났다:
 *  - 품목은 COMPLETED인데 반납 기록이 없음(데모가 완료 렌탈을 품목 상태로만 세팅 — 예: 서지우)
 *  - 반납 기록은 있는데 품목이 RELEASED에 머묾(방안 A 이전 코드로 반납을 눌러 승격 안 됨 — 예: 윤도현)
 * 반납 기록을 사실의 기준으로 삼아 양방향으로 맞춘다(멱등).
 */
async function reconcileRentalReturns(adminId: string): Promise<void> {
  const items = await prisma.orderItem.findMany({
    where: {
      status: { in: ['RELEASED', 'COMPLETED'] },
      order: { transactionType: 'RENTAL', status: { not: 'CANCELLED' } },
    },
    select: {
      id: true,
      status: true,
      order: {
        select: {
          journeys: { where: { status: { not: 'CANCELLED' } }, select: { id: true }, take: 1 },
        },
      },
    },
  });

  let promoted = 0;
  let recorded = 0;
  for (const it of items) {
    const journeyId = it.order.journeys[0]?.id;
    if (!journeyId) continue;
    const existing = await prisma.journeyStageItemCompletion.findUnique({
      where: {
        journeyId_stageCode_targetType_targetId: {
          journeyId,
          stageCode: 'RENTAL_RETURNED',
          targetType: 'ORDER_ITEM',
          targetId: it.id,
        },
      },
      select: { id: true, revokedAt: true },
    });
    const returned = existing != null && existing.revokedAt === null;

    if (returned && it.status === 'RELEASED') {
      // 반납은 됐는데 품목이 출고에 머묾 → 완료로 승격(제작 이력 남김).
      await prisma.orderItem.update({ where: { id: it.id }, data: { status: 'COMPLETED' } });
      await prisma.productionEvent.create({
        data: {
          id: uuid(),
          orderItemId: it.id,
          componentId: null,
          eventType: 'COMPLETED',
          previousStatus: 'RELEASED',
          newStatus: 'COMPLETED',
          eventDate: new Date(),
          actorId: adminId,
          notes: '렌탈 반납 완료 — 진행 기록과 정합화',
        },
      });
      promoted += 1;
    } else if (!returned && it.status === 'COMPLETED') {
      // 품목은 완료인데 반납 기록이 없음 → 반납 완료 기록을 보정(취소된 기록이 있으면 되살린다).
      if (existing) {
        await prisma.journeyStageItemCompletion.update({
          where: { id: existing.id },
          data: { revokedAt: null, completedAt: new Date(), completedBy: adminId },
        });
      } else {
        await prisma.journeyStageItemCompletion.create({
          data: {
            id: uuid(),
            journeyId,
            stageCode: 'RENTAL_RETURNED',
            targetType: 'ORDER_ITEM',
            targetId: it.id,
            completedAt: new Date(),
            completedBy: adminId,
          },
        });
      }
      recorded += 1;
    }
  }
  console.log(`렌탈 반납 정합화 — 품목 승격 ${promoted}건 / 반납 기록 보정 ${recorded}건`);
}

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

    // 진행 위치·완료 기록은 주문 상태가 아니라 **품목 제작 상태**에서 정한다 —
    // 그래야 상단 진행률(itemStatus)과 제작 카드(단계 완료 기록)가 같은 사실을 가리킨다.
    // (예전엔 주문이 COMPLETED면 무조건 마지막 단계로 밀어, 품목은 제작 중인데 진행은
    //  출고완료로 서고 완료 기록은 0건인 데이터가 만들어졌다.)
    const items = await prisma.orderItem.findMany({
      where: { orderId: order.id, status: { not: 'CANCELLED' } },
      select: { id: true, status: true },
    });
    const ranks = items.map((i) => rankOf(i.status)).filter((r) => r >= 0);

    // 계약 확정된 주문이면 준비(스타일 컨설팅)를 바닥으로 두고,
    // 제작 단계부터는 "전 품목이 지난 마지막 단계 다음"에 진행을 세운다.
    const styleIdx = stages.findIndex((s) => s.code === 'STYLE_CONSULTING');
    let curIdx = styleIdx >= 0 ? styleIdx : 0;
    for (let i = 0; i < stages.length; i += 1) {
      const rq = REACHED_AT[stages[i].code];
      if (!rq) continue;
      const need = rankOf(rq);
      if (ranks.some((r) => r >= need)) curIdx = i;
      if (!ranks.every((r) => r >= need)) break;
    }
    // 전 품목이 출고(또는 완료)까지 갔으면 진행을 마지막 단계(출고/반납 완료)로 닫는다.
    const allDone = ranks.length > 0 && ranks.every((r) => r >= rankOf('RELEASED'));
    if (allDone) curIdx = stages.length - 1;

    const currentStage = stages[curIdx];
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
        status: allDone ? 'COMPLETED' : 'ACTIVE',
        startedAt: at(0),
        completedAt: allDone ? at(curIdx) : null,
        rowVersion: curIdx,
      },
    });

    // 1단계 시작 → 현재 단계까지 밟아 온 전진 이벤트.
    for (let i = 1; i <= curIdx; i += 1) {
      await prisma.journeyEvent.create({
        data: {
          id: uuid(),
          journeyId,
          stageId: stages[i].id,
          fromStageCode: stages[i - 1].code,
          toStageCode: stages[i].code,
          notificationOutcome: 'NONE',
          actorId: admin.id,
          changedAt: at(i),
        },
      });
    }

    // 단계별 품목 완료 기록 — 제작 카드가 "몇 개 끝났나"를 읽는 유일한 근거다.
    // 각 품목이 제작 상태로 지난 단계마다 완료를 찍는다(취소 품목은 대상이 아니다).
    for (const it of items) {
      const r = rankOf(it.status);
      if (r < 0) continue;
      for (const st of stages) {
        const rq = COMPLETION_REACHED_AT[st.code];
        if (!rq || r < rankOf(rq)) continue;
        await prisma.journeyStageItemCompletion.create({
          data: {
            id: uuid(),
            journeyId,
            stageCode: st.code,
            targetType: 'ORDER_ITEM',
            targetId: it.id,
            completedAt: at(curIdx),
            completedBy: admin.id,
          },
        });
      }
    }

    created += 1;
  }

  // 새로 만든 진행이든 기존 진행이든, 렌탈 반납 기록과 품목 상태를 마지막에 한 번 맞춘다.
  await reconcileRentalReturns(admin.id);

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
