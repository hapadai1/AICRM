import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { todayAsDbDate } from '../../common/date';
import { AuthUser } from '../../common/decorators';
import { AuditService } from '../audit/audit.service';
import { autoLinkMeasurements } from '../measurements/measurement-link';
import { applyItemStatus } from '../production/item-status';
import { orderItemIdsOfContract, syncPrepStatuses } from '../production/prep-status';
import { asAuditClient, nextNo, OrderSummary } from './contracts.shared';

/**
 * 계약완료 물리화 (2026-08-05 contracts.service에서 분리).
 *
 * 계약이 성립하는 순간 한 트랜잭션으로 일어나는 일들 — 확정 버전 굳히기, 고객 전환,
 * 주문·주문품목 생성(syncOrders), 진행(journey) 시작·전진, 채촌 자동 연결, 준비 상태 반영 —
 * 을 담당한다. 계약서 문서 축(버전·서명·출력)과 분리해, 제작·주문·진행 규칙을 고칠 때
 * 계약서 코드를 열지 않아도 되게 한다.
 */
@Injectable()
export class ContractMaterializeService {
  constructor(private readonly audit: AuditService) {}

  /**
   * 계약이 성립할 때 한 번에 처리하는 것들 — 계약완료([계약완료] 버튼)에서만 부른다.
   * 흐름: 작성중 → 서명완료 → **계약완료(여기)** → 수정하기(버전업) → 작성중 …
   *
   * 예전에는 '등록(확정)' 단계가 이 일을 앞에서 했는데, 컨설팅이 작성중 단계로 내려와
   * 등록을 앞세울 이유가 없어졌다. 서명한 버전을 확정본으로 굳히고, 주문·고객·진행단계를
   * 여기서 맞춘다. 수정하기로 다시 완료해도 품목이 계약 소유라 같은 주문품목이 이어진다.
   */
  async physicalizeOnComplete(
    tx: Prisma.TransactionClient,
    contract: {
      id: string;
      customerId: string;
      contractedAt: Date | null;
      customer?: { contractedAt: Date | null; registeredAt: Date | null } | null;
    },
    version: { id: string; completionDueDate: Date | null; photoDate: Date | null; weddingDate: Date | null },
    actor: AuthUser,
    completedAt: Date,
  ): Promise<{ orders: OrderSummary[]; customerStatus: string }> {
    await tx.contractVersion.update({
      where: { id: version.id },
      data: { versionStatus: 'CONFIRMED', confirmedBy: actor.id, confirmedAt: completedAt },
    });
    // 이전 확정 버전 보존: SUPERSEDED (설계서 6.3)
    await tx.contractVersion.updateMany({
      where: { contractId: contract.id, versionStatus: 'CONFIRMED', id: { not: version.id } },
      data: { versionStatus: 'SUPERSEDED' },
    });

    const customer = await tx.customer.update({
      where: { id: contract.customerId },
      data: {
        customerStatus: 'CONTRACTED',
        contractedAt: contract.customer?.contractedAt ?? completedAt,
        // 등록 절차를 거치지 않고 계약까지 온 경우를 보정한다 (계약 고객은 반드시 고객 목록에 있어야 한다)
        ...(contract.customer?.registeredAt ? {} : { registeredAt: completedAt }),
        rowVersion: { increment: 1 },
      },
    });

    const orders = await this.syncOrders(
      tx,
      contract.id,
      {
        completionDueDate: version.completionDueDate,
        photoDate: version.photoDate,
        weddingDate: version.weddingDate,
        cancelReason: null,
      },
      actor.id,
    );

    // AUTO 진행단계 훅 (설계서 02 §9.2 / 03 §6 / 07 §7.1).
    // (1) 주문별 진행을 보장하고 — 없으면 계약 단계에서 시작시킨다.
    // (2) 그 밖에 남은 ACTIVE 진행을 계약 단계로 전진시킨다.
    await this.ensureJourneysForOrders(tx, contract.customerId, orders, completedAt, actor.id);
    await this.advanceJourneysToContractConfirmed(tx, contract.customerId, completedAt, actor.id);

    /*
      계약 전에 미리 잰 채촌을 방금 생긴 품목에 붙인다 (현업 확정 2026-08-05).
      정상 순서는 '컨설팅에서 채촌 → 계약완료'인데, 그때는 주문이 없어 붙일 자리가 없었다.
      여기서 붙이지 않으면 준비가 끝난 적이 없는 것으로 남아 제작 목록에 뜨지 않는다.
    */
    await autoLinkMeasurements(tx, contract.customerId, actor.id);

    // 계약 전에 끝내 둔 준비(옵션 확정·채촌)를 물리화된 품목 상태에 반영한다.
    await syncPrepStatuses(tx, await orderItemIdsOfContract(tx, contract.id), actor.id);

    return { orders, customerStatus: customer.customerStatus };
  }

