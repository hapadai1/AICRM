import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { anyInProduction } from '../production/production-status';
import { SESSION_INCLUDE, surchargeTotalOf } from '../options/option-session.shared';
import { asAuditClient, CATEGORY_LABEL, COMPONENT_LABEL, COMPONENT_MAP } from './contracts.shared';

/**
 * 계약 품목·컨설팅 동기화 (2026-08-05 contracts.service에서 분리).
 *
 * 계약 라인 ↔ 벌 단위 품목(ContractItem)·부위(Component) 정합, 베스트 포함/제외,
 * 옵션 추가금 롤업 라인, 컨설팅 준비 판정을 담당한다 — 스타일 컨설팅이 붙는 축이다.
 */
@Injectable()
export class ContractItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 베스트 포함/제외 (현업 확정 2026-08-01) — 스타일 컨설팅 화면의 [베스트 제외] 체크박스.
   *
   * 계약서는 베스트를 다루지 않는다. 정장은 맞춤·렌탈 모두 상의·하의·베스트 세 부위로
   * 만들어지고, 어느 벌에서 뺄지는 옷을 고르면서 여기서 정한다. 이 API가 유일한 경로라
   * 체크(제외)와 해제(재포함)를 한 메서드로 왕복한다.
   *
   * **금액은 건드리지 않는다** — 베스트 값이 그때그때 달라 계약금액은 계약서에서 수기로
   * 조정한다. 다만 이미 계약금액에 반영한 베스트 *옵션 추가금*은 되돌린다(고른 적 없는
   * 옵션의 돈이 계약에 남으면 안 된다).
   *
   * 작성중(DRAFT)에서만 허용한다 — 서명·완료된 계약은 [수정하기]로 새 버전을 만든 뒤
   * 같은 조작을 한다(재서명·재완료 흐름).
   */
  async setVestIncluded(contractItemId: string, included: boolean, actor: AuthUser) {
    const item = await this.prisma.contractItem.findUnique({
      where: { id: contractItemId },
      include: {
        components: true,
        contract: { select: { id: true, contractNo: true, status: true, rowVersion: true, currentVersionId: true } },
        sourceContractLine: true,
        orderItems: { select: { status: true } },
      },
    });
    if (!item) throw new NotFoundException('계약 품목이 없습니다.');
    const contract = item.contract;
    if (contract.status !== 'DRAFT')
      throw new BusinessException(
        'CONTRACT_NOT_DRAFT',
        '작성중인 계약에서만 베스트를 바꿀 수 있습니다. 계약서 [수정하기]로 되돌린 뒤 진행해 주세요.',
        undefined,
        { status: contract.status },
      );
    // 컨설팅 잠금과 같은 규칙 — 제작 진행 중(발주 이후) 벌은 손대지 않는다 (0731).
    const inProduction = anyInProduction(item.orderItems);
    if (inProduction)
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '제작 진행 중인 품목은 베스트를 바꿀 수 없습니다. 제작·입출고 화면에서 상태를 되돌린 뒤 진행해 주세요.',
      );
    if (!this.isVestCapable(item.transactionType, item.productCategory))
      throw new BusinessException('VALIDATION_ERROR', '정장 품목에서만 베스트를 바꿀 수 있습니다.', [
        { field: 'contractItemId', reason: 'NOT_SUIT' },
      ]);
    if (item.status === 'CANCELLED')
      throw new BusinessException('VALIDATION_ERROR', '취소된 품목입니다.', [
        { field: 'contractItemId', reason: 'ITEM_CANCELLED' },
      ]);

    const wasIncluded = item.components.some(
      (c) => c.componentType === 'VEST' && c.status !== 'CANCELLED',
    );
    if (wasIncluded === included)
      return {
        contractItemId: item.id,
        contractId: contract.id,
        contractNo: contract.contractNo,
        displayName: item.displayName,
        vestIncluded: included,
        changed: false,
      };

    await this.prisma.$transaction(async (tx) => {
      // 부위를 켜고 끈다(물리 삭제 없음). 제외면 그 벌의 베스트 옵션 선택·반영 추가금도 정리한다.
      // 계약서 라인·합계는 건드리지 않는다 — 베스트 금액은 계약서에서 수기로 조정한다.
      await this.syncVestComponent(tx, item, included);
      // 낙관적 잠금·감사 — 계약 품목 구성이 바뀌었다.
      await tx.contract.update({ where: { id: contract.id }, data: { rowVersion: { increment: 1 } } });
      await this.audit.log(
        {
          userId: actor.id,
          action: 'UPDATE',
          entityType: 'CONTRACT_ITEM',
          entityId: item.id,
          before: { displayName: item.displayName, vestIncluded: wasIncluded },
          after: { displayName: item.displayName, vestIncluded: included },
          reason: included
            ? '베스트 포함 (스타일 컨설팅 — [베스트 제외] 해제)'
            : '베스트 제외 (스타일 컨설팅 — [베스트 제외] 체크)',
        },
        asAuditClient(tx),
      );
    });

    return {
      contractItemId: item.id,
      contractId: contract.id,
      contractNo: contract.contractNo,
      displayName: item.displayName,
      vestIncluded: included,
      changed: true,
    };
  }

  /**
   * 스타일 컨설팅이 전 품목 끝났는지 본다. 컨설팅은 작성중 단계의 계약 품목(ContractItem)에서 진행한다.
   *
   * 맞춤(CUSTOM) 품목은 옵션 선택 세션이, 렌탈(RENTAL) 품목은 렌탈 선택 세션이 각각 CONFIRMED여야 한다.
   * 취소된 품목은 대상에서 뺀다. 품목이 없으면(라인 미입력) 준비된 것으로 보지 않는다.
   */
  async consultingReadiness(contractId: string) {
    const items = await this.prisma.contractItem.findMany({
      where: { contractId, status: { not: 'CANCELLED' } },
      select: {
        id: true,
        displayName: true,
        transactionType: true,
        components: { select: { id: true, componentType: true, status: true } },
        optionSelectionSessions: {
          where: { isCurrent: true },
          select: {
            status: true,
            values: { select: { optionStageId: true } },
            optionSetVersion: {
              select: {
                stages: { where: { active: true }, select: { id: true, componentGroup: true } },
              },
            },
          },
        },
        rentalSelectionSessions: {
          where: { isCurrent: true },
          select: {
            status: true,
            pickupDate: true,
            returnDueDate: true,
            lines: { select: { contractItemComponentId: true, selectedInventoryItemId: true } },
          },
        },
      },
    });

    const pending: { contractItemId: string; displayName: string; transactionType: string }[] = [];
    let targetCount = 0;
    for (const item of items) {
      targetCount += 1;
      let done = false;
      if (item.transactionType === 'RENTAL') {
        // 렌탈은 "확정"을 따로 누르지 않는다 — 취소 안 된 모든 부위에 실물이 지정되고
        // 대여 기간이 있으면 선택 완료로 본다(서명 시점에 서버가 자동 확정한다, 현업 확정 2026-08-11).
        // 이미 확정된 세션(과거 수동 확정·재서명 등)도 그대로 완료로 인정한다.
        const session = item.rentalSelectionSessions[0];
        if (session) {
          if (session.status === 'CONFIRMED') {
            done = true;
          } else {
            const activeComponents = item.components.filter((c) => c.status !== 'CANCELLED');
            const picked = new Set(
              session.lines.filter((l) => l.selectedInventoryItemId).map((l) => l.contractItemComponentId),
            );
            const allPicked =
              activeComponents.length > 0 && activeComponents.every((c) => picked.has(c.id));
            done = allPicked && !!session.pickupDate && !!session.returnDueDate;
          }
        }
      } else {
        // 확정 상태만으로는 모자란 경우가 하나 있다 — 2피스로 확정한 뒤 베스트를 추가하면
        // 베스트 단계가 미선택인 채 확정으로 남는다. 확정 시점 검증(confirm)이 보장하는
        // 나머지 단계는 다시 세지 않고, **베스트 단계의 공백만** 미완료로 본다.
        const session = item.optionSelectionSessions[0];
        if (session?.status === 'CONFIRMED') {
          const vestActive = item.components.some(
            (c) => c.componentType === 'VEST' && c.status !== 'CANCELLED',
          );
          const vestStages = vestActive
            ? session.optionSetVersion.stages.filter((s) => s.componentGroup === 'VEST')
            : [];
          const selected = new Set(session.values.map((v) => v.optionStageId));
          done = vestStages.every((s) => selected.has(s.id));
        }
      }
      if (!done) {
        pending.push({
          contractItemId: item.id,
          displayName: item.displayName,
          transactionType: item.transactionType,
        });
      }
    }
    return { ready: targetCount > 0 && pending.length === 0, targetCount, pending };
  }

  /**
   * 스타일 컨설팅 옵션 추가금액을 계약 품목의 '옵션(추가금액)' 라인으로 동기화한다.
   *
   * **소스 맞춤 라인마다 한 줄씩** 만들어 그 라인 바로 아래에 오도록 둔다(현업 요청 2026-08-08):
   * 맞춤 정장 라인 → 그 정장의 옵션(추가금액) 라인 → 다음 맞춤 정장 라인 → …
   * 금액은 그 라인에 속한 벌들의 반영 누계(surchargeApplied) 합계라, 확정 시 계약 버전
   * 금액(totalAmount)에 더한 값과 합이 정확히 같다.
   *
   * 이 라인은 백엔드가 소유한다: 화면 저장 본문에는 실려 오지 않고(프론트가 제외),
   * 라인 재생성(초안 수정·변경계약)·확정 반영 때마다 여기서 지우고 다시 만든다.
   * 옵션이 붙은 벌이 없으면 라인을 두지 않는다.
   */
  async syncOptionRollupLine(
    tx: Prisma.TransactionClient,
    contractId: string,
    versionId: string,
  ): Promise<void> {
    const sessions = await tx.optionSelectionSession.findMany({
      where: { contractItem: { contractId }, isCurrent: true },
      // 벌 순번으로 정렬해 한 라인에 여러 벌이 있을 때 정장 #1, #2… 순으로 싣는다.
      orderBy: { contractItem: { sequenceNo: 'asc' } },
      select: {
        surchargeApplied: true,
        contractItem: { select: { displayName: true, sourceContractLineId: true } },
        // 비고에 부위별로 나열할 유료 옵션 — 추가금액이 붙은 선택지만. 단계의 부위(componentGroup)로 묶는다.
        values: {
          where: { extraPriceSnapshot: { gt: 0 } },
          select: {
            optionChoice: { select: { choiceName: true } },
            optionStage: { select: { componentGroup: true, sequenceNo: true } },
          },
        },
      },
    });

    // 항상 먼저 걷어낸다 — 금액·구성이 바뀌면 라인을 다시 만들기 위해.
    await tx.contractLine.deleteMany({
      where: { contractVersionId: versionId, isOptionRollup: true },
    });

    // 유료 옵션을 상의 → 하의 → 베스트 순으로 부위별 한 줄씩 묶어 적는다.
    const GROUP_ORDER: Record<string, number> = { JACKET: 0, TROUSERS: 1, VEST: 2, SHIRT: 3, SHOES: 4 };
    const groupNote = (vals: Array<{ name: string; group: string | null }>): string => {
      const byGroup = new Map<string, string[]>();
      for (const v of vals) {
        const key = v.group ?? '';
        const names = byGroup.get(key) ?? [];
        names.push(v.name);
        byGroup.set(key, names);
      }
      return [...byGroup.entries()]
        .sort((a, b) => (GROUP_ORDER[a[0]] ?? 99) - (GROUP_ORDER[b[0]] ?? 99))
        .map(([g, names]) => (g ? `${COMPONENT_LABEL[g] ?? g}: ${names.join(', ')}` : names.join(', ')))
        .join('\n');
    };

    // 소스 맞춤 라인별로 벌(정장)을 묶는다 — 옵션이 붙은 벌만. 옵션은 단계 순번대로 정렬한다.
    type Val = { name: string; group: string | null };
    const byLine = new Map<string, Array<{ name: string; vals: Val[]; subtotal: number }>>();
    for (const s of sessions) {
      const lineId = s.contractItem.sourceContractLineId;
      const vals: Val[] = [...s.values]
        .sort((a, b) => a.optionStage.sequenceNo - b.optionStage.sequenceNo)
        .map((v) => ({ name: v.optionChoice.choiceName, group: v.optionStage.componentGroup }));
      if (!lineId || vals.length === 0) continue;
      const arr = byLine.get(lineId) ?? [];
      arr.push({ name: s.contractItem.displayName, vals, subtotal: Number(s.surchargeApplied) });
      byLine.set(lineId, arr);
    }
    if (byLine.size === 0) return;

    // 소스 라인의 sortOrder를 그대로 물려줘, 조회 정렬(sortOrder→롤업 뒤)에서 라인 바로 아래에 오게 한다.
    const sourceLines = await tx.contractLine.findMany({
      where: { contractVersionId: versionId, id: { in: [...byLine.keys()] } },
      select: { id: true, sortOrder: true },
    });
    for (const src of sourceLines) {
      const items = byLine.get(src.id)!;
      const subtotalSum = items.reduce((sum, it) => sum + it.subtotal, 0);
      // 한 라인에 벌이 여럿이면 정장명·소계를 머리로, 그 아래 부위별 옵션을 적고 벌 사이는 빈 줄로 띄운다.
      // 한 벌뿐이면 부위별 옵션만 적는다.
      const notes =
        items.length > 1
          ? items
              .map((it) => `${it.name} (${it.subtotal.toLocaleString('ko-KR')}원)\n${groupNote(it.vals)}`)
              .join('\n\n')
          : groupNote(items[0].vals);
      await tx.contractLine.create({
        data: {
          id: randomUUID(),
          contractVersionId: versionId,
          // 실제 거래방식·품목이 아니라 옵션 합산 라인임을 나타내는 표식값.
          transactionType: 'OPTION',
          productCategory: 'OPTION',
          itemDescription: '옵션(추가금액)',
          quantity: 1,
          unitPrice: subtotalSum,
          lineAmount: subtotalSum,
          vestIncluded: false,
          vestUnitPrice: null,
          notes,
          sortOrder: src.sortOrder,
          isOptionRollup: true,
        },
      });
    }
  }

  /**
   * 계약 전체의 선택 옵션 추가금 반영 상태 — 계약서 작성 화면의 '반영 확인' 배지용.
   * total: 현재 선택된 유료 옵션 합계, applied: 계약금액에 이미 반영한 누계, pending: 미반영 차액.
   * total 계산은 활성 단계(베스트 제외 등)를 거르는 surchargeTotalOf를 벌마다 재사용해
   * 컨설팅 화면(추가금액 패널)과 같은 기준을 따른다.
   */
  async contractSurchargeSummary(
    contractId: string,
  ): Promise<{ total: number; applied: number; pending: number }> {
    const sessions = await this.prisma.optionSelectionSession.findMany({
      where: { contractItem: { contractId }, isCurrent: true },
      include: SESSION_INCLUDE,
    });
    let total = 0;
    let applied = 0;
    for (const s of sessions) {
      total += surchargeTotalOf(s);
      applied += Number(s.surchargeApplied);
    }
    return { total, applied, pending: total - applied };
  }

  /**
   * 계약 품목 라인별 옵션 반영 상태 — 계약서 작성 화면의 품목 행 배지용.
   * 맞춤(CUSTOM) 라인마다 그 라인에 속한 벌(ContractItem)의 현재 세션을 본다:
   * 그 라인의 활성 벌이 모두 컨설팅 확정(CONFIRMED)이고 미반영 차액이 0이면 true(반영완료).
   * 추가금 옵션을 안 고른 벌도 확정만 됐으면 true라, 옵션 롤업 라인이 없어도 '반영완료'로 확인된다.
   * 결과 맵에 없는 라인(렌탈·컨설팅 대상 아님)은 화면에서 배지를 띄우지 않는다.
   */
  async contractLineOptionStatus(contractId: string): Promise<Record<string, boolean>> {
    const items = await this.prisma.contractItem.findMany({
      where: { contractId, transactionType: 'CUSTOM', status: { not: 'CANCELLED' } },
      select: { id: true, sourceContractLineId: true },
    });
    const sessions = await this.prisma.optionSelectionSession.findMany({
      where: { contractItem: { contractId }, isCurrent: true },
      include: SESSION_INCLUDE,
    });
    const sessionByItem = new Map(sessions.map((s) => [s.contractItemId, s]));

    const byLine = new Map<string, { total: number; reflected: number }>();
    for (const item of items) {
      if (!item.sourceContractLineId) continue;
      const s = sessionByItem.get(item.id);
      // 확정 + 미반영 차액 0 → 이 벌은 옵션 반영 완료.
      const ok = !!s && s.status === 'CONFIRMED' && surchargeTotalOf(s) - Number(s.surchargeApplied) === 0;
      const agg = byLine.get(item.sourceContractLineId) ?? { total: 0, reflected: 0 };
      agg.total += 1;
      if (ok) agg.reflected += 1;
      byLine.set(item.sourceContractLineId, agg);
    }
    const result: Record<string, boolean> = {};
    for (const [lineId, agg] of byLine) result[lineId] = agg.total > 0 && agg.reflected === agg.total;
    return result;
  }

  /**
   * 계약 품목 정합 — 계약 라인(거래방식×품목×수량)을 벌 단위 ContractItem으로 펼친다.
   * 컨설팅(옵션·렌탈 선택)이 이 품목·부위(ContractItemComponent)에 붙는다.
   *
   * **품목은 계약 소유다**(현업 확정 2026-07-30). 수정하기(버전업)로 새 버전이 생겨도 품목은
   * 그대로 이어지고, 여기서 수량 차이만 반영한다. **주문(Order)은 만들지 않는다** —
   * 계약완료 시 syncOrders가 이 품목을 주문으로 물리화한다.
   * - 수량 증가: 다음 sequence_no로 신규 품목 + 기본 구성품 생성 (그 품목만 컨설팅 미선택)
   * - 수량 감소:
   *   · 작성중이고 아직 물리화(주문)되지 않았으면 → 지우고 순번을 다시 채운다(#1…#n 연속).
   *     계약 성립 전이라 이력을 남길 대상이 아니고, 번호가 튀면 현장에서 헷갈린다.
   *   · 그 밖에는 뒤 순번부터 CANCELLED (사유 기록, 물리 삭제 금지 → 주문·작업지시서 보존)
   */
  async syncContractItems(
    tx: Prisma.TransactionClient,
    contractId: string,
    versionId: string,
    cancelReason: string | null,
  ): Promise<void> {
    const lines = await tx.contractLine.findMany({
      // 옵션 추가금액 롤업 라인은 실제 벌이 아니므로 컨설팅 대상 품목으로 펼치지 않는다.
      where: { contractVersionId: versionId, isOptionRollup: false },
      orderBy: { sortOrder: 'asc' },
    });

    // 라인을 벌 단위 슬롯으로 편다 — 슬롯 순서(라인 sortOrder → 수량)가 품목 순번(#1…#n)과 짝이 된다.
    const slotsByKey = new Map<string, Array<{ lineId: string }>>();
    for (const line of lines) {
      const key = `${line.transactionType}|${line.productCategory}`;
      const slots = slotsByKey.get(key) ?? [];
      for (let n = 0; n < line.quantity; n += 1) slots.push({ lineId: line.id });
      slotsByKey.set(key, slots);
    }

    const existingItems = await tx.contractItem.findMany({
      where: { contractId },
      // 물리화(주문품목) 여부가 '지워도 되는 품목'을, 상태가 '베스트를 꺼도 되는 품목'을 가른다.
      include: { orderItems: { select: { id: true, status: true } }, components: true },
    });
    const keys = new Set<string>([
      ...slotsByKey.keys(),
      ...existingItems.map((i) => `${i.transactionType}|${i.productCategory}`),
    ]);

    for (const key of keys) {
      const [transactionType, productCategory] = key.split('|');
      const slots = slotsByKey.get(key) ?? [];
      const targetQty = slots.length;
      let itemsOfKey = existingItems.filter(
        (i) => i.transactionType === transactionType && i.productCategory === productCategory,
      );
      let activeItems = itemsOfKey
        .filter((i) => i.status !== 'CANCELLED')
        .sort((a, b) => a.sequenceNo - b.sequenceNo);

      if (targetQty < activeItems.length) {
        // 수량 감소는 **주문으로 물리화되지 않은 품목만** 뒤 순번부터 지운다 (현업 확정 2026-07-31).
        // 수정하기(버전업)는 품목 추가 전용이라, 물리화된 품목이 감소 대상에 걸리면
        // 저장 자체를 거부한다 — 제작 중인 옷이 계약 변경으로 조용히 취소되는 것을 막는다.
        const deficit = activeItems.length - targetQty;
        const removable = activeItems.filter((i) => i.orderItems.length === 0).slice(-deficit);
        if (removable.length < deficit) {
          const blocked = activeItems.filter((i) => i.orderItems.length > 0);
          const sample = blocked[blocked.length - 1];
          throw new BusinessException(
            'INVALID_STATUS_TRANSITION',
            `${sample.displayName}은(는) 주문이 진행 중이라 수량을 줄일 수 없습니다. 수정하기에서는 품목 추가만 가능합니다.`,
            undefined,
            { blockedItemIds: blocked.map((i) => i.id) },
          );
        }
        await this.deleteContractItemsDeep(
          tx,
          removable.map((i) => i.id),
        );
        const removedIds = new Set(removable.map((i) => i.id));
        itemsOfKey = itemsOfKey.filter((i) => !removedIds.has(i.id));
        activeItems = activeItems.filter((i) => !removedIds.has(i.id));
      } else if (targetQty > activeItems.length) {
        const label =
          transactionType === 'RENTAL'
            ? `렌탈 ${CATEGORY_LABEL[productCategory] ?? productCategory}`
            : CATEGORY_LABEL[productCategory] ?? productCategory;
        // 취소된 품목이 차지한 순번은 비켜 간다(이력 보존). 남은 품목 기준으로 다음 번호를 뽑는다.
        const maxSeq = itemsOfKey.reduce((m, i) => Math.max(m, i.sequenceNo), 0);
        // 루프 안에서 activeItems에 push하므로 생성 수·슬롯 기준 위치를 먼저 고정한다.
        const baseLen = activeItems.length;
        const createCount = targetQty - baseLen;
        for (let n = 1; n <= createCount; n += 1) {
          const seq = maxSeq + n;
          const slot = slots[baseLen + n - 1];
          const componentTypes = [...(COMPONENT_MAP[productCategory] ?? [productCategory])];
          const created = await tx.contractItem.create({
            data: {
              id: randomUUID(),
              contractId,
              sourceContractLineId: slot?.lineId ?? null,
              transactionType,
              productCategory,
              sequenceNo: seq,
              displayName: `${label} #${seq}`,
              status: 'CREATED',
              components: {
                create: componentTypes.map((componentType) => ({
                  id: randomUUID(),
                  componentType,
                  sequenceNo: 1,
                  status: 'CREATED',
                })),
              },
            },
            include: { components: true },
          });
          activeItems.push({ ...created, orderItems: [] });
        }
      }

      // 살아남은 벌을 슬롯과 짝지어 라인 참조를 다시 건다.
      // (계약 수정·버전업으로 라인이 삭제·재생성돼 참조가 끊기는 문제도 여기서 함께 정합된다.)
      //
      // 베스트 부위는 여기서 건드리지 않는다 (현업 확정 2026-08-01) — 뺄지 말지는 컨설팅이
      // 단독으로 갖는다. 예전처럼 라인 값에 맞추면, 컨설팅에서 뺀 뒤 계약서에서 금액을
      // 수기로 고쳐 저장하는 순간(바로 그 흐름이다) 제외가 풀려 되살아난다.
      for (let idx = 0; idx < activeItems.length; idx += 1) {
        const item = activeItems[idx];
        const slot = slots[idx];
        if (!slot) continue;
        if (item.sourceContractLineId !== slot.lineId)
          await tx.contractItem.update({
            where: { id: item.id },
            data: { sourceContractLineId: slot.lineId },
          });
      }
    }
  }

  /**
   * 계약 품목과 그에 딸린 컨설팅 산출물을 물리 삭제한다.
   * 주문으로 물리화되지 않은 품목에만 쓴다 — 주문품목이 있으면 취소로 남겨야 한다.
   */
  async deleteContractItemsDeep(tx: Prisma.TransactionClient, itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return;
    const rentalSessionIds = (
      await tx.rentalSelectionSession.findMany({
        where: { contractItemId: { in: itemIds } },
        select: { id: true },
      })
    ).map((s) => s.id);
    if (rentalSessionIds.length > 0)
      await tx.rentalSelectionLine.deleteMany({ where: { sessionId: { in: rentalSessionIds } } });
    await tx.rentalSelectionSession.deleteMany({ where: { contractItemId: { in: itemIds } } });

    const optionSessionIds = (
      await tx.optionSelectionSession.findMany({
        where: { contractItemId: { in: itemIds } },
        select: { id: true },
      })
    ).map((s) => s.id);
    if (optionSessionIds.length > 0) {
      await tx.optionSelectionValue.deleteMany({ where: { selectionSessionId: { in: optionSessionIds } } });
      await tx.optionSelectionComponentAttr.deleteMany({
        where: { selectionSessionId: { in: optionSessionIds } },
      });
    }
    await tx.optionSelectionSession.deleteMany({ where: { contractItemId: { in: itemIds } } });
    await tx.contractItemComponent.deleteMany({ where: { contractItemId: { in: itemIds } } });
    await tx.contractItem.deleteMany({ where: { id: { in: itemIds } } });
  }

  /**
   * 베스트를 켜고 끌 수 있는 품목인가 — 정장이면 맞춤·렌탈 모두 (현업 확정 2026-08-01).
   * 셔츠·구두는 베스트가 없다.
   */
  private isVestCapable(_transactionType: string, productCategory: string): boolean {
    return productCategory === 'SUIT';
  }

  /**
   * 품목의 VEST 부위를 켜고 끈다 (컨설팅 [베스트 제외] 체크박스 — setVestIncluded 전용).
   * - 포함: 취소된 부위가 있으면 되살리고, 없으면 새로 만든다.
   * - 제외: 부위를 CANCELLED로 두고(물리 삭제 금지) 그 품목의 베스트 옵션 선택도 정리한다.
   *   제외는 '감소'라 **제작 진행 중(제작요청 이후) 벌은 거부**한다 (현업 확정 2026-07-31).
   * 주문품목 구성품은 여기서 건드리지 않는다 — 계약완료 시 syncOrders 가 증분 반영한다.
   */
  private async syncVestComponent(
    tx: Prisma.TransactionClient,
    item: {
      id: string;
      displayName: string;
      components: { id: string; componentType: string; status: string }[];
      orderItems: { status: string }[];
    },
    vestIncluded: boolean,
  ): Promise<void> {
    const vest = item.components
      .filter((c) => c.componentType === 'VEST')
      .sort((a, b) => (a.status === 'CANCELLED' ? 1 : 0) - (b.status === 'CANCELLED' ? 1 : 0))[0];

    if (vestIncluded) {
      if (vest && vest.status !== 'CANCELLED') return; // 이미 켜져 있다
      if (vest)
        await tx.contractItemComponent.update({ where: { id: vest.id }, data: { status: 'CREATED' } });
      else
        await tx.contractItemComponent.create({
          data: { id: randomUUID(), contractItemId: item.id, componentType: 'VEST', sequenceNo: 1, status: 'CREATED' },
        });
    } else if (vest && vest.status !== 'CANCELLED') {
      if (anyInProduction(item.orderItems))
        throw new BusinessException(
          'INVALID_STATUS_TRANSITION',
          `${item.displayName}은(는) 제작 진행 중이라 베스트를 제외할 수 없습니다. 제작·입출고 화면에서 상태를 되돌린 뒤 진행해 주세요.`,
        );
      await tx.contractItemComponent.update({ where: { id: vest.id }, data: { status: 'CANCELLED' } });
      await this.removeVestSelections(tx, item.id);
    }
  }

  /**
   * 품목의 현재 옵션 세션에서 베스트 부위 흔적을 지운다 — VEST 단계 선택값과
   * 부위별 원단·컬러·패턴. 이미 계약금액에 반영한 베스트 옵션 추가금액이 있으면
   * 차액을 계약 현재 버전 금액에서 되돌리고 반영 누계를 맞춘다.
   * 남은 단계가 전부 선택된 미확정 세션은 REVIEW로 올려 완료 판정이 어긋나지 않게 한다.
   */
  private async removeVestSelections(tx: Prisma.TransactionClient, contractItemId: string): Promise<void> {
    const session = await tx.optionSelectionSession.findFirst({
      where: { contractItemId, isCurrent: true },
      include: {
        values: { include: { optionStage: { select: { componentGroup: true, active: true } } } },
        contractItem: { select: { contract: { select: { currentVersionId: true } } } },
      },
    });
    if (!session) return;

    const vestValueIds = session.values
      .filter((v) => v.optionStage.componentGroup === 'VEST')
      .map((v) => v.id);
    if (vestValueIds.length > 0)
      await tx.optionSelectionValue.deleteMany({ where: { id: { in: vestValueIds } } });
    await tx.optionSelectionComponentAttr.deleteMany({
      where: { selectionSessionId: session.id, componentGroup: 'VEST' },
    });

    // 반영 누계 정산 — 남은 선택 합계보다 이미 반영한 금액이 크면 그 차액을 되돌린다.
    const remainingTotal = session.values
      .filter((v) => v.optionStage.componentGroup !== 'VEST' && v.optionStage.active)
      .reduce((sum, v) => sum + Number(v.extraPriceSnapshot), 0);
    const applied = Number(session.surchargeApplied);
    if (applied > remainingTotal) {
      const versionId = session.contractItem.contract?.currentVersionId;
      if (versionId)
        await tx.contractVersion.update({
          where: { id: versionId },
          data: { totalAmount: { decrement: applied - remainingTotal } },
        });
      await tx.optionSelectionSession.update({
        where: { id: session.id },
        data: { surchargeApplied: remainingTotal },
      });
    }

    // 베스트 단계가 빠지면서 나머지가 이미 다 선택돼 있으면 검토 단계로 올린다.
    if (session.status === 'IN_PROGRESS') {
      const stages = await tx.optionStage.findMany({
        where: {
          optionSetVersionId: session.optionSetVersionId,
          active: true,
          NOT: { componentGroup: 'VEST' },
        },
        select: { id: true },
      });
      const selected = new Set(
        session.values.filter((v) => v.optionStage.componentGroup !== 'VEST').map((v) => v.optionStageId),
      );
      if (stages.length > 0 && stages.every((s) => selected.has(s.id)))
        await tx.optionSelectionSession.update({
          where: { id: session.id },
          data: { status: 'REVIEW', reviewedAt: new Date(), rowVersion: { increment: 1 } },
        });
    }
  }
}
