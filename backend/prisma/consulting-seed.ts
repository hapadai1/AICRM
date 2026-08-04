/**
 * 계약완료 계약의 스타일 컨설팅을 전 품목 확정으로 맞춘다.
 *
 * 앱은 **전 품목 컨설팅 확정 → 서명 → 계약완료** 순서를 강제한다
 * (contracts.service.assertSignable → consultingReadiness, 어기면 CONSULTING_NOT_CONFIRMED).
 * 그런데 시드는 서비스를 거치지 않고 DB에 바로 심어서, 계약완료인데 컨설팅이 미확정인
 * 계약이 만들어져 있었다(2026-08-04 감사에서 계약완료 14건 중 9건). 그 데이터로는
 * 제작 화면의 준비가 영원히 `스타일 컨설팅 2/6`에서 멈춰 실제 업무와 다르게 보인다.
 *
 * 그래서 계약완료 계약을 만든 시드는 마지막에 이 함수를 부른다 — 맞춤은 옵션 세션을,
 * 렌탈은 렌탈 선택 세션을 확정으로 채운다. 이미 확정된 품목은 건드리지 않는다.
 */
import { Prisma } from '@prisma/client';
import { randomUUID as uuid } from 'crypto';

type Tx = Prisma.TransactionClient;

/** 렌탈 품목의 부위 — 정장류는 상·하의(쓰리피스는 베스트까지), 구두는 한 부위다. */
function rentalComponentTypes(productCategory: string, displayName: string): string[] {
  if (productCategory === 'SHOES') return ['SHOES'];
  return displayName.includes('쓰리피스')
    ? ['JACKET', 'TROUSERS', 'VEST']
    : ['JACKET', 'TROUSERS'];
}

export interface ConsultingSeedResult {
  customConfirmed: number;
  rentalConfirmed: number;
  skipped: string[];
}

/**
 * 주어진 계약들(계약완료 전제)의 컨설팅을 확정 상태로 만든다.
 * 옵션 추가금액이 새로 붙으면 계약 현재 버전 금액에도 그만큼 반영한다 — 확정 세션에
 * 미반영 차액이 남지 않는다는 앱 규칙(option-sessions.confirm)과 같게 둔다.
 */
