import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** 스냅샷에 덧붙일 식별 정보 (고객명·계약번호 등). 프론트가 이 키들로 대상 이름을 만든다. */
type Identity = Record<string, unknown>;
type Loader = (ids: string[]) => Promise<Array<readonly [string, Identity]>>;

type Snapshot = Record<string, unknown>;

/** 고객까지 거슬러 올라가는 공통 select — 주문 품목 → 주문 → 계약 → 고객 */
const ORDER_ITEM_IDENTITY_SELECT = {
  displayName: true,
  order: {
    select: {
      orderNo: true,
      contract: { select: { contractNo: true, customer: { select: { name: true } } } },
    },
  },
} as const;

function orderItemIdentity(item: {
  displayName: string;
  order: { orderNo: string; contract: { contractNo: string; customer: { name: string } } };
}): Identity {
  return {
    customerName: item.order.contract.customer.name,
    contractNo: item.order.contract.contractNo,
    orderNo: item.order.orderNo,
    displayName: item.displayName,
  };
}

/**
 * 옵션·렌탈 선택 세션은 주문이 아니라 계약 품목에 걸린다 —
 * 작성중 단계에서 옵션을 고르기 때문에 주문이 아직 없을 수 있다. 그래서 주문번호는 없다.
 */
const CONTRACT_ITEM_IDENTITY_SELECT = {
  displayName: true,
  contract: { select: { contractNo: true, customer: { select: { name: true } } } },
} as const;

function contractItemIdentity(item: {
  displayName: string;
  contract: { contractNo: string; customer: { name: string } };
}): Identity {
  return {
    customerName: item.contract.customer.name,
    contractNo: item.contract.contractNo,
    displayName: item.displayName,
  };
}

/**
 * 감사로그 조회 응답에 "무엇을 다룬 기록인가"를 채워 넣는다.
 *
 * 기록 시점에 이름을 함께 남기는 것이 원칙이지만(서비스 계층의 before/after), 상태 코드만 남긴
 * 로그가 많아 "렌탈 재고의 상태를 바꿨습니다"처럼 대상을 알 수 없는 줄이 쌓였다.
 * 조회 시점에 (1) 스냅샷 안의 UUID 필드와 (2) 로그의 entity_id 로 대상을 되짚어 이름을 붙인다.
 * 저장된 로그는 그대로 두고 응답만 보강하므로 예전 로그도 함께 읽히게 된다.
 * 이미 지워진 대상은 되짚을 수 없다 — 그래서 삭제 로그는 서비스 계층이 이름을 직접 남긴다.
 */
@Injectable()
export class AuditNamesService {
  constructor(private readonly prisma: PrismaService) {}