  /**
   * 계약완료 시 물리화 — 계약 품목(ContractItem)을 거래방식별 주문(Order)과 주문품목(OrderItem)으로 옮긴다.
   * 흐름: 계약(작성중) → 컨설팅 → 서명 → **계약완료(여기)** → 주문. 옵션 선택 결과는 ContractItem에
   * 남아 있고, OrderItem은 sourceContractItemId로 그 품목을 되짚어 작업지시서·엑셀이 옵션을 읽는다.
   *
   * 품목은 계약 소유이므로 수정하기(버전업)로 다시 완료해도 **같은 품목 = 같은 주문품목**이다.
   * 늘어난 품목만 주문품목이 새로 생기고, 취소된 품목의 주문품목만 취소된다.
   */
  private async syncOrders(
    tx: Prisma.TransactionClient,
    contractId: string,
    opts: {
      completionDueDate: Date | null;
      photoDate: Date | null;
      weddingDate: Date | null;
      cancelReason: string | null;
    },
    actorId: string,
  ): Promise<OrderSummary[]> {
    const items = await tx.contractItem.findMany({
      where: { contractId },
      include: { components: true },
      orderBy: { sequenceNo: 'asc' },
    });
    const neededTypes = new Set(items.filter((i) => i.status !== 'CANCELLED').map((i) => i.transactionType));

    const existingOrders = await tx.order.findMany({
      where: { contractId },
      include: { items: { include: { components: true } } },
    });
    type ExistingOrderItem = {
      id: string;
      status: string;
      sourceContractItemId: string;
      components: { id: string; componentType: string; sequenceNo: number; status: string }[];
    };
    const ordersByType = new Map<string, { id: string; orderNo: string; transactionType: string; items: ExistingOrderItem[] }>(
      existingOrders.map((o) => [o.transactionType, o]),
    );

    // 필요한 거래방식 주문 생성 (계약당 CUSTOM·RENTAL 각 최대 1건)
    for (const type of ['CUSTOM', 'RENTAL']) {
      if (!neededTypes.has(type) || ordersByType.has(type)) continue;
      const order = await tx.order.create({
        data: {
          id: randomUUID(),
          orderNo: await nextNo(tx, 'ORD'),
          contractId,
          transactionType: type,
          status: 'CREATED',
          completionDueDate: opts.completionDueDate,
          photoDate: opts.photoDate,
          weddingDate: opts.weddingDate,
        },
      });
      ordersByType.set(type, { ...order, items: [] });
    }

    // 기존 주문 일정 갱신
    for (const order of existingOrders) {
      await tx.order.update({
        where: { id: order.id },
        data: {
          completionDueDate: opts.completionDueDate,
          photoDate: opts.photoDate,
          weddingDate: opts.weddingDate,
        },
      });
    }

    // 이미 물리화된 주문품목을 계약 품목 기준으로 매핑
    const orderItemByContractItem = new Map<string, ExistingOrderItem>();
    for (const order of ordersByType.values()) {
      for (const it of order.items) orderItemByContractItem.set(it.sourceContractItemId, it);
    }

    for (const ci of items) {
      const order = ordersByType.get(ci.transactionType);
      if (!order) continue;
      const existing = orderItemByContractItem.get(ci.id);
      if (ci.status === 'CANCELLED') {
        // 안전핀: 계약 변경 경로로는 미진행(CREATED) 주문품목만 취소한다.
        // 진행 중 품목이 취소되는 경로는 없다 — 실물 정리는 오프라인 (현업 확정 2026-07-31).
        if (existing && existing.status === 'CREATED') {
          // 상태 갱신·이력은 단일 기록자(applyItemStatus)로 — 왜 취소됐는지 제작 이력에도 남는다.
          await applyItemStatus(tx, {
            orderItemId: existing.id,
            from: existing.status,
            to: 'CANCELLED',
            eventDate: todayAsDbDate(),
            notes: '계약 변경으로 품목 취소',
            cancelled: { reason: opts.cancelReason ?? '계약 변경' },
            actorId,
          });
          await tx.orderItem.update({
            where: { id: existing.id },
            data: { rowVersion: { increment: 1 } },
          });
          await tx.orderItemComponent.updateMany({
            where: { orderItemId: existing.id, status: 'CREATED' },
            data: { status: 'CANCELLED' },
          });
        }
        continue;
      }
      if (!existing) {
        await tx.orderItem.create({
          data: {
            id: randomUUID(),
            orderId: order.id,
            sourceContractItemId: ci.id,
            productCategory: ci.productCategory,
            sequenceNo: ci.sequenceNo,
            displayName: ci.displayName,
            status: 'CREATED',
            components: {
              create: ci.components
                .filter((c) => c.status !== 'CANCELLED')
                .map((c) => ({
                  id: randomUUID(),
                  componentType: c.componentType,
                  sequenceNo: c.sequenceNo,
                  status: 'CREATED',
                })),
            },
          },
        });
      } else if (existing.status !== 'CANCELLED') {
        // 수정하기(버전업)로 부위가 바뀐 경우(베스트 추가·제외) 재완료 시 구성품을 증분 반영한다.
        await this.syncOrderItemComponents(tx, existing, ci.components);
      }
    }

    return [...ordersByType.values()]
      .sort((a, b) => a.transactionType.localeCompare(b.transactionType))
      .map((o) => ({ id: o.id, orderNo: o.orderNo, tradeType: o.transactionType }));
  }

