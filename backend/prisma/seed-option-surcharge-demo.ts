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
    // 옵션 세션은 ContractItem(계약 소유)에 붙는다 → 계약 기준으로 지운다.
    const contractItemIds = (
      await tx.contractItem.findMany({
        where: { contractId: { in: contractIds } },
        select: { id: true },
      })
    ).map((ci) => ci.id);
    await tx.optionSelectionValue.deleteMany({
      where: { selectionSession: { contractItemId: { in: contractItemIds } } },
    });
    // 세션에 매달린 부위 속성(component attrs)을 먼저 지워야 세션을 지울 수 있다 (FK).
    await tx.optionSelectionComponentAttr.deleteMany({
      where: { selectionSession: { contractItemId: { in: contractItemIds } } },
    });
    await tx.optionSelectionSession.deleteMany({ where: { contractItemId: { in: contractItemIds } } });
    // 다른 시드(seed:journeys 등)가 이 고객·주문에 붙였을 수 있는 여정(+이벤트)을 먼저 지운다
    await tx.journeyEvent.deleteMany({ where: { journey: { customerId: customer.id } } });
    await tx.customerJourney.deleteMany({ where: { customerId: customer.id } });
    // 채촌(품목 연결 → 값 → 세션)도 이 고객 것이므로 품목보다 먼저 지운다.
    await tx.orderItemMeasurement.deleteMany({ where: { orderItemId: { in: orderItemIds } } });
    await tx.measurementValue.deleteMany({
      where: { measurementSession: { customerId: customer.id } },
    });
    await tx.measurementSession.deleteMany({ where: { customerId: customer.id } });
    // 품목에 달린 것(구성품·제작 이벤트)을 먼저 지워야 품목을 지울 수 있다.
    await tx.productionEvent.deleteMany({ where: { orderItemId: { in: orderItemIds } } });
    await tx.orderItemComponent.deleteMany({ where: { orderItemId: { in: orderItemIds } } });
    await tx.orderItem.deleteMany({ where: { id: { in: orderItemIds } } });
    await tx.order.deleteMany({ where: { id: { in: orderIds } } });
    // 계약의 현재 버전 FK를 먼저 끊어야 버전을 지울 수 있다
    await tx.contract.updateMany({ where: { id: { in: contractIds } }, data: { currentVersionId: null } });
    await tx.contractItemComponent.deleteMany({ where: { contractItemId: { in: contractItemIds } } });
    await tx.contractItem.deleteMany({ where: { id: { in: contractItemIds } } });
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

  /*
    제작 관리는 계약완료 + 진행(journey)이 선 주문만 다룬다. 이 시드가 진행을 안 만들던 때는
    제작 화면에 빈 흐름 카드만 떴다 — 계약·주문과 함께 진행도 여기서 심는다.
  */
  const journeyStages = await prisma.journeyStage.findMany({
    where: { trackType: 'CUSTOM', active: true },
    orderBy: { sequenceNo: 'asc' },
    select: { id: true, code: true },
  });
  const stageIdOf = (code: string) => {
    const found = journeyStages.find((s) => s.code === code);
    if (!found) throw new Error(`CUSTOM 진행 단계 ${code} 가 없습니다. 먼저 npm run prisma:seed 를 실행하세요.`);
    return found.id;
  };
  // 밟아 온 순서: 계약 확정 → 스타일 컨설팅(옵션 확정) → 발주 요청(현재, 품목 READY_TO_ORDER)
  const JOURNEY_PATH = ['CONTRACT_CONFIRMED', 'STYLE_CONSULTING', 'ORDER_REQUESTED'] as const;
  JOURNEY_PATH.forEach(stageIdOf);

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
    // 계약 구분은 계약서 필수값(신규 작성 폼 required) — 맞춤 정장 기본 구분을 붙인다.
    const contractType = await tx.contractType.findUniqueOrThrow({
      where: { code: 'BUSINESS_SUIT_CUSTOM' },
    });
    const contractId = uuid();
    await tx.contract.create({
      data: {
        id: contractId,
        contractNo: CONTRACT_NO,
        customerId,
        contractTypeId: contractType.id,
        status: 'COMPLETED',
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
    const orderItemIds: string[] = [];

    for (let idx = 0; idx < items.length; idx += 1) {
      const item = items[idx];
      // 컨설팅(옵션 세션)이 이제 ContractItem에 붙는다 → 라인마다 앵커 품목을 물리화한다.
      const contractItemId = uuid();
      await tx.contractItem.create({
        data: {
          id: contractItemId,
          contractId,
          sourceContractLineId: item.lineId,
          transactionType: 'CUSTOM',
          productCategory: 'SUIT',
          sequenceNo: idx + 1,
          displayName: item.name,
        },
      });
      const orderItemId = uuid();
      await tx.orderItem.create({
        data: {
          id: orderItemId,
          orderId,
          sourceContractItemId: contractItemId,
          productCategory: 'SUIT',
          sequenceNo: idx + 1,
          displayName: item.name,
          // 옵션 확정 + 채촌 연결이 끝난 품목이라 발주 가능이다(준비 판정과 같은 상태).
          status: 'READY_TO_ORDER',
        },
      });
      orderItemIds.push(orderItemId);

      // 정장은 상의·하의·베스트 세 부위로 만든다 (마이그레이션 20260801010000).
      // 계약 부위가 없으면 주문 구성품도 생기지 않아 제작 화면에서 벌 단위 처리를 할 수 없다.
      const componentTypes = ['JACKET', 'TROUSERS', 'VEST'];
      for (let c = 0; c < componentTypes.length; c += 1) {
        await tx.contractItemComponent.create({
          data: {
            id: uuid(),
            contractItemId,
            componentType: componentTypes[c],
            sequenceNo: c + 1,
            status: 'CREATED',
          },
        });
        await tx.orderItemComponent.create({
          data: {
            id: uuid(),
            orderItemId,
            componentType: componentTypes[c],
            sequenceNo: c + 1,
            status: 'CREATED',
          },
        });
      }

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
          contractItemId,
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

    /*
      3-1) 채촌 — 완료하면 그 계약의 맞춤 품목에 다 붙는다(2026-08-04 현업 확정).
      품목이 `발주 가능`인데 채촌이 없으면 화면에서는 준비 미완료로 잠긴다. 실제 흐름대로 심는다.
    */
    const measureId = uuid();
    await tx.measurementSession.create({
      data: {
        id: measureId,
        customerId,
        versionNo: 1,
        measurementDate: daysAgo(8),
        measurementType: 'INITIAL',
        fitPreference: 'STANDARD',
        completedAt: daysAgo(8),
        createdBy: admin.id,
      },
    });
    const measureRows: Array<[string, string, number, number]> = [
      ['JACKET_LENGTH', 'UPPER', 74, 10],
      ['SHOULDER', 'UPPER', 45.5, 20],
      ['CHEST_MID', 'UPPER', 97, 30],
      ['SLEEVE_LEFT', 'UPPER', 61.5, 40],
      ['WAIST', 'LOWER', 84, 50],
      ['HIP', 'LOWER', 98, 60],
      ['PANTS_LENGTH', 'LOWER', 101, 70],
    ];
    await tx.measurementValue.createMany({
      data: measureRows.map(([code, bodySection, numericValue, sortOrder]) => ({
        id: uuid(),
        measurementSessionId: measureId,
        bodySection,
        measurementCode: code,
        numericValue,
        unit: 'CM',
        sortOrder,
      })),
    });
    for (const orderItemId of orderItemIds) {
      await tx.orderItemMeasurement.create({
        data: {
          id: uuid(),
          orderItemId,
          measurementSessionId: measureId,
          isCurrent: true,
          linkedBy: admin.id,
          linkedAt: daysAgo(8),
        },
      });
    }

    // 3-2) 진행(journey) — 주문 1건당 1건. 계약완료 경로(ensureJourneysForOrders)와 같은 모양이다.
    const journeyId = uuid();
    await tx.customerJourney.create({
      data: {
        id: journeyId,
        customerId,
        orderId,
        trackType: 'CUSTOM',
        currentStageCode: JOURNEY_PATH[JOURNEY_PATH.length - 1],
        status: 'ACTIVE',
        startedAt: daysAgo(10),
      },
    });
    for (let i = 0; i < JOURNEY_PATH.length; i += 1) {
      await tx.journeyEvent.create({
        data: {
          id: uuid(),
          journeyId,
          stageId: stageIdOf(JOURNEY_PATH[i]),
          fromStageCode: i === 0 ? null : JOURNEY_PATH[i - 1],
          toStageCode: JOURNEY_PATH[i],
          notificationOutcome: 'NONE',
          actorId: admin.id,
          changedAt: daysAgo(10 - i),
        },
      });
    }

    // 4) 옵션 추가금액을 계약 현재 버전 총액에 반영 + 품목 맨 아래 '옵션(추가금액)' 롤업 라인 (2026-08-04)
    if (contractSurcharge > 0) {
      await tx.contractVersion.update({
        where: { id: versionId },
        data: { totalAmount: { increment: contractSurcharge } },
      });
      await tx.contractLine.create({
        data: {
          id: uuid(),
          contractVersionId: versionId,
          transactionType: 'OPTION',
          productCategory: 'OPTION',
          itemDescription: '옵션(추가금액)',
          quantity: 1,
          unitPrice: contractSurcharge,
          lineAmount: contractSurcharge,
          sortOrder: 100,
          isOptionRollup: true,
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