  /** 스냅샷 안의 UUID 필드 → 그 대상의 이름. 전/후 어느 쪽에 있든 같은 방식으로 채운다. */
  private readonly idSources: Array<{ idKey: string; load: Loader }> = [
    {
      idKey: 'optionSetId',
      load: (ids) =>
        this.prisma.optionSet
          .findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
          .then((rows) => rows.map((r) => [r.id, { optionSetName: r.name }] as const)),
    },
    {
      idKey: 'customerId',
      load: (ids) =>
        this.prisma.customer
          .findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
          .then((rows) => rows.map((r) => [r.id, { customerName: r.name }] as const)),
    },
    {
      idKey: 'contractId',
      load: (ids) =>
        this.prisma.contract
          .findMany({
            where: { id: { in: ids } },
            select: { id: true, contractNo: true, customer: { select: { name: true } } },
          })
          .then((rows) =>
            rows.map(
              (r) => [r.id, { contractNo: r.contractNo, customerName: r.customer.name }] as const,
            ),
          ),
    },
    {
      idKey: 'orderItemId',
      load: (ids) =>
        this.prisma.orderItem
          .findMany({ where: { id: { in: ids } }, select: { id: true, ...ORDER_ITEM_IDENTITY_SELECT } })
          .then((rows) => rows.map((r) => [r.id, orderItemIdentity(r)] as const)),
    },
    {
      idKey: 'rentalInventoryItemId',
      load: (ids) =>
        this.prisma.rentalInventoryItem
          .findMany({ where: { id: { in: ids } }, select: { id: true, managementCode: true } })
          .then((rows) => rows.map((r) => [r.id, { managementCode: r.managementCode }] as const)),
    },
    {
      idKey: 'templateId',
      load: (ids) =>
        this.prisma.notificationTemplate
          .findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
          .then((rows) => rows.map((r) => [r.id, { templateName: r.name }] as const)),
    },
    {
      idKey: 'targetUserId',
      load: (ids) =>
        this.prisma.user
          .findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } })
          .then((rows) => rows.map((r) => [r.id, { targetUserName: r.displayName }] as const)),
    },
  ];

  /** 로그의 entity_id(대상 자신) → 식별 정보. 스냅샷에 아무 단서가 없는 로그를 살린다. */
  private readonly entitySources: Record<string, Loader> = {
    CUSTOMER: (ids) =>
      this.prisma.customer
        .findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
        .then((rows) => rows.map((r) => [r.id, { customerName: r.name }] as const)),
    CONTRACT: (ids) =>
      this.prisma.contract
        .findMany({
          where: { id: { in: ids } },
          select: { id: true, contractNo: true, customer: { select: { name: true } } },
        })
        .then((rows) =>
          rows.map(
            (r) => [r.id, { contractNo: r.contractNo, customerName: r.customer.name }] as const,
          ),
        ),
    CONTRACT_VERSION: (ids) =>
      this.prisma.contractVersion
        .findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            versionNo: true,
            contract: { select: { contractNo: true, customer: { select: { name: true } } } },
          },
        })
        .then((rows) =>
          rows.map(
            (r) =>
              [
                r.id,
                {
                  contractNo: r.contract.contractNo,
                  customerName: r.contract.customer.name,
                  versionNo: r.versionNo,
                },
              ] as const,
          ),
        ),
    CONTRACT_TYPE: (ids) =>
      this.prisma.contractType
        .findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
        .then((rows) => rows.map((r) => [r.id, { name: r.name }] as const)),
    ORDER_ITEM: (ids) =>
      this.prisma.orderItem
        .findMany({ where: { id: { in: ids } }, select: { id: true, ...ORDER_ITEM_IDENTITY_SELECT } })
        .then((rows) => rows.map((r) => [r.id, orderItemIdentity(r)] as const)),
    ORDER_ITEM_COMPONENT: (ids) =>
      this.prisma.orderItemComponent
        .findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            componentType: true,
            orderItem: { select: ORDER_ITEM_IDENTITY_SELECT },
          },
        })
        .then((rows) =>
          rows.map(
            (r) =>
              [r.id, { ...orderItemIdentity(r.orderItem), componentType: r.componentType }] as const,
          ),
        ),
    OPTION_SELECTION_SESSION: (ids) =>
      this.prisma.optionSelectionSession
        .findMany({
          where: { id: { in: ids } },
          select: { id: true, contractItem: { select: CONTRACT_ITEM_IDENTITY_SELECT } },
        })
        .then((rows) => rows.map((r) => [r.id, contractItemIdentity(r.contractItem)] as const)),
    OPTION_SET_VERSION: (ids) =>
      this.prisma.optionSetVersion
        .findMany({
          where: { id: { in: ids } },
          select: { id: true, versionNo: true, optionSet: { select: { name: true } } },
        })
        .then((rows) =>
          rows.map(
            (r) => [r.id, { optionSetName: r.optionSet.name, versionNo: r.versionNo }] as const,
          ),
        ),
    MEASUREMENT_SESSION: (ids) =>
      this.prisma.measurementSession
        .findMany({
          where: { id: { in: ids } },
          select: { id: true, versionNo: true, customer: { select: { name: true } } },
        })
        .then((rows) =>
          rows.map((r) => [r.id, { customerName: r.customer.name, versionNo: r.versionNo }] as const),
        ),
    FITTING_SESSION: (ids) =>
      this.prisma.fittingSession
        .findMany({
          where: { id: { in: ids } },
          select: { id: true, orderItem: { select: ORDER_ITEM_IDENTITY_SELECT } },
        })
        .then((rows) => rows.map((r) => [r.id, orderItemIdentity(r.orderItem)] as const)),
    // 작업지시서는 품목당 하나다 — 버전 개념을 걷어냈다 (2026-08-05).
    WORK_ORDER: (ids) =>
      this.prisma.workOrder
        .findMany({
          where: { id: { in: ids } },
          select: { id: true, orderItem: { select: ORDER_ITEM_IDENTITY_SELECT } },
        })
        .then((rows) => rows.map((r) => [r.id, orderItemIdentity(r.orderItem)] as const)),
    RENTAL_SELECTION_SESSION: (ids) =>
      this.prisma.rentalSelectionSession
        .findMany({
          where: { id: { in: ids } },
          select: { id: true, contractItem: { select: CONTRACT_ITEM_IDENTITY_SELECT } },
        })
        .then((rows) => rows.map((r) => [r.id, contractItemIdentity(r.contractItem)] as const)),
    RENTAL_ALLOCATION: (ids) =>
      this.prisma.rentalAllocation
        .findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            rentalInventoryItem: { select: { managementCode: true } },
            orderItemComponent: {
              select: { componentType: true, orderItem: { select: ORDER_ITEM_IDENTITY_SELECT } },
            },
          },
        })
        .then((rows) =>
          rows.map(
            (r) =>
              [
                r.id,
                {
                  ...orderItemIdentity(r.orderItemComponent.orderItem),
                  componentType: r.orderItemComponent.componentType,
                  managementCode: r.rentalInventoryItem.managementCode,
                },
              ] as const,
          ),
        ),
    RENTAL_INVENTORY_ITEM: (ids) =>
      this.prisma.rentalInventoryItem
        .findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            managementCode: true,
            rentalSku: { select: { componentType: true, color: true, size: true } },
          },
        })
        .then((rows) =>
          rows.map(
            (r) =>
              [
                r.id,
                {
                  managementCode: r.managementCode,
                  componentType: r.rentalSku.componentType,
                  color: r.rentalSku.color,
                  size: r.rentalSku.size,
                },
              ] as const,
          ),
        ),
    REPAIR_REQUEST: (ids) =>
      this.prisma.repairRequest
        .findMany({
          where: { id: { in: ids } },
          select: { id: true, repairType: true, customer: { select: { name: true } } },
        })
        .then((rows) =>
          rows.map((r) => [r.id, { customerName: r.customer.name, repairType: r.repairType }] as const),
        ),
    CUSTOMER_JOURNEY: (ids) =>
      this.prisma.customerJourney
        .findMany({
          where: { id: { in: ids } },
          select: { id: true, trackType: true, customer: { select: { name: true } } },
        })
        .then((rows) =>
          rows.map((r) => [r.id, { customerName: r.customer.name, trackType: r.trackType }] as const),
        ),
    APPOINTMENT: (ids) =>
      this.prisma.appointment
        .findMany({
          where: { id: { in: ids } },
          select: { id: true, customer: { select: { name: true } } },
        })
        .then((rows) => rows.map((r) => [r.id, { customerName: r.customer.name }] as const)),
    CONSULTATION: (ids) =>
      this.prisma.consultation
        .findMany({
          where: { id: { in: ids } },
          select: { id: true, customer: { select: { name: true } } },
        })
        .then((rows) => rows.map((r) => [r.id, { customerName: r.customer.name }] as const)),
    JOURNEY_STAGE: (ids) =>
      this.prisma.journeyStage
        .findMany({ where: { id: { in: ids } }, select: { id: true, name: true, trackType: true } })
        .then((rows) => rows.map((r) => [r.id, { name: r.name, trackType: r.trackType }] as const)),
    USER: (ids) =>
      this.prisma.user
        .findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, loginId: true } })
        .then((rows) => rows.map((r) => [r.id, { name: r.displayName, loginId: r.loginId }] as const)),
    // ROLE_PERMISSION 로그의 entity_id 는 역할 id 다 (권한 매핑 자체에는 id가 없다).
    ROLE_PERMISSION: (ids) =>
      this.prisma.role
        .findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
        .then((rows) => rows.map((r) => [r.id, { name: r.name }] as const)),
    NOTIFICATION_TEMPLATE: (ids) =>
      this.prisma.notificationTemplate
        .findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
        .then((rows) => rows.map((r) => [r.id, { name: r.name }] as const)),
  };

  /** 로그 목록의 before/after JSON에 이름 필드를 채워 돌려준다. 조회 실패는 무시한다(로그는 그대로 보여준다). */
  async attach<T extends { entityType: string; entityId: string; beforeJson: unknown; afterJson: unknown }>(
    rows: T[],
  ): Promise<T[]> {
    if (rows.length === 0) return rows;
    await Promise.all([this.attachByEntityId(rows), this.attachByIdFields(rows)]);
    return rows;
  }

  /** (1) 대상 자신을 되짚어 채우기 — 전/후 양쪽에 같은 값으로 넣어 '변경된 항목'을 늘리지 않는다. */
  private async attachByEntityId<
    T extends { entityType: string; entityId: string; beforeJson: unknown; afterJson: unknown },
  >(rows: T[]): Promise<void> {
    const byType = new Map<string, T[]>();
    for (const row of rows) {
      if (!this.entitySources[row.entityType]) continue;
      const list = byType.get(row.entityType) ?? [];
      list.push(row);
      byType.set(row.entityType, list);
    }
    await Promise.all(
      Array.from(byType.entries()).map(async ([entityType, targets]) => {
        try {
          const ids = Array.from(new Set(targets.map((r) => r.entityId)));
          const identities = new Map(await this.entitySources[entityType](ids));
          for (const row of targets) {
            const identity = identities.get(row.entityId);
            if (!identity) continue;
            for (const snapshot of this.identityTargets(row)) {
              for (const [key, value] of Object.entries(identity)) {
                if (snapshot[key] === undefined) snapshot[key] = value;
              }
            }
          }
        } catch {
          // 이름 보강은 부가 정보다 — 실패해도 감사로그 조회 자체는 막지 않는다.
        }
      }),
    );
  }

  /** (2) 스냅샷 안의 UUID 필드로 채우기 — 값이 있는 쪽만 손댄다. */
  private async attachByIdFields<T extends { beforeJson: unknown; afterJson: unknown }>(
    rows: T[],
  ): Promise<void> {
    const snapshots = rows.flatMap((row) =>
      [asSnapshot(row.beforeJson), asSnapshot(row.afterJson)].filter(
        (s): s is Snapshot => s !== null,
      ),
    );
    if (snapshots.length === 0) return;
    await Promise.all(
      this.idSources.map(async (source) => {
        const targets = snapshots.filter((s) => typeof s[source.idKey] === 'string');
        const ids = Array.from(new Set(targets.map((s) => s[source.idKey] as string)));
        if (ids.length === 0) return;
        try {
          const identities = new Map(await source.load(ids));
          for (const snapshot of targets) {
            const identity = identities.get(snapshot[source.idKey] as string);
            if (!identity) continue;
            for (const [key, value] of Object.entries(identity)) {
              if (snapshot[key] === undefined) snapshot[key] = value;
            }
          }
        } catch {
          // 위와 같다 — 보강 실패는 조용히 넘긴다.
        }
      }),
    );
  }

  /**
   * 식별 정보를 넣을 스냅샷들.
   * - 한쪽만 있는 로그(생성·삭제)는 그쪽에만 — 없는 쪽을 만들면 삭제가 '수정'으로 읽힌다.
   * - 양쪽 다 비어 있는 로그(재인증 등)는 양쪽에 만들어 대상이라도 보이게 한다.
   */
  private identityTargets(row: { beforeJson: unknown; afterJson: unknown }): Snapshot[] {
    const before = asSnapshot(row.beforeJson);
    const after = asSnapshot(row.afterJson);
    if (before || after) return [before, after].filter((s): s is Snapshot => s !== null);
    const created: Snapshot[] = [{}, {}];
    row.beforeJson = created[0];
    row.afterJson = created[1];
    return created;
  }
}

function asSnapshot(value: unknown): Snapshot | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Snapshot) : null;
}