export async function confirmConsultingForContracts(
  tx: Tx,
  args: { contractIds: string[]; adminId: string; confirmedAt: Date },
): Promise<ConsultingSeedResult> {
  const result: ConsultingSeedResult = { customConfirmed: 0, rentalConfirmed: 0, skipped: [] };
  if (args.contractIds.length === 0) return result;

  const items = await tx.contractItem.findMany({
    where: { contractId: { in: args.contractIds }, status: { not: 'CANCELLED' } },
    select: {
      id: true,
      contractId: true,
      displayName: true,
      productCategory: true,
      transactionType: true,
      components: { select: { id: true, componentType: true, status: true } },
      optionSelectionSessions: {
        where: { isCurrent: true },
        select: {
          id: true,
          status: true,
          optionSetVersionId: true,
          surchargeApplied: true,
          values: { select: { optionStageId: true, extraPriceSnapshot: true } },
        },
      },
      rentalSelectionSessions: { where: { isCurrent: true }, select: { id: true, status: true } },
    },
  });

  /** 카테고리별 활성 옵션 세트 (없으면 확정할 수 없다) */
  const optionSets = await tx.optionSet.findMany({
    where: { activeVersionId: { not: null } },
    select: {
      productCategory: true,
      activeVersionId: true,
      activeVersion: {
        select: {
          id: true,
          stages: {
            where: { active: true },
            orderBy: { sequenceNo: 'asc' },
            select: {
              id: true,
              choices: { where: { active: true }, orderBy: { choiceCode: 'asc' }, select: { id: true, extraPrice: true } },
            },
          },
        },
      },
    },
  });
  const setOf = (category: string) => optionSets.find((s) => s.productCategory === category);

  const [colors, sizes] = await Promise.all([
    tx.rentalColor.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } }),
    tx.rentalSize.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } }),
  ]);
  const colorFor = (componentType: string) =>
    colors.find((c) => c.componentTypes.includes(componentType))?.code ?? null;
  const sizeFor = (componentType: string) =>
    sizes.find((s) => s.componentTypes.includes(componentType))?.code ?? null;

  /** 계약별로 늘어난 추가금액 — 마지막에 현재 버전 금액에 더한다. */
  const addedSurcharge = new Map<string, number>();

  for (const item of items) {
    if (item.transactionType === 'RENTAL') {
      const session = item.rentalSelectionSessions[0];
      if (session?.status === 'CONFIRMED') continue;

      // 렌탈 부위가 없으면 선택할 대상이 없다 — 부위부터 만든다.
      let components = item.components.filter((c) => c.status !== 'CANCELLED');
      if (components.length === 0) {
        const types = rentalComponentTypes(item.productCategory, item.displayName);
        components = [];
        for (let i = 0; i < types.length; i += 1) {
          const created = await tx.contractItemComponent.create({
            data: {
              id: uuid(),
              contractItemId: item.id,
              componentType: types[i],
              sequenceNo: i + 1,
              status: 'CREATED',
            },
            select: { id: true, componentType: true, status: true },
          });
          components.push(created);
        }
      }

      const sessionId = session?.id ?? uuid();
      if (session) {
        await tx.rentalSelectionSession.update({
          where: { id: session.id },
          data: { status: 'CONFIRMED', confirmedAt: args.confirmedAt },
        });
      } else {
        await tx.rentalSelectionSession.create({
          data: {
            id: sessionId,
            contractItemId: item.id,
            selectionVersionNo: 1,
            status: 'CONFIRMED',
            confirmedAt: args.confirmedAt,
            isCurrent: true,
          },
        });
      }
      const existingLines = await tx.rentalSelectionLine.findMany({
        where: { sessionId },
        select: { contractItemComponentId: true },
      });
      for (const c of components) {
        if (existingLines.some((l) => l.contractItemComponentId === c.id)) continue;
        await tx.rentalSelectionLine.create({
          data: {
            id: uuid(),
            sessionId,
            contractItemComponentId: c.id,
            componentType: c.componentType,
            colorCode: colorFor(c.componentType),
            sizeCode: sizeFor(c.componentType),
          },
        });
      }
      result.rentalConfirmed += 1;
      continue;
    }

    // 맞춤 — 옵션 세션이 전 단계 선택 + CONFIRMED 여야 한다.
    const session = item.optionSelectionSessions[0];
    if (session?.status === 'CONFIRMED') continue;
    const set = setOf(item.productCategory);
    if (!set?.activeVersion) {
      result.skipped.push(`${item.displayName}(${item.productCategory}) — 활성 옵션 세트 없음`);
      continue;
    }
    // 세션이 이미 있으면 그 버전의 단계를, 없으면 활성 버전의 단계를 채운다.
    const versionId = session?.optionSetVersionId ?? set.activeVersion.id;
    const stages =
      versionId === set.activeVersion.id
        ? set.activeVersion.stages
        : await tx.optionStage.findMany({
            where: { optionSetVersionId: versionId, active: true },
            orderBy: { sequenceNo: 'asc' },
            select: {
              id: true,
              choices: { where: { active: true }, orderBy: { choiceCode: 'asc' }, select: { id: true, extraPrice: true } },
            },
          });

    const sessionId = session?.id ?? uuid();
    if (!session) {
      await tx.optionSelectionSession.create({
        data: {
          id: sessionId,
          contractItemId: item.id,
          optionSetVersionId: versionId,
          selectionVersionNo: 1,
          status: 'CONFIRMED',
          currentStageId: null,
          startedAt: args.confirmedAt,
          lastSavedAt: args.confirmedAt,
          reviewedAt: args.confirmedAt,
          confirmedAt: args.confirmedAt,
          isCurrent: true,
        },
      });
    }

    // 빠진 단계는 추가금액 없는 선택지로 채운다 — 계약 금액이 시드 값에서 흔들리지 않게.
    const chosen = new Set((session?.values ?? []).map((v) => v.optionStageId));
    let added = 0;
    for (const stage of stages) {
      if (chosen.has(stage.id)) continue;
      const choice =
        stage.choices.find((c) => Number(c.extraPrice) === 0) ?? stage.choices[0];
      if (!choice) continue;
      added += Number(choice.extraPrice);
      await tx.optionSelectionValue.create({
        data: {
          id: uuid(),
          selectionSessionId: sessionId,
          optionStageId: stage.id,
          optionChoiceId: choice.id,
          extraPriceSnapshot: choice.extraPrice,
          selectedBy: args.adminId,
          selectedAt: args.confirmedAt,
        },
      });
    }

    // 확정 세션에는 미반영 차액이 남지 않는다 — 세션 전체 추가금액을 반영으로 적는다.
    const already = Number(session?.surchargeApplied ?? 0);
    const existing = (session?.values ?? []).reduce((s, v) => s + Number(v.extraPriceSnapshot), 0);
    const total = existing + added;
    await tx.optionSelectionSession.update({
      where: { id: sessionId },
      data: {
        status: 'CONFIRMED',
        currentStageId: null,
        reviewedAt: args.confirmedAt,
        confirmedAt: args.confirmedAt,
        surchargeApplied: total,
        surchargeAppliedAt: args.confirmedAt,
      },
    });
    addedSurcharge.set(item.contractId, (addedSurcharge.get(item.contractId) ?? 0) + (total - already));
    result.customConfirmed += 1;
  }

  for (const [contractId, amount] of addedSurcharge) {
    if (amount === 0) continue;
    const contract = await tx.contract.findUnique({
      where: { id: contractId },
      select: { currentVersionId: true },
    });
    if (!contract?.currentVersionId) continue;
    await tx.contractVersion.update({
      where: { id: contract.currentVersionId },
      data: { totalAmount: { increment: amount } },
    });
  }

  return result;
}