  /**
   * 기존 주문품목의 구성품을 계약 품목 부위에 증분 정합한다 (재완료 시점, 2026-07-30).
   * - 계약에 살아 있는 부위가 주문에 없으면 생성, 취소돼 있으면 되살린다 (베스트 추가)
   * - 계약에서 취소된 부위의 주문 구성품은 **미진행(CREATED)일 때만** 취소한다 (베스트 제외)
   *   — 입고·배정 등 진행이 시작된 구성품은 현장 판단 대상이라 자동으로 건드리지 않는다.
   */
  private async syncOrderItemComponents(
    tx: Prisma.TransactionClient,
    orderItem: {
      id: string;
      components: { id: string; componentType: string; sequenceNo: number; status: string }[];
    },
    contractComponents: { componentType: string; sequenceNo: number; status: string }[],
  ): Promise<void> {
    const activeContract = contractComponents.filter((c) => c.status !== 'CANCELLED');
    const matchOf = (type: string, seq: number) =>
      orderItem.components.find((oc) => oc.componentType === type && oc.sequenceNo === seq);

    for (const cc of activeContract) {
      const match = matchOf(cc.componentType, cc.sequenceNo);
      if (!match) {
        await tx.orderItemComponent.create({
          data: {
            id: randomUUID(),
            orderItemId: orderItem.id,
            componentType: cc.componentType,
            sequenceNo: cc.sequenceNo,
            status: 'CREATED',
          },
        });
      } else if (match.status === 'CANCELLED') {
        await tx.orderItemComponent.update({ where: { id: match.id }, data: { status: 'CREATED' } });
      }
    }

    for (const oc of orderItem.components) {
      const stillActive = activeContract.some(
        (cc) => cc.componentType === oc.componentType && cc.sequenceNo === oc.sequenceNo,
      );
      if (!stillActive && oc.status === 'CREATED')
        await tx.orderItemComponent.update({ where: { id: oc.id }, data: { status: 'CANCELLED' } });
    }
  }

