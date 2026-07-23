/**
 * 변경된 옵션 기능(3지선다 · 선택지 이미지 · 선택지별 추가금액 · 계약서 반영) 데모 데이터.
 *
 * 기존 seed-demo.ts 는 자체 2지선다 옵션 버전을 새로 만들어 활성화하므로,
 * 실제 이미지·추가금액이 담긴 suit-design 세트를 덮어쓴다. 그래서 이 스크립트는
 * **현재 활성 SUIT 옵션 세트(= seed:suit-design 결과)를 그대로 사용**해, 옵션 선택으로
 * 발생한 추가금액이 계약 현재 버전 금액에 반영되는 흐름을 데모로 남긴다.
 *
 * 만드는 것:
 *  - 고객 1명(옵션데모 고객)
 *  - 확정 계약 1건(맞춤 정장 2벌) + 확정 버전 + 주문 + 주문품목 2개
 *  - 주문품목별 확정 옵션 세션
 *      · 정장 #1(프리미엄): 단계마다 추가금액 있는 선택지를 고른다 → 추가금액 합계 176,000
 *      · 정장 #2(베이직):   단계마다 기본(첫) 선택지를 고른다   → 추가금액 0
 *  - 옵션 추가금액을 계약 현재 버전 total/balance 에 반영(surchargeApplied 기록)
 *
 * 재실행해도 안전하도록(idempotent) 시작 시 이 데모가 만든 데이터를 지우고 다시 만든다.
 * 실행: npm run seed:option-demo   (사전: npm run seed:suit-design 로 SUIT 옵션 세트가 있어야 함)
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { randomUUID as uuid } from 'crypto';

const prisma = new PrismaClient();

// 이 데모를 알아보는 표식(재실행 시 이 값들로 기존 데이터를 찾아 지운다)
const CUSTOMER_PHONE_NORM = '01099990001';
const CONTRACT_NO = 'CTR-OPTDEMO-001';
const ORDER_NO = 'ORD-OPTDEMO-001';

const UNIT_PRICE = 1_500_000; // 맞춤 정장 1벌 기본가
const DEPOSIT = 1_000_000;

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

/** 기존 데모 데이터 제거 (FK 의존 역순) */
async function wipePrevious() {
  const customer = await prisma.customer.findUnique({
    where: { phoneNormalized: CUSTOMER_PHONE_NORM },
    include: { contracts: { include: { orders: { include: { items: true } }, versions: true } } },
  });
  if (!customer) return;

  const orderItemIds = customer.contracts.flatMap((c) => c.orders.flatMap((o) => o.items.map((i) => i.id)));
  const orderIds = customer.contracts.flatMap((c) => c.orders.map((o) => o.id));
  const contractIds = customer.contracts.map((c) => c.id);
  const versionIds = customer.contracts.flatMap((c) => c.versions.map((v) => v.id));

  await prisma.$transaction(async (tx) => {
    await tx.optionSelectionValue.deleteMany({ where: { selectionSession: { orderItemId: { in: orderItemIds } } } });
    await tx.optionSelectionSession.deleteMany({ where: { orderItemId: { in: orderItemIds } } });
    // 다른 시드(seed:journeys 등)가 이 고객·주문에 붙였을 수 있는 여정(+이벤트)을 먼저 지운다
    await tx.journeyEvent.deleteMany({ where: { journey: { customerId: customer.id } } });
    await tx.customerJourney.deleteMany({ where: { customerId: customer.id } });
    await tx.orderItem.deleteMany({ where: { id: { in: orderItemIds } } });
    await tx.order.deleteMany({ where: { id: { in: orderIds } } });
    // 계약의 현재 버전 FK를 먼저 끊어야 버전을 지울 수 있다
    await tx.contract.updateMany({ where: { id: { in: contractIds } }, data: { currentVersionId: null } });
    await tx.contractLine.deleteMany({ where: { contractVersionId: { in: versionIds } } });
    await tx.contractVersion.deleteMany({ where: { id: { in: versionIds } } });
    await tx.contract.deleteMany({ where: { id: { in: contractIds } } });
    await tx.customer.delete({ where: { id: customer.id } });
  });
}

