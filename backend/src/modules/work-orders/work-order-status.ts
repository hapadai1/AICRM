import { Prisma } from '@prisma/client';
import { WorkOrderListStatus } from './work-orders.dto';

/**
 * 작업지시서 상태 계산에 필요한 OrderItem 서브셀렉트.
 * 옵션 확정 시각·현재 채촌 연결 시각·최신 출력 버전만 뽑는다(Excel용 값은 미포함).
 * work-orders 목록과 production 목록이 같은 판정을 공유하기 위한 단일 출처.
 */
export const workOrderStatusSelect = Prisma.validator<Prisma.OrderItemSelect>()({
  // 옵션 세션은 이제 ContractItem에 붙는다 → 확정 후 되짚기(REACH-BACK): sourceContractItem 경유.
  sourceContractItem: {
    select: {
      optionSelectionSessions: {
        where: { isCurrent: true, status: 'CONFIRMED' },
        orderBy: { selectionVersionNo: Prisma.SortOrder.desc },
        take: 1,
        select: { confirmedAt: true },
      },
    },
  },
  measurementLinks: {
    where: { isCurrent: true },
    orderBy: { linkedAt: Prisma.SortOrder.desc },
    take: 1,
    select: { linkedAt: true },
  },
  workOrder: {
    select: {
      id: true,
      // 파일명까지 뽑는 이유: 목록에서 미리보기 화면을 거치지 않고 최신 Excel을 바로 내려받는다.
      currentVersion: {
        select: {
          id: true,
          versionNo: true,
          issuedAt: true,
          outputFile: { select: { originalName: true } },
        },
      },
    },
  },
});

type OrderItemWithWorkOrderStatus = Prisma.OrderItemGetPayload<{
  select: typeof workOrderStatusSelect;
}>;

/**
 * 미주문·재출력 필요 판정 (통합설계서 §10.4, 데이터모델 §10.5).
 * 별도 업무 테이블 없이 조회 시점에 계산한다.
 */
export function resolveWorkOrderStatus(
  session: { confirmedAt: Date | null } | null,
  link: { linkedAt: Date } | null,
  currentVersion: { issuedAt: Date } | null,
): WorkOrderListStatus | 'WAITING' {
  if (!currentVersion) {
    return session && link ? 'UNORDERED' : 'WAITING';
  }
  const changedAfterIssue = [session?.confirmedAt, link?.linkedAt].some(
    (t) => t != null && t.getTime() > currentVersion.issuedAt.getTime(),
  );
  return changedAfterIssue ? 'REPRINT_NEEDED' : 'CURRENT';
}

/** 작업지시서 뷰 서브객체 (제작 목록·코크핏에서 한 행에 얹어 표시) */
export interface WorkOrderView {
  workOrderId: string | null;
  status: WorkOrderListStatus | 'WAITING';
  currentVersionNo: number | null;
  /** 최신 출력본 버전 id — 목록에서 바로 내려받을 때 쓴다 */
  currentVersionId: string | null;
  /** 최신 출력본 파일명 */
  currentFileName: string | null;
  /** ISO. 화면에서 표시 형식으로 정규화 */
  lastIssuedAt: string | null;
  /** 출력 가능 여부 (준비 미완이면 false) */
  canIssue: boolean;
}

/** 위 workOrderStatusSelect를 포함한 OrderItem에서 작업지시서 뷰를 만든다 */
export function buildWorkOrderView(item: OrderItemWithWorkOrderStatus): WorkOrderView {
  const session = item.sourceContractItem.optionSelectionSessions[0] ?? null;
  const link = item.measurementLinks[0] ?? null;
  const currentVersion = item.workOrder?.currentVersion ?? null;
  const status = resolveWorkOrderStatus(session, link, currentVersion);
  return {
    workOrderId: item.workOrder?.id ?? null,
    status,
    currentVersionNo: currentVersion?.versionNo ?? null,
    currentVersionId: currentVersion?.id ?? null,
    currentFileName: currentVersion?.outputFile?.originalName ?? null,
    lastIssuedAt: currentVersion?.issuedAt.toISOString() ?? null,
    canIssue: status !== 'WAITING',
  };
}
