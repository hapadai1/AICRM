import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { syncPrepStatuses } from '../production/prep-status';
import { isBeforeProductionRequest } from '../production/production-status';

/**
 * 품목에 쓸 채촌 자동 연결 (현업 확정 2026-08-05).
 *
 * 채촌은 계약·주문과 따로 도는 독립 축이다. 둘이 만나는 자리는 두 곳뿐이라, 그 두 곳에서만
 * 붙인다 — **계약완료**(주문품목이 생기는 시점)와 **채촌 저장**(없던 채촌이 생기는 시점).
 * 담당자가 품목마다 채촌을 고르는 일은 실무에 없다.
 *
 * 고르는 규칙은 하나다: **스타일 컨설팅(INITIAL) 구분의, 값이 든 가장 최근 채촌**.
 * - 구분을 가리는 이유: 가봉·수선 채촌은 그 옷을 고치려고 잰 것이라 새 옷의 기준이 아니다.
 * - 값을 보는 이유: 채촌의 '완료' 표시를 걷어냈으므로, 방금 열어 둔 빈 채촌이 최신일 수 있다.
 *
 * 건드리지 않는 품목:
 * - 렌탈 — 우리 재고를 고쳐 내주는 것이라 치수를 새로 재지 않는다.
 * - 이미 채촌이 붙은 품목 — 출력했거나 담당자가 직접 고른 것이 기준이다.
 * - 발주 이후 품목 — 공장이 이미 그 치수로 일을 시작했다.
 */
export async function autoLinkMeasurements(
  tx: Prisma.TransactionClient,
  customerId: string,
  actorId: string,
  opts: {
    /** 이 채촌으로 붙인다. 없으면 규칙대로 고른다(계약완료 경로). */
    sessionId?: string;
    /** 이 주문 안에서만 붙인다. */
    orderId?: string;
  } = {},
): Promise<{ sessionId: string; orderItemIds: string[] } | null> {
  const sessionId = opts.sessionId ?? (await pickMeasurementSession(tx, customerId));
  if (!sessionId) return null;
  // 지목한 채촌이라도 값이 없으면 붙이지 않는다. 규칙대로 고른 채촌(pickMeasurementSession)은
  // 이미 값 유무로 걸러지지만, 저장 경로가 넘겨 준 sessionId는 방금 만든 빈 채촌일 수 있다.
  // 빈 채촌이 붙으면 목록은 링크만 보고 '채촌 완료'로, 발주 화면은 값이 없어 '미완료'로 갈려
  // 준비완료인데 발주가 막힌다(현업 확정 2026-08-05: 값이 든 채촌만 기준).
  if (opts.sessionId) {
    const valueCount = await tx.measurementValue.count({
      where: { measurementSessionId: opts.sessionId },
    });
    if (valueCount === 0) return null;
  }

  const candidates = await tx.orderItem.findMany({
    where: {
      order: {
        ...(opts.orderId ? { id: opts.orderId } : {}),
        transactionType: { not: 'RENTAL' },
        contract: { customerId, status: 'COMPLETED' },
      },
      measurementLinks: { none: { isCurrent: true } },
    },
    select: { id: true, status: true },
  });
  const targets = candidates.filter((i) => isBeforeProductionRequest(i.status));
  if (targets.length === 0) return null;

  for (const item of targets) {
    await tx.orderItemMeasurement.create({
      data: {
        id: randomUUID(),
        orderItemId: item.id,
        measurementSessionId: sessionId,
        isCurrent: true,
        linkedBy: actorId,
      },
    });
  }
  // 채촌이 붙으면 준비가 끝난다 — 품목 상태에 반영해야 제작 목록에 나타난다.
  await syncPrepStatuses(
    tx,
    targets.map((t) => t.id),
    actorId,
  );
  return { sessionId, orderItemIds: targets.map((t) => t.id) };
}

/** 그 고객이 지금 쓸 채촌 — 없으면 null(붙일 것이 없다). */
async function pickMeasurementSession(
  tx: Prisma.TransactionClient,
  customerId: string,
): Promise<string | null> {
  const latest = await tx.measurementSession.findFirst({
    where: { customerId, measurementType: 'INITIAL', values: { some: {} } },
    orderBy: [{ measurementDate: 'desc' }, { versionNo: 'desc' }],
    select: { id: true },
  });
  return latest?.id ?? null;
}