async function main() {
  const admin = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!admin) throw new Error('관리자 계정이 없습니다. 먼저 npm run prisma:seed 를 실행하세요.');

  const optionSet = await prisma.optionSet.findUnique({ where: { productCategory: 'SUIT' } });
  if (!optionSet?.activeVersionId) {
    throw new Error('활성 SUIT 옵션 세트가 없습니다. 먼저 npm run seed:suit-design 를 실행하세요.');
  }
  const stages = await prisma.optionStage.findMany({
    where: { optionSetVersionId: optionSet.activeVersionId, active: true },
    orderBy: { sequenceNo: 'asc' },
    include: { choices: { orderBy: { choiceCode: 'asc' } } },
  });
  if (stages.length === 0) throw new Error('활성 옵션 단계가 없습니다.');

  await wipePrevious();

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    // 1) 고객
    const customerId = uuid();
    await tx.customer.create({
      data: {
        id: customerId,
        name: '옵션데모 고객',
        phone: '010-9999-0001',
        phoneNormalized: CUSTOMER_PHONE_NORM,
        email: 'optdemo@example.com',
        customerStatus: 'CONTRACTED',
        firstReservedAt: daysAgo(20),
        contractedAt: daysAgo(10),
        notes: '옵션 추가금액→계약 반영 데모용 고객',
      },
    });

    // 2) 계약 + 확정 버전(v1) + 라인 2개(맞춤 정장 2벌)
    const contractId = uuid();
    await tx.contract.create({
      data: {
        id: contractId,
        contractNo: CONTRACT_NO,
        customerId,
        status: 'CONFIRMED',
        contractedAt: daysAgo(10),
      },
    });

    const versionId = uuid();
    const baseTotal = UNIT_PRICE * 2;
    await tx.contractVersion.create({
      data: {
        id: versionId,
        contractId,
        versionNo: 1,
        versionStatus: 'CONFIRMED',
        totalAmount: baseTotal,
        depositAmount: DEPOSIT,
        balanceAmount: baseTotal - DEPOSIT,
        completionDueDate: daysAgo(-14),
        confirmedBy: admin.id,
        confirmedAt: daysAgo(10),
        createdBy: admin.id,
      },
    });
    const lineIds: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const lineId = uuid();
      await tx.contractLine.create({
        data: {
          id: lineId,
          contractVersionId: versionId,
          transactionType: 'CUSTOM',
          productCategory: 'SUIT',
          itemDescription: `맞춤 정장 #${i + 1}`,
          quantity: 1,
          unitPrice: UNIT_PRICE,
          lineAmount: UNIT_PRICE,
          sortOrder: i + 1,
        },
      });
      lineIds.push(lineId);
    }
    await tx.contract.update({ where: { id: contractId }, data: { currentVersionId: versionId } });

    // 3) 주문 + 주문품목 2개
    const orderId = uuid();
    await tx.order.create({
      data: {
        id: orderId,
        orderNo: ORDER_NO,
        contractId,
        transactionType: 'CUSTOM',
        status: 'IN_PROGRESS',
        completionDueDate: daysAgo(-14),
      },
    });

    // 프리미엄: 단계별 추가금액 최댓값 선택지 / 베이직: 첫 선택지
    const premiumPick = (choices: typeof stages[number]['choices']) =>
      choices.reduce((best, c) => (Number(c.extraPrice) > Number(best.extraPrice) ? c : best), choices[0]);
    // 베이직: 추가금액이 가장 낮은(대개 0원) 선택지 — 첫 선택지가 유료일 수 있어 최솟값으로 고른다
    const basicPick = (choices: typeof stages[number]['choices']) =>
      choices.reduce((best, c) => (Number(c.extraPrice) < Number(best.extraPrice) ? c : best), choices[0]);

    const items: Array<{ name: string; lineId: string; pick: (c: typeof stages[number]['choices']) => typeof stages[number]['choices'][number] }> = [
      { name: '정장 #1 (프리미엄)', lineId: lineIds[0], pick: premiumPick },
      { name: '정장 #2 (베이직)', lineId: lineIds[1], pick: basicPick },
    ];

    let contractSurcharge = 0;

    for (let idx = 0; idx < items.length; idx += 1) {
      const item = items[idx];
      const orderItemId = uuid();
      await tx.orderItem.create({
        data: {
          id: orderItemId,
          orderId,
          sourceContractLineId: item.lineId,
          productCategory: 'SUIT',
          sequenceNo: idx + 1,
          displayName: item.name,
          status: 'READY_TO_ORDER',
        },
      });

      // 확정 옵션 세션 + 선택값(단계마다 하나씩)
      const sessionId = uuid();
      let surcharge = 0;
      const values: Prisma.OptionSelectionValueCreateManyInput[] = [];
      for (const stage of stages) {
        const choice = item.pick(stage.choices);
        const extra = Number(choice.extraPrice);
        surcharge += extra;
        values.push({
          id: uuid(),
          selectionSessionId: sessionId,
          optionStageId: stage.id,
          optionChoiceId: choice.id,
          extraPriceSnapshot: choice.extraPrice, // 선택 시점 추가금액 스냅샷
          selectedBy: admin.id,
          selectedAt: daysAgo(8),
        });
      }

      await tx.optionSelectionSession.create({
        data: {
          id: sessionId,
          orderItemId,
          optionSetVersionId: optionSet.activeVersionId!,
          selectionVersionNo: 1,
          status: 'CONFIRMED',
          currentStageId: null,
          fabricName: idx === 0 ? 'VBC 110수 네이비 솔리드' : 'CANONICO 130수 차콜 솔리드',
          startedAt: daysAgo(9),
          lastSavedAt: daysAgo(8),
          reviewedAt: daysAgo(8),
          confirmedAt: daysAgo(8),
          isCurrent: true,
          // 추가금액을 계약에 반영했음을 기록
          surchargeApplied: surcharge,
          surchargeAppliedAt: surcharge > 0 ? now : null,
        },
      });
      await tx.optionSelectionValue.createMany({ data: values });

      contractSurcharge += surcharge;
    }

    // 4) 옵션 추가금액을 계약 현재 버전 금액에 반영(total/balance 증가)
    if (contractSurcharge > 0) {
      await tx.contractVersion.update({
        where: { id: versionId },
        data: {
          totalAmount: { increment: contractSurcharge },
          balanceAmount: { increment: contractSurcharge },
        },
      });
    }

    // 로그용 요약을 트랜잭션 밖으로 넘기기 위해 반환값 사용
    return { contractSurcharge, baseTotal };
  });

  // 요약 출력
  const priced = stages
    .flatMap((s) => s.choices)
    .filter((c) => Number(c.extraPrice) > 0)
    .map((c) => `${c.choiceName} +${Number(c.extraPrice).toLocaleString()}원`);
  const premiumTotal = stages.reduce((sum, s) => {
    const max = s.choices.reduce((m, c) => Math.max(m, Number(c.extraPrice)), 0);
    return sum + max;
  }, 0);

  console.log(`옵션 세트: SUIT 활성 버전, ${stages.length}단계`);
  console.log(`추가금액 선택지: ${priced.join(', ')}`);
  console.log(`계약: ${CONTRACT_NO} 기본 ${(UNIT_PRICE * 2).toLocaleString()}원 → 옵션 추가 ${premiumTotal.toLocaleString()}원 반영`);
  console.log(`  · 정장 #1(프리미엄) 추가금액 ${premiumTotal.toLocaleString()}원 / 정장 #2(베이직) 0원`);
  console.log('옵션 추가금액→계약 반영 데모 생성 완료');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
