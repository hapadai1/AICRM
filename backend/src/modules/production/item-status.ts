import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

/**
 * 품목·구성품 상태의 **단일 기록자** (2026-08-05).
 *
 * `orderItem.status`·`orderItemComponent.status`를 직접 UPDATE 하지 않는다 —
 * 상태 변경은 반드시 이 함수들을 거쳐 제작 이력(production_events)과 짝으로 남는다.
 * 전에는 기록자가 품목 네 곳·구성품 다섯 곳에 흩어져 있어, 상태만 바뀌고
 * 이력이 안 남거나(계약 변경 경로) 이력 모양이 제각각이 될 길이 열려 있었다.
 *
 * 전이 검증(validateTransition)·감사로그는 **호출부 책임**이다 — 검증 규칙과 감사 사유가
 * 호출 맥락(사람이 눌렀나, 집계인가, 취소 정정인가)마다 다르기 때문이다.
 */
export async function applyItemStatus(
  tx: Prisma.TransactionClient,
  args: {
    orderItemId: string;
    /** 현재 상태 — 같으면 아무것도 하지 않는다. */
    from: string;
    to: string;
    eventDate: Date;
    actorId: string;
    /** 제작 이력의 이벤트 타입. 기본은 도착 상태 코드(집계는 ITEM_STATUS_AGGREGATED로 구분). */
    eventType?: string;
    expectedDate?: Date;
    notes?: string;
    /** CANCELLED 진입 시 함께 남길 취소 정보 (그 외에는 무시). */
    cancelled?: { reason?: string };
  },
): Promise<{ eventId: string } | null> {
  if (args.from === args.to) return null;
  await tx.orderItem.update({
    where: { id: args.orderItemId },
    data: {
      status: args.to,
      ...(args.to === 'CANCELLED' && args.cancelled
        ? { cancelledReason: args.cancelled.reason ?? null, cancelledAt: new Date() }
        : {}),
    },
  });
  const eventId = randomUUID();
  await tx.productionEvent.create({
    data: {
      id: eventId,
      orderItemId: args.orderItemId,
      componentId: null,
      eventType: args.eventType ?? args.to,
      previousStatus: args.from,
      newStatus: args.to,
      eventDate: args.eventDate,
      expectedDate: args.expectedDate,
      notes: args.notes,
      actorId: args.actorId,
    },
  });
  return { eventId };
}

/**
 * 구성품 상태 기록 — 상태 갱신과 제작 이력 생성을 한 쌍으로 처리한다.
 * 입출고 일자 같은 실물 기록을 함께 갱신하려면 data로 넘긴다.
 */
export async function applyComponentStatus(
  tx: Prisma.TransactionClient,
  args: {
    componentId: string;
    orderItemId: string;
    /** 현재 상태 — 같고 data도 없으면 아무것도 하지 않는다. */
    from: string;
    to: string;
    eventDate: Date;
    actorId: string;
    /** 제작 이력의 이벤트 타입. 기본은 도착 상태 코드. */
    eventType?: string;
    expectedDate?: Date;
    notes?: string;
    /** 상태와 함께 갱신할 실물 기록 (actualInboundAt 등). */
    data?: Prisma.OrderItemComponentUncheckedUpdateInput;
  },
): Promise<{ eventId: string } | null> {
  if (args.from === args.to && !args.data) return null;
  await tx.orderItemComponent.update({
    where: { id: args.componentId },
    data: { status: args.to, ...(args.data ?? {}) },
  });
  const eventId = randomUUID();
  await tx.productionEvent.create({
    data: {
      id: eventId,
      orderItemId: args.orderItemId,
      componentId: args.componentId,
      eventType: args.eventType ?? args.to,
      previousStatus: args.from,
      newStatus: args.to,
      eventDate: args.eventDate,
      expectedDate: args.expectedDate,
      notes: args.notes,
      actorId: args.actorId,
    },
  });
  return { eventId };
}
