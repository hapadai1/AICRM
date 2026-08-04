import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { CANCELLED, ITEM_STATUS_FLOW } from './production-status';

/**
 * 준비 진행을 품목 상태에 반영한다 (2026-08-04 현업 확정).
 *
 * 준비는 옵션 확정과 채촌 연결로 판정된다. 전에는 그 결과가 품목 상태에 전혀 반영되지 않아
 * `옵션대기 · 채촌대기 · 발주가능` 세 상태를 아무도 찍지 않았고, 목록의 상태·진행률이
 * 준비 사실과 따로 놀았다(시드가 심어 둔 값만 보였다). 그래서 준비가 한 칸 나아갈 때마다
 * 여기서 품목 상태를 같이 올린다.
 *
 * 규칙:
 *  - 옵션 미확정            → 옵션대기(OPTION_PENDING)
 *  - 옵션 확정 · 채촌 미연결 → 채촌대기(MEASUREMENT_PENDING)  (렌탈은 채촌을 재지 않으므로 건너뛴다)
 *  - 옵션 확정 · 채촌 연결   → 발주가능(READY_TO_ORDER)
 *
 * 앞으로만 민다. 발주(PRODUCTION_REQUESTED) 이후 품목과 취소 품목은 건드리지 않는다 —
 * 공장이 이미 그 치수로 일을 시작한 뒤라 준비 상태로 되돌릴 일이 아니다.
 */
const READY = 'READY_TO_ORDER';
const PREP_LIMIT = ITEM_STATUS_FLOW.indexOf(READY);

const PREP_SELECT = Prisma.validator<Prisma.OrderItemSelect>()({
  id: true,
  status: true,
  order: { select: { transactionType: true } },
  sourceContractItem: {
    select: {
      optionSelectionSessions: {
        where: { isCurrent: true, status: 'CONFIRMED' },
        take: 1,
        select: { id: true },
      },
    },
  },
  measurementLinks: { where: { isCurrent: true }, take: 1, select: { id: true } },
});

type PrepItem = Prisma.OrderItemGetPayload<{ select: typeof PREP_SELECT }>;

/** 그 품목이 서 있어야 할 준비 상태 */
function prepStatusOf(item: PrepItem): string {
  const optionConfirmed = item.sourceContractItem.optionSelectionSessions.length > 0;
  if (!optionConfirmed) return 'OPTION_PENDING';
  if (item.order.transactionType === 'RENTAL' || item.measurementLinks.length > 0) return READY;
  return 'MEASUREMENT_PENDING';
}

/**
 * 주어진 품목들의 준비 상태를 다시 계산해 앞으로만 반영한다.
 * 옵션 확정·채촌 연결·계약완료 물리화처럼 준비가 움직이는 자리에서 부른다.
 */
export async function syncPrepStatuses(
  tx: Prisma.TransactionClient,
  orderItemIds: string[],
  actorId: string,
): Promise<void> {
  if (orderItemIds.length === 0) return;
  const items = await tx.orderItem.findMany({
    where: { id: { in: orderItemIds } },
    select: PREP_SELECT,
  });

  for (const item of items) {
    if (item.status === CANCELLED) continue;
    const current = ITEM_STATUS_FLOW.indexOf(item.status as (typeof ITEM_STATUS_FLOW)[number]);
    // 흐름 밖 상태(집계 전용 등)나 발주 이후는 준비가 손댈 자리가 아니다.
    if (current < 0 || current > PREP_LIMIT) continue;

    const target = prepStatusOf(item);
    const next = ITEM_STATUS_FLOW.indexOf(target as (typeof ITEM_STATUS_FLOW)[number]);
    if (next <= current) continue;

    await tx.orderItem.update({ where: { id: item.id }, data: { status: target } });
    // 상태가 왜 바뀌었는지는 제작 이력에서 읽는다 — 사람이 누른 것과 구분되게 사유를 적는다.
    await tx.productionEvent.create({
      data: {
        id: randomUUID(),
        orderItemId: item.id,
        componentId: null,
        eventType: target,
        previousStatus: item.status,
        newStatus: target,
        eventDate: new Date(new Date().toISOString().slice(0, 10)),
        notes: '준비 진행 자동 반영(옵션 확정·채촌 연결)',
        actorId,
      },
    });
  }
}

/** 계약 한 건의 살아있는 품목 id — 준비가 계약 단위로 움직일 때 쓴다. */
export async function orderItemIdsOfContract(
  tx: Prisma.TransactionClient,
  contractId: string,
): Promise<string[]> {
  const rows = await tx.orderItem.findMany({
    where: { order: { contractId }, status: { not: CANCELLED } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