  /**
   * 계약 확정 시 주문별 진행(journey)을 보장한다 (설계서 07 §7.1).
   *
   * 전에는 진행이 수동 생성뿐이라, 계약을 확정해도 진행 화면과 고객 목록의 진행상태 열이
   * 비어 있었다. 계약 확정이 곧 진행의 시작점(plan_v2 "상담 - 계약 - 스타일 컨설팅")이므로
   * 주문 1건당 진행 1건을 여기서 만든다.
   *
   * 상담 단계에서 수동 생성해 둔 진행(orderId 미연결)이 있으면 새로 만들지 않고 그 진행에
   * 주문을 연결한다 — 그러지 않으면 같은 고객에게 진행이 둘 생긴다.
   */
  private async ensureJourneysForOrders(
    tx: Prisma.TransactionClient,
    customerId: string,
    orders: { id: string; tradeType: string }[],
    confirmedAt: Date,
    actorId: string,
  ): Promise<void> {
    for (const order of orders) {
      // 주문 1건당 진행 1건 (journeys.service.create와 같은 규칙). 취소된 진행은 되살리지 않는다.
      const linked = await tx.customerJourney.findFirst({
        where: { orderId: order.id, status: { not: 'CANCELLED' } },
        select: { id: true },
      });
      if (linked) continue;

      const stages = await tx.journeyStage.findMany({
        where: { trackType: order.tradeType, active: true },
        orderBy: { sequenceNo: 'asc' },
      });
      const target = stages.find((s) => s.code === 'CONTRACT_CONFIRMED');
      // 트랙에 단계 정의가 없으면(시드 미적용) 계약 확정 자체를 막지 않고 넘어간다.
      if (!target) continue;

      // 상담 단계에서 만들어 둔 미연결 진행을 우선 흡수한다.
      const orphan = await tx.customerJourney.findFirst({
        where: {
          customerId,
          orderId: null,
          sourceRepairRequestId: null,
          trackType: order.tradeType,
          status: 'ACTIVE',
        },
        orderBy: { startedAt: 'desc' },
      });

      const journeyId = orphan?.id ?? randomUUID();
      const fromStageCode = orphan?.currentStageCode ?? null;
      if (orphan) {
        await tx.customerJourney.update({
          where: { id: orphan.id },
          data: { orderId: order.id, currentStageCode: target.code, rowVersion: { increment: 1 } },
        });
      } else {
        await tx.customerJourney.create({
          data: {
            id: journeyId,
            customerId,
            orderId: order.id,
            trackType: order.tradeType,
            currentStageCode: target.code,
            status: 'ACTIVE',
            startedAt: confirmedAt,
          },
        });
      }

      await tx.journeyEvent.create({
        data: {
          id: randomUUID(),
          journeyId,
          stageId: target.id,
          fromStageCode,
          toStageCode: target.code,
          notificationOutcome: 'NONE',
          actorId,
          changedAt: confirmedAt,
        },
      });
      await this.audit.log(
        {
          userId: actorId,
          action: orphan ? 'UPDATE' : 'CREATE',
          entityType: 'CUSTOMER_JOURNEY',
          entityId: journeyId,
          after: { trackType: order.tradeType, currentStageCode: target.code, orderId: order.id },
          reason: '계약 확정 시 진행 자동 시작',
        },
        asAuditClient(tx),
      );
    }
  }

  /**
   * 계약완료 시 고객 진행을 CONTRACT_CONFIRMED로 전진한다 (설계서 03 §6, 최소 연동).
   * ACTIVE 진행 중 CONTRACT_CONFIRMED보다 앞선 단계에 있는 건만 전진한다. 진행이 없으면 skip.
   */
  private async advanceJourneysToContractConfirmed(
    tx: Prisma.TransactionClient,
    customerId: string,
    changedAt: Date,
    actorId: string,
  ): Promise<void> {
    const journeys = await tx.customerJourney.findMany({
      where: { customerId, status: 'ACTIVE' },
    });
    if (journeys.length === 0) return;

    for (const journey of journeys) {
      const stages = await tx.journeyStage.findMany({
        where: { trackType: journey.trackType, active: true },
        orderBy: { sequenceNo: 'asc' },
      });
      const target = stages.find((s) => s.code === 'CONTRACT_CONFIRMED');
      if (!target) continue;
      const currentSeq = stages.find((s) => s.code === journey.currentStageCode)?.sequenceNo ?? -1;
      // 이미 계약확정 이상이면 전진하지 않는다(후진 금지).
      if (currentSeq >= target.sequenceNo) continue;

      await tx.journeyEvent.create({
        data: {
          id: randomUUID(),
          journeyId: journey.id,
          stageId: target.id,
          fromStageCode: journey.currentStageCode,
          toStageCode: target.code,
          notificationOutcome: 'NONE',
          actorId,
          changedAt,
        },
      });
      await tx.customerJourney.update({
        where: { id: journey.id },
        data: { currentStageCode: target.code, rowVersion: { increment: 1 } },
      });
    }
  }
}
