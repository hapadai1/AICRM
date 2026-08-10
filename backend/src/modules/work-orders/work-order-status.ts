import { Prisma } from '@prisma/client';
import { ITEM_STATUS_FLOW } from '../production/production-status';
import { WorkOrderListStatus } from './work-orders.dto';

/**
 * 스타일 컨설팅 확정 세션 서브셀렉트 — 맞춤은 옵션 세션, 렌탈은 렌탈 선택 세션이다.
 * 준비 판정(prep-status)과 작업지시서 판정이 **같은 정의**를 쓴다. 렌탈 선택 세션을
 * 한쪽만 읽던 동안 렌탈 품목이 준비 미완으로 남는 버그가 있었다(2026-08-04).
 */
export const consultingSessionSelect = Prisma.validator<Prisma.ContractItemSelect>()({
  optionSelectionSessions: {
    where: { isCurrent: true, status: 'CONFIRMED' },
    orderBy: { selectionVersionNo: Prisma.SortOrder.desc },
    take: 1,
    select: { confirmedAt: true },
  },
  rentalSelectionSessions: {
    where: { isCurrent: true, status: 'CONFIRMED' },
    orderBy: { selectionVersionNo: Prisma.SortOrder.desc },
    take: 1,
    select: { confirmedAt: true },
  },
});

/** 그 품목의 확정된 컨설팅 세션 — 맞춤·렌탈 어느 쪽이든 하나만 있다. 없으면 null. */
export function pickConsultingSession<T>(sourceContractItem: {
  optionSelectionSessions: T[];
  rentalSelectionSessions: T[];
}): T | null {
  return (
    sourceContractItem.optionSelectionSessions[0] ??
    sourceContractItem.rentalSelectionSessions[0] ??
    null
  );
}

/**
 * 작업지시서 상태 계산에 필요한 OrderItem 서브셀렉트.
 * 옵션 확정 시각·현재 채촌 연결 시각·최신 출력 버전만 뽑는다(Excel용 값은 미포함).
 * work-orders 목록과 production 목록이 같은 판정을 공유하기 위한 단일 출처.
 */
export const workOrderStatusSelect = Prisma.validator<Prisma.OrderItemSelect>()({
  // 옵션 세션은 이제 ContractItem에 붙는다 → 확정 후 되짚기(REACH-BACK): sourceContractItem 경유.
  sourceContractItem: { select: consultingSessionSelect },
  measurementLinks: {
    where: { isCurrent: true },
    orderBy: { linkedAt: Prisma.SortOrder.desc },
    take: 1,
    select: { linkedAt: true },
  },
  workOrder: {
    select: {
      id: true,
      status: true,
      issuedAt: true,
      // 파일명까지 뽑는 이유: 목록에서 화면을 거치지 않고 Excel을 바로 내려받는다.
      outputFile: { select: { originalName: true } },
      // 수기 최종본이 있으면 그것이 최종이다 — 목록·창에 그 사실이 보여야 한다 (2026-08-05).
      uploadedFile: { select: { originalName: true } },
    },
  },
});

type OrderItemWithWorkOrderStatus = Prisma.OrderItemGetPayload<{
  select: typeof workOrderStatusSelect;
}>;

/**
 * 미주문 판정 (통합설계서 §10.4). 별도 업무 테이블 없이 조회 시점에 계산한다.
 *
 * `재출력 필요`는 없앴다 (현업 확정 2026-08-05). v1 설계에서 온 자동 판정이었는데,
 * 출력은 발주와 같은 시점이고 **발주하면 옵션·채촌이 모두 잠기므로** 출력 뒤에 근거가
 * 바뀔 길이 자체가 없다 — 뜰 수 없는 상태를 화면과 대시보드가 계속 이고 있었다.
 */
export function resolveWorkOrderStatus(
  session: { confirmedAt: Date | null } | null,
  link: { linkedAt: Date } | null,
  issued: boolean,
): WorkOrderListStatus | 'WAITING' {
  if (!issued) {
    return session && link ? 'UNORDERED' : 'WAITING';
  }
  return 'CURRENT';
}

/**
 * 채촌을 바꿀 수 있는 단계인지 (현업 확정 2026-08-03).
 * 작업요청(PRODUCTION_REQUESTED)부터는 공장이 이미 그 치수로 일을 시작한 뒤라 확정으로 본다.
 */
export function canChangeWorkOrderMeasurement(itemStatus: string): boolean {
  const frozenFrom = ITEM_STATUS_FLOW.indexOf('PRODUCTION_REQUESTED');
  const current = ITEM_STATUS_FLOW.indexOf(itemStatus as (typeof ITEM_STATUS_FLOW)[number]);
  // 흐름에 없는 상태(CANCELLED 등)는 바꿀 일이 없다.
  if (current < 0) return false;
  return current < frozenFrom;
}

/** 작업지시서 뷰 서브객체 (제작 목록·코크핏에서 한 행에 얹어 표시) */
export interface WorkOrderView {
  workOrderId: string | null;
  status: WorkOrderListStatus | 'WAITING';
  /** 작성중 | 완료 — 발주가 완료로 만든다 (2026-08-05) */
  docStatus: string;
  /** 작업지시서 id — 파일을 내려받을 때 쓴다. 아직 뽑지 않았으면 null */
  workOrderFileKey: string | null;
  /** 최신 출력본 파일명. 수기 최종본이 올라와 있으면 그 이름이다(다운로드도 그 파일이 나간다). */
  currentFileName: string | null;
  /** 수기 최종본 파일명 — 없으면 null. 시스템 출력본만 있다는 뜻이다. */
  uploadedFileName: string | null;
  /** ISO. 화면에서 표시 형식으로 정규화 */
  lastIssuedAt: string | null;
  /** 출력 가능 여부 (준비 미완이면 false) */
  canIssue: boolean;
  /**
   * 준비가 언제 끝났는지 — 제작 관리의 `준비` 단계가 이 두 날짜를 그대로 보여준다.
   * 판정(canIssue)에 이미 쓰던 값이라 새로 계산하지 않는다.
   */
  optionConfirmedAt: string | null;
  measurementLinkedAt: string | null;
}

/** 위 workOrderStatusSelect를 포함한 OrderItem에서 작업지시서 뷰를 만든다 */
export function buildWorkOrderView(item: OrderItemWithWorkOrderStatus): WorkOrderView {
  // 컨설팅 확정 시각 — 맞춤은 옵션 세션, 렌탈은 렌탈 선택 세션에서 온다(둘 다 '스타일 컨설팅'이다).
  const session = pickConsultingSession(item.sourceContractItem);
  const link = item.measurementLinks[0] ?? null;
  const wo = item.workOrder ?? null;
  const status = resolveWorkOrderStatus(session, link, !!wo?.outputFile);
  return {
    workOrderId: wo?.id ?? null,
    status,
    docStatus: wo?.status ?? 'DRAFT',
    workOrderFileKey: wo?.outputFile ? (wo.id ?? null) : null,
    currentFileName: wo?.uploadedFile?.originalName ?? wo?.outputFile?.originalName ?? null,
    uploadedFileName: wo?.uploadedFile?.originalName ?? null,
    lastIssuedAt: wo?.issuedAt?.toISOString() ?? null,
    canIssue: status !== 'WAITING',
    optionConfirmedAt: session?.confirmedAt?.toISOString() ?? null,
    measurementLinkedAt: link?.linkedAt.toISOString() ?? null,
  };
}
