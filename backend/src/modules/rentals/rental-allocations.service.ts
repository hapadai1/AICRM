import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RentalPolicyService } from './rental-policy.service';
import {
  ACTIVE_ALLOCATION_STATUSES,
  ALLOCATION_EVENT_TYPES,
  ASSIGNABLE_ITEM_STATUSES,
  addDaysToDateOnly,
  isRentalOverlapDbError,
  parseDateOnly,
  toDateOnlyString,
} from './rentals.constants';
import {
  AllocationListQueryDto,
  ChangeItemDto,
  CheckoutDto,
  CreateAllocationDto,
  RentalOrderComponentsQueryDto,
  ReturnDto,
} from './rentals.dto';

const ALLOCATION_INCLUDE = {
  rentalInventoryItem: { include: { rentalSku: true } },
  orderItemComponent: {
    select: {
      id: true,
      componentType: true,
      orderItem: { select: { id: true, displayName: true, orderId: true } },
    },
  },
} as const;

/** 출고·반납 뷰용: 배정 + 실물(SKU) + 구성품 → 품목 → 주문 → 고객 */
const ALLOCATION_VIEW_INCLUDE = {
  rentalInventoryItem: { include: { rentalSku: true } },
  orderItemComponent: {
    select: {
      id: true,
      componentType: true,
      sequenceNo: true,
      orderItem: {
        select: {
          id: true,
          displayName: true,
          order: {
            select: {
              id: true,
              orderNo: true,
              contract: {
                select: {
                  contractNo: true,
                  customer: { select: { id: true, name: true, phone: true } },
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.RentalAllocationInclude;

type AllocationViewRow = Prisma.RentalAllocationGetPayload<{ include: typeof ALLOCATION_VIEW_INCLUDE }>;

@Injectable()
export class RentalAllocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly policy: RentalPolicyService,
  ) {}

  // ---------------------------------------------------------------------------
  // 출고·반납 대상 목록 (RENT-004)
  // ---------------------------------------------------------------------------

  /**
   * 출고·반납 화면 목록 뷰 (연동정합화 계약 §5):
   * - pickup: RESERVED & pickupDate <= date (기본 오늘)
   * - return: CHECKED_OUT 전체 — 반납예정일 경과(지연) 건 포함, overdue 플래그 제공
   */
  async list(query: AllocationListQueryDto) {
    const date = parseDateOnly(query.date ?? toDateOnlyString(new Date()));
    const q = query.q?.trim();

    // 특정 건(주문번호·고객명·실물코드)으로 들어오면 날짜 무관하게 매칭 배정을 반환한다.
    // (진행단계 카드에서 "이 주문을 처리하러 왔다"는 의도 — 오늘의 일일운영 목록이 아님)
    const keywordFilter: Prisma.RentalAllocationWhereInput | undefined = q
      ? {
          OR: [
            { orderItemComponent: { orderItem: { order: { orderNo: { contains: q, mode: 'insensitive' } } } } },
            {
              orderItemComponent: {
                orderItem: { order: { contract: { customer: { name: { contains: q, mode: 'insensitive' } } } } },
              },
            },
            { rentalInventoryItem: { managementCode: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : undefined;

    const pickupWhere: Prisma.RentalAllocationWhereInput = {
      status: 'RESERVED',
      // q가 있으면 미래 픽업일도 포함(제한 해제), 없으면 기존 "오늘 이하" 일일운영 뷰 유지.
      ...(q ? {} : { pickupDate: { lte: date } }),
    };

    const where: Prisma.RentalAllocationWhereInput = {
      ...(query.view === 'pickup' ? pickupWhere : { status: 'CHECKED_OUT' }),
      ...(keywordFilter ? { AND: [keywordFilter] } : {}),
    };

    const rows = await this.prisma.rentalAllocation.findMany({
      where,
      include: ALLOCATION_VIEW_INCLUDE,
      orderBy:
        query.view === 'pickup'
          ? [{ pickupDate: 'asc' }, { createdAt: 'asc' }]
          : [{ returnDueDate: 'asc' }, { createdAt: 'asc' }],
    });

    // 반납 뷰에만 정비 소요일을 실어 준다 — 화면이 대여 가능 예정일을 스스로 계산하지 않고
    // 서버가 준 값을 그대로 채우게 하려는 것이다(예전에는 화면이 "오늘+2일"을 박아 뒀다).
    const cleaningDays =
      query.view === 'return'
        ? await this.policy.cleaningDaysByColor(rows.map((r) => r.rentalInventoryItem.rentalSku.color))
        : null;
    return rows.map((row) => this.toAllocationView(row, date, cleaningDays));
  }

  // ---------------------------------------------------------------------------
  // 배정 대상 렌탈 구성품 목록 (RENT-003)
  // ---------------------------------------------------------------------------

  /**
   * 렌탈 주문 구성품 + 현재 배정 정보 목록 (연동정합화 계약 §5).
   * orderId가 없으면 활성(취소 아님) 렌탈 주문 전체를 대상으로 한다.
   */
  async orderComponents(query: RentalOrderComponentsQueryDto) {
    if (query.orderId) {
      const order = await this.prisma.order.findUnique({ where: { id: query.orderId } });
      if (!order) throw new NotFoundException('주문이 없습니다.');
      if (order.transactionType !== 'RENTAL')
        throw new BusinessException('VALIDATION_ERROR', '렌탈 주문이 아닙니다.', [
          { field: 'orderId', reason: 'NOT_RENTAL_ORDER' },
        ]);
    }

    const components = await this.prisma.orderItemComponent.findMany({
      where: {
        active: true,
        orderItem: {
          status: { not: 'CANCELLED' },
          order: {
            transactionType: 'RENTAL',
            status: { not: 'CANCELLED' },
            ...(query.orderId ? { id: query.orderId } : {}),
          },
        },
      },
      select: {
        id: true,
        componentType: true,
        sequenceNo: true,
        status: true,
        orderItem: {
          select: {
            id: true,
            displayName: true,
            productCategory: true,
            order: {
              select: {
                id: true,
                orderNo: true,
                contract: { select: { customer: { select: { id: true, name: true, phone: true } } } },
              },
            },
          },
        },
        rentalAllocations: {
          where: { status: { in: ACTIVE_ALLOCATION_STATUSES } },
          orderBy: { pickupDate: 'asc' },
          select: {
            id: true,
            status: true,
            pickupDate: true,
            returnDueDate: true,
            availabilityEndDate: true,
            rowVersion: true,
            rentalInventoryItem: { select: { id: true, managementCode: true } },
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { sequenceNo: 'asc' }],
    });

    return components.map((component) => {
      const current = component.rentalAllocations[0] ?? null;
      return {
        componentId: component.id,
        componentType: component.componentType,
        sequenceNo: component.sequenceNo,
        status: component.status,
        orderItemId: component.orderItem.id,
        displayName: component.orderItem.displayName,
        productCategory: component.orderItem.productCategory,
        orderId: component.orderItem.order.id,
        orderNo: component.orderItem.order.orderNo,
        customerId: component.orderItem.order.contract.customer.id,
        customerName: component.orderItem.order.contract.customer.name,
        currentAllocation: current
          ? {
              id: current.id,
              status: current.status,
              pickupDate: toDateOnlyString(current.pickupDate),
              returnDueDate: toDateOnlyString(current.returnDueDate),
              availabilityEndDate: toDateOnlyString(current.availabilityEndDate),
              inventoryItemId: current.rentalInventoryItem.id,
              managementCode: current.rentalInventoryItem.managementCode,
              version: current.rowVersion,
            }
          : null,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 배정 생성 (RENT-003)
  // ---------------------------------------------------------------------------

  /**
   * 실물 ID 기간 배정. 트랜잭션 안에서 가용 재검증 → 배정 생성 → 실물 RESERVED →
   * ASSIGNED 이벤트를 처리하고, DB EXCLUDE 제약 위반은 RENTAL_PERIOD_OVERLAP으로 변환한다.
   * 실물 지정은 inventoryItemId 또는 itemCode(관리코드) 둘 중 하나로 받는다.
   */
  async allocate(orderId: string, dto: CreateAllocationDto, actor: AuthUser) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('주문이 없습니다.');
    if (order.transactionType !== 'RENTAL')
      throw new BusinessException('VALIDATION_ERROR', '렌탈 주문이 아닙니다.', [
        { field: 'orderId', reason: 'NOT_RENTAL_ORDER' },
      ]);

    const component = await this.prisma.orderItemComponent.findUnique({
      where: { id: dto.componentId },
      include: { orderItem: { select: { orderId: true } } },
    });
    if (!component || component.orderItem.orderId !== orderId)
      throw new NotFoundException('해당 주문의 구성품이 아닙니다.');
    if (!component.active)
      throw new BusinessException('VALIDATION_ERROR', '비활성 구성품에는 배정할 수 없습니다.', [
        { field: 'componentId', reason: 'INACTIVE' },
      ]);

    const pickup = parseDateOnly(dto.pickupDate);
    const returnDue = parseDateOnly(dto.returnDueDate);
    // 가용 종료일을 따로 받지 않으면 반납 예정일까지만 묶는다.
    const end = parseDateOnly(dto.availabilityEndDate ?? dto.returnDueDate);
    if (returnDue < pickup || end < returnDue)
      throw new BusinessException(
        'VALIDATION_ERROR',
        '기간이 올바르지 않습니다. 픽업일 <= 반납예정일 <= 가용종료일이어야 합니다.',
        [{ field: 'availabilityEndDate', reason: 'INVALID_PERIOD' }],
      );

    // 개체를 지정했으면 그것을, 컬러·사이즈만 왔으면 그 기간에 비어 있는 실물 하나를 고른다.
    const inventoryItemId =
      dto.inventoryItemId || dto.itemCode
        ? await this.resolveInventoryItemId(dto.inventoryItemId, dto.itemCode, 'inventoryItemId')
        : await this.pickAssignableItem(component.componentType, dto.color, dto.size, pickup, end);

    const allocationId = randomUUID();
    const allocation = await this.runOverlapGuarded(async (tx) => {
      // 트랜잭션 내 가용 재검증 (최종 방어선은 DB EXCLUDE 제약)
      await this.assertItemAssignable(tx, inventoryItemId, pickup, end, {
        componentType: component.componentType,
      });
      const created = await tx.rentalAllocation.create({
        data: {
          id: allocationId,
          orderItemComponentId: component.id,
          rentalInventoryItemId: inventoryItemId,
          pickupDate: pickup,
          returnDueDate: returnDue,
          availabilityEndDate: end,
          status: 'RESERVED',
          assignedBy: actor.id,
          assignedAt: new Date(),
        },
        include: ALLOCATION_INCLUDE,
      });
      await this.changeItemStatus(tx, inventoryItemId, 'RESERVED', actor, `렌탈 배정 (${allocationId})`);
      await tx.rentalAllocationEvent.create({
        data: {
          id: randomUUID(),
          rentalAllocationId: allocationId,
          eventType: ALLOCATION_EVENT_TYPES.ASSIGNED,
          newInventoryItemId: inventoryItemId,
          actorId: actor.id,
        },
      });
      return created;
    });

    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'RENTAL_ALLOCATION',
      entityId: allocation.id,
      // DB 행을 통째로 남기면 UUID만 잔뜩 남는다 — 읽을 수 있는 항목만 고른다.
      after: {
        ...(await this.allocationIdentity(allocation.id)),
        pickupDate: dto.pickupDate,
        returnDueDate: dto.returnDueDate,
        availabilityEndDate: dto.availabilityEndDate,
        status: allocation.status,
      },
    });
    return allocation;
  }

  // ---------------------------------------------------------------------------
  // 실물 ID 변경 (RENT-003/004)
  // ---------------------------------------------------------------------------

  /**
   * 단일 트랜잭션: 신규 실물 가용 검증 + 배정 교체 + 구실물 AVAILABLE 복원 +
   * 신실물 RESERVED + ITEM_CHANGED 이벤트(old/new/사유).
   */
  async changeItem(id: string, dto: ChangeItemDto, actor: AuthUser) {
    const allocation = await this.prisma.rentalAllocation.findUnique({
      where: { id },
      include: {
        rentalInventoryItem: { include: { rentalSku: true } },
        orderItemComponent: { select: { componentType: true } },
      },
    });
    if (!allocation) throw new NotFoundException('렌탈 배정이 없습니다.');
    if (allocation.status !== 'RESERVED')
      throw new BusinessException('INVALID_STATUS_TRANSITION', '출고 전 배정만 실물을 변경할 수 있습니다.', undefined, {
        allocationStatus: allocation.status,
      });
    this.assertVersion(dto.version, allocation.rowVersion);
    if (dto.newInventoryItemId === allocation.rentalInventoryItemId)
      throw new BusinessException('VALIDATION_ERROR', '현재 배정된 실물과 동일합니다.', [
        { field: 'newInventoryItemId', reason: 'SAME_ITEM' },
      ]);

    const oldItemId = allocation.rentalInventoryItemId;
    // 지정이 없으면 같은 규격에서 비어 있는 다른 실물을 서버가 고른다.
    const sku = allocation.rentalInventoryItem.rentalSku;
    const newItemId =
      dto.newInventoryItemId ??
      (await this.pickAssignableItem(
        sku.componentType,
        sku.color,
        sku.size,
        allocation.pickupDate,
        allocation.availabilityEndDate,
        oldItemId,
      ));

    const updated = await this.runOverlapGuarded(async (tx) => {
      await this.assertItemAssignable(tx, newItemId, allocation.pickupDate, allocation.availabilityEndDate, {
        componentType: allocation.orderItemComponent.componentType,
        excludeAllocationId: id,
      });

      const after = await tx.rentalAllocation.update({
        where: { id },
        data: { rentalInventoryItemId: newItemId, rowVersion: { increment: 1 } },
        include: ALLOCATION_INCLUDE,
      });

      // 구실물 상태 복원: 다른 살아있는 배정이 없으면 AVAILABLE
      const remaining = await tx.rentalAllocation.count({
        where: { rentalInventoryItemId: oldItemId, id: { not: id }, status: { in: ACTIVE_ALLOCATION_STATUSES } },
      });
      if (remaining === 0) {
        await this.changeItemStatus(tx, oldItemId, 'AVAILABLE', actor, `배정 실물 변경 해제 (${id})`);
      }
      await this.changeItemStatus(tx, newItemId, 'RESERVED', actor, `배정 실물 변경 (${id})`);

      await tx.rentalAllocationEvent.create({
        data: {
          id: randomUUID(),
          rentalAllocationId: id,
          eventType: ALLOCATION_EVENT_TYPES.ITEM_CHANGED,
          oldInventoryItemId: oldItemId,
          newInventoryItemId: newItemId,
          reason: dto.reason,
          actorId: actor.id,
        },
      });
      return after;
    });

    const identity = await this.allocationIdentity(id);
    const previousItem = await this.prisma.rentalInventoryItem.findUnique({
      where: { id: oldItemId },
      select: { managementCode: true },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'RENTAL_ALLOCATION',
      entityId: id,
      // 교체 전 관리번호는 배정에 더 이상 남지 않는다 — 실물에서 직접 읽어 남긴다.
      before: { ...identity, managementCode: previousItem?.managementCode ?? null },
      after: identity,
      reason: dto.reason,
    });
    return updated;
  }

  // ---------------------------------------------------------------------------
  // 출고 (RENT-004)
  // ---------------------------------------------------------------------------

  /**
   * 예약 실물 ID와 확인 ID가 일치해야 출고. 불일치 시 RENTAL_ID_MISMATCH.
   * 확인 실물은 confirmedInventoryItemId 또는 confirmedItemCode(관리코드) 둘 중 하나로 받는다.
   */
  async checkout(id: string, dto: CheckoutDto, actor: AuthUser) {
    const allocation = await this.prisma.rentalAllocation.findUnique({
      where: { id },
      include: { rentalInventoryItem: { select: { id: true, managementCode: true } } },
    });
    if (!allocation) throw new NotFoundException('렌탈 배정이 없습니다.');
    if (allocation.status !== 'RESERVED')
      throw new BusinessException('INVALID_STATUS_TRANSITION', '예약 상태의 배정만 출고할 수 있습니다.', undefined, {
        allocationStatus: allocation.status,
      });
    this.assertVersion(dto.version, allocation.rowVersion);

    const updated = await this.prisma.$transaction(async (tx) => {
      const after = await tx.rentalAllocation.update({
        where: { id },
        data: {
          status: 'CHECKED_OUT',
          actualPickupAt: parseDateOnly(dto.checkoutDate),
          rowVersion: { increment: 1 },
        },
        include: ALLOCATION_INCLUDE,
      });
      await this.changeItemStatus(tx, allocation.rentalInventoryItemId, 'CHECKED_OUT', actor, `렌탈 출고 (${id})`);
      await tx.rentalAllocationEvent.create({
        data: {
          id: randomUUID(),
          rentalAllocationId: id,
          eventType: ALLOCATION_EVENT_TYPES.PICKED_UP,
          newInventoryItemId: allocation.rentalInventoryItemId,
          // 예약과 다른 옷을 내보낸 경우 등 현장 메모를 이벤트에 남긴다.
          reason: dto.notes?.trim() || null,
          actorId: actor.id,
        },
      });
      return after;
    });

    const checkoutIdentity = await this.allocationIdentity(id);
    await this.audit.log({
      userId: actor.id,
      action: 'STATUS_CHANGE',
      entityType: 'RENTAL_ALLOCATION',
      entityId: id,
      before: { ...checkoutIdentity, status: allocation.status },
      after: { ...checkoutIdentity, status: 'CHECKED_OUT', checkoutDate: dto.checkoutDate },
    });
    return updated;
  }

  // ---------------------------------------------------------------------------
  // 반납 (RENT-004)
  // ---------------------------------------------------------------------------

  /**
   * 배정 RETURNED + 실물 RETURNED_HOLD(또는 요청 상태) + available_from 저장.
   *
   * 반납한 옷은 세탁 여부를 확인해야 해서 바로 못 빌려준다. availableFrom을 안 주면
   * 반납일 + 색 계열별 정비일(밝은색 2 / 블랙 타입 1)로 서버가 채운다.
   * 그날이 오면 스케줄러(RentalReleaseScheduler)가 AVAILABLE로 올린다.
   */
  async return(id: string, dto: ReturnDto, actor: AuthUser) {
    const allocation = await this.prisma.rentalAllocation.findUnique({
      where: { id },
      include: {
        rentalInventoryItem: { select: { id: true, status: true, rentalSku: { select: { color: true } } } },
      },
    });
    if (!allocation) throw new NotFoundException('렌탈 배정이 없습니다.');
    if (allocation.status !== 'CHECKED_OUT')
      throw new BusinessException('INVALID_STATUS_TRANSITION', '출고 상태의 배정만 반납할 수 있습니다.', undefined, {
        allocationStatus: allocation.status,
      });
    this.assertVersion(dto.version, allocation.rowVersion);

    const nextStatus = dto.nextStatus ?? 'RETURNED_HOLD';
    const colorCode = allocation.rentalInventoryItem.rentalSku.color;
    const cleaningDays = await this.policy.cleaningDaysFor(colorCode);
    const availableFromStr = dto.availableFrom ?? addDaysToDateOnly(dto.returnDate, cleaningDays);
    const availableFrom = parseDateOnly(availableFromStr);
    // 상태 이력만 봐도 "왜 이 날짜인가"가 읽혀야 한다 — 기준으로 잡은 건지 직원이 바꾼 건지.
    const reason = dto.availableFrom
      ? `렌탈 반납 (${id}) — 대여 가능 예정일 직접 지정`
      : `렌탈 반납 (${id}) — 정비 ${cleaningDays}일 (${colorCode})`;

    const updated = await this.prisma.$transaction(async (tx) => {
      const after = await tx.rentalAllocation.update({
        where: { id },
        data: {
          status: 'RETURNED',
          actualReturnAt: parseDateOnly(dto.returnDate),
          rowVersion: { increment: 1 },
        },
        include: ALLOCATION_INCLUDE,
      });
      await tx.rentalInventoryItem.update({
        where: { id: allocation.rentalInventoryItemId },
        data: { status: nextStatus, availableFrom, rowVersion: { increment: 1 } },
      });
      await tx.rentalInventoryStatusEvent.create({
        data: {
          id: randomUUID(),
          rentalInventoryItemId: allocation.rentalInventoryItemId,
          previousStatus: allocation.rentalInventoryItem.status,
          newStatus: nextStatus,
          availableFrom,
          reason,
          actorId: actor.id,
        },
      });
      await tx.rentalAllocationEvent.create({
        data: {
          id: randomUUID(),
          rentalAllocationId: id,
          eventType: ALLOCATION_EVENT_TYPES.RETURNED,
          newInventoryItemId: allocation.rentalInventoryItemId,
          actorId: actor.id,
        },
      });
      return after;
    });

    const returnIdentity = await this.allocationIdentity(id);
    await this.audit.log({
      userId: actor.id,
      action: 'STATUS_CHANGE',
      entityType: 'RENTAL_ALLOCATION',
      entityId: id,
      before: { ...returnIdentity, status: allocation.status },
      after: {
        ...returnIdentity,
        status: 'RETURNED',
        itemStatus: nextStatus,
        availableFrom: availableFromStr,
        cleaningDays,
      },
    });
    return updated;
  }

  // ---------------------------------------------------------------------------
  // 내부 헬퍼
  // ---------------------------------------------------------------------------

  /**
   * 감사로그용 배정 식별 정보 — "누구의 어느 계약에, 어떤 옷을" 이 로그만 보고 읽혀야 한다.
   * 배정 스냅샷은 UUID뿐이라 그것만으로는 고객도 계약도 알 수 없었다.
   * 전/후 양쪽에 같은 값으로 넣어 변경 항목 수는 늘리지 않으면서 대상만 드러낸다.
   */
  private async allocationIdentity(allocationId: string): Promise<Record<string, unknown>> {
    const row = await this.prisma.rentalAllocation.findUnique({
      where: { id: allocationId },
      include: ALLOCATION_VIEW_INCLUDE,
    });
    if (!row) return {};
    const orderItem = row.orderItemComponent.orderItem;
    return {
      customerName: orderItem.order.contract.customer.name,
      contractNo: orderItem.order.contract.contractNo,
      orderNo: orderItem.order.orderNo,
      componentType: row.orderItemComponent.componentType,
      managementCode: row.rentalInventoryItem.managementCode,
      color: row.rentalInventoryItem.rentalSku.color,
      size: row.rentalInventoryItem.rentalSku.size,
    };
  }

  /** 실물 UUID 또는 관리코드 중 하나를 실물 UUID로 해석한다 (연동정합화 계약 §5). */
  /**
   * 컬러·사이즈만 받아 그 기간에 배정 가능한 실물 하나를 고른다.
   *
   * 재고를 수량으로 관리하는 화면은 개체를 모르므로 어느 옷을 쓸지는 여기서 정한다
   * (현업 확정 2026-07-31). 판정 기준은 가용 검색(rental-inventory.availability)과 같아야 한다 —
   * 두 화면이 다른 답을 내면 "가용 2건"이라고 보여 준 날짜에 배정이 실패한다.
   * 고른 뒤에도 트랜잭션 안에서 assertItemAssignable이 다시 검증하고, 최종 방어선은
   * rental_allocation_no_overlap EXCLUDE 제약이다.
   */
  private async pickAssignableItem(
    componentType: string,
    color: string | undefined,
    size: string | undefined,
    pickup: Date,
    end: Date,
    /** 이 실물은 후보에서 뺀다 (실물 교체 — 지금 배정된 것 말고 다른 옷을 찾는다) */
    excludeItemId?: string,
  ): Promise<string> {
    if (!color || !size)
      throw new BusinessException(
        'VALIDATION_ERROR',
        '실물 ID·관리코드 또는 컬러·사이즈 중 하나는 필수입니다.',
        [{ field: 'inventoryItemId', reason: 'ITEM_OR_SKU_REQUIRED' }],
      );

    const item = await this.prisma.rentalInventoryItem.findFirst({
      where: {
        active: true,
        ...(excludeItemId ? { id: { not: excludeItemId } } : {}),
        status: { in: ASSIGNABLE_ITEM_STATUSES },
        OR: [{ availableFrom: null }, { availableFrom: { lte: pickup } }],
        rentalSku: { componentType, color, size },
        allocations: {
          none: {
            status: { not: 'CANCELLED' },
            pickupDate: { lte: end },
            availabilityEndDate: { gte: pickup },
          },
        },
      },
      orderBy: { managementCode: 'asc' },
      select: { id: true },
    });
    if (!item)
      throw new BusinessException(
        'VALIDATION_ERROR',
        excludeItemId
          ? '같은 규격으로 바꿀 수 있는 다른 실물이 없습니다.'
          : '그 기간에 빌려줄 수 있는 실물이 없습니다. 날짜나 컬러·사이즈를 바꿔 주세요.',
        [{ field: 'pickupDate', reason: 'NO_ASSIGNABLE_ITEM' }],
      );
    return item.id;
  }

  private async resolveInventoryItemId(
    inventoryItemId: string | undefined,
    itemCode: string | undefined,
    field: string,
  ): Promise<string> {
    if (inventoryItemId) return inventoryItemId;
    if (!itemCode)
      throw new BusinessException('VALIDATION_ERROR', '실물 ID 또는 관리코드 중 하나는 필수입니다.', [
        { field, reason: 'ITEM_ID_OR_CODE_REQUIRED' },
      ]);
    // 관리코드는 살아 있는 실물끼리만 유일하다 — 같은 코드의 폐기 이력은 건너뛴다.
    const item = await this.prisma.rentalInventoryItem.findFirst({
      where: { managementCode: itemCode.trim(), status: { not: 'RETIRED' } },
      select: { id: true },
    });
    if (!item) throw new NotFoundException(`해당 관리코드의 렌탈 실물이 없습니다: ${itemCode}`);
    return item.id;
  }

  /** 출고·반납 목록 평면 뷰 — 배정 필드 + 실물 관리코드/속성 + 고객명/주문번호/구성품 */
  private toAllocationView(row: AllocationViewRow, baseDate: Date, cleaningDays: Map<string, number> | null) {
    const sku = row.rentalInventoryItem.rentalSku;
    const orderItem = row.orderItemComponent.orderItem;
    const days = cleaningDays?.get(sku.color);
    return {
      id: row.id,
      status: row.status,
      pickupDate: toDateOnlyString(row.pickupDate),
      returnDueDate: toDateOnlyString(row.returnDueDate),
      availabilityEndDate: toDateOnlyString(row.availabilityEndDate),
      actualPickupAt: row.actualPickupAt,
      actualReturnAt: row.actualReturnAt,
      version: row.rowVersion,
      inventoryItemId: row.rentalInventoryItem.id,
      managementCode: row.rentalInventoryItem.managementCode,
      componentType: sku.componentType,
      color: sku.color,
      size: sku.size,
      componentId: row.orderItemComponent.id,
      componentSequenceNo: row.orderItemComponent.sequenceNo,
      orderItemId: orderItem.id,
      displayName: orderItem.displayName,
      orderId: orderItem.order.id,
      orderNo: orderItem.order.orderNo,
      customerId: orderItem.order.contract.customer.id,
      customerName: orderItem.order.contract.customer.name,
      customerPhone: orderItem.order.contract.customer.phone,
      /** 반납 뷰: 기준일 기준 반납예정일 경과(지연) 여부 */
      overdue: row.status === 'CHECKED_OUT' && row.returnDueDate < baseDate,
      /** 반납 뷰: 이 색의 정비 소요일과, 기준일에 반납한다고 볼 때의 대여 가능 예정일 */
      ...(days === undefined
        ? {}
        : {
            cleaningDays: days,
            suggestedAvailableFrom: addDaysToDateOnly(toDateOnlyString(baseDate), days),
          }),
    };
  }

  /**
   * 배정 가능 검증 (통합설계서 11.5):
   * 배정 가능 상태 AND active AND available_from <= 픽업일 AND 기간 미중복.
   */
  private async assertItemAssignable(
    tx: Prisma.TransactionClient,
    itemId: string,
    pickup: Date,
    end: Date,
    opts: { componentType?: string; excludeAllocationId?: string } = {},
  ): Promise<void> {
    const item = await tx.rentalInventoryItem.findUnique({ where: { id: itemId }, include: { rentalSku: true } });
    if (!item) throw new NotFoundException('렌탈 실물이 없습니다.');
    if (opts.componentType && item.rentalSku.componentType !== opts.componentType)
      throw new BusinessException('VALIDATION_ERROR', '구성품 품목과 실물 품목이 일치하지 않습니다.', [
        { field: 'inventoryItemId', reason: `COMPONENT_TYPE_MISMATCH:${item.rentalSku.componentType}` },
      ]);
    if (!item.active || !ASSIGNABLE_ITEM_STATUSES.includes(item.status))
      throw new BusinessException('RENTAL_ITEM_NOT_AVAILABLE', '배정할 수 없는 상태의 실물입니다.', undefined, {
        managementCode: item.managementCode,
        status: item.status,
        active: item.active,
      });
    if (item.availableFrom && item.availableFrom > pickup)
      throw new BusinessException(
        'RENTAL_ITEM_NOT_AVAILABLE',
        `대여 가능 예정일(${toDateOnlyString(item.availableFrom)}) 이전에는 배정할 수 없습니다.`,
        undefined,
        { managementCode: item.managementCode, availableFrom: toDateOnlyString(item.availableFrom) },
      );

    const overlap = await tx.rentalAllocation.findFirst({
      where: {
        rentalInventoryItemId: itemId,
        ...(opts.excludeAllocationId ? { id: { not: opts.excludeAllocationId } } : {}),
        status: { not: 'CANCELLED' },
        pickupDate: { lte: end },
        availabilityEndDate: { gte: pickup },
      },
      select: { id: true, status: true, pickupDate: true, availabilityEndDate: true },
    });
    if (overlap) {
      throw new BusinessException('RENTAL_PERIOD_OVERLAP', '해당 기간에 이미 배정된 실물입니다.', undefined, {
        managementCode: item.managementCode,
        conflictingAllocationId: overlap.id,
        conflictingStatus: overlap.status,
        conflictingPickupDate: toDateOnlyString(overlap.pickupDate),
        conflictingAvailabilityEndDate: toDateOnlyString(overlap.availabilityEndDate),
      });
    }
  }

  /** 트랜잭션 실행 + rental_allocation_no_overlap EXCLUDE 위반을 RENTAL_PERIOD_OVERLAP으로 변환 */
  private async runOverlapGuarded<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(fn);
    } catch (error) {
      if (isRentalOverlapDbError(error)) {
        throw new BusinessException(
          'RENTAL_PERIOD_OVERLAP',
          '동일 실물에 겹치는 기간의 배정이 이미 존재합니다.',
          undefined,
          { constraint: 'rental_allocation_no_overlap' },
        );
      }
      throw error;
    }
  }

  /** 실물 상태 변경 + 상태 이력 기록 (배정·출고·교체 흐름 공용) */
  private async changeItemStatus(
    tx: Prisma.TransactionClient,
    itemId: string,
    newStatus: string,
    actor: AuthUser,
    reason: string,
  ): Promise<void> {
    const item = await tx.rentalInventoryItem.findUniqueOrThrow({ where: { id: itemId }, select: { status: true } });
    if (item.status === newStatus) return;
    await tx.rentalInventoryItem.update({
      where: { id: itemId },
      data: { status: newStatus, rowVersion: { increment: 1 } },
    });
    await tx.rentalInventoryStatusEvent.create({
      data: {
        id: randomUUID(),
        rentalInventoryItemId: itemId,
        previousStatus: item.status,
        newStatus,
        reason,
        actorId: actor.id,
      },
    });
  }

  private assertVersion(requested: number | undefined, current: number): void {
    if (requested !== undefined && requested !== current) {
      throw new BusinessException('VERSION_CONFLICT', '다른 사용자가 먼저 변경했습니다. 다시 조회해 주세요.', undefined, {
        requestedVersion: requested,
        currentVersion: current,
      });
    }
  }
}
