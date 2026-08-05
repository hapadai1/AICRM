import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

/**
 * 품목 상태의 **단일 기록자** (2026-08-05).
 *
 * `orderItem.status`를 직접 UPDATE 하지 않는다 — 상태 변경은 반드시 이 함수를 거쳐
 * 제작 이력(production_events)과 짝으로 남는다. 전에는 기록자가 네 곳
 * (담당자 이벤트·준비 자동 반영·구성품 집계·단계 취소)에 흩어져 있어, 상태만 바뀌고
 * 이력이 안 남거나 이력 모양이 제각각이 될 길이 열려 있었다.
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
