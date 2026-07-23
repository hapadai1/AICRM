import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  ACTIVE_ALLOCATION_STATUSES,
  ALLOCATION_EVENT_TYPES,
  ASSIGNABLE_ITEM_STATUSES,
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
              contract: { select: { customer: { select: { id: true, name: true } } } },
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
  ) {}

  // ---------------------------------------------------------------------------
  // 출고·반납 대상 목록 (RENT-004)
  // ---------------------------------------------------------------------------

  /**
   * 출고·반납 화면 목록 뷰 (연동정합화 계약 §5):
   * - pickup: RESERVED/PREPARING & pickupDate <= date (기본 오늘)
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
      status: { in: ['RESERVED', 'PREPARING'] },
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
    return rows.map((row) => this.toAllocationView(row, date));
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
                contract: { select: { customer: { select: { id: true, name: true } } } },
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
    const inventoryItemId = await this.resolveInventoryItemId(dto.inventoryItemId, dto.itemCode, 'inventoryItemId');

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
    const end = parseDateOnly(dto.availabilityEndDate);
    if (returnDue < pickup || end < returnDue)
      throw new BusinessException(
        'VALIDATION_ERROR',
        '기간이 올바르지 않습니다. 픽업일 <= 반납예정일 <= 가용종료일이어야 합니다.',
        [{ field: 'availabilityEndDate', reason: 'INVALID_PERIOD' }],
      );

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
      after: allocation,
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
      include: { rentalInventoryItem: true, orderItemComponent: { select: { componentType: true } } },
    });
    if (!allocation) throw new NotFoundException('렌탈 배정이 없습니다.');
    if (!['RESERVED', 'PREPARING'].includes(allocation.status))
      throw new BusinessException('INVALID_STATUS_TRANSITION', '출고 전 배정만 실물을 변경할 수 있습니다.', undefined, {
        allocationStatus: allocation.status,
      });
    this.assertVersion(dto.version, allocation.rowVersion);
    if (dto.newInventoryItemId === allocation.rentalInventoryItemId)
      throw new BusinessException('VALIDATION_ERROR', '현재 배정된 실물과 동일합니다.', [
        { field: 'newInventoryItemId', reason: 'SAME_ITEM' },
      ]);

    const oldItemId = allocation.rentalInventoryItemId;
    const updated = await this.runOverlapGuarded(async (tx) => {
      await this.assertItemAssignable(tx, dto.newInventoryItemId, allocation.pickupDate, allocation.availabilityEndDate, {
        componentType: allocation.orderItemComponent.componentType,
        excludeAllocationId: id,
      });

      const after = await tx.rentalAllocation.update({
        where: { id },
        data: { rentalInventoryItemId: dto.newInventoryItemId, rowVersion: { increment: 1 } },
        include: ALLOCATION_INCLUDE,
      });

      // 구실물 상태 복원: 다른 살아있는 배정이 없으면 AVAILABLE
      const remaining = await tx.rentalAllocation.count({
        where: { rentalInventoryItemId: oldItemId, id: { not: id }, status: { in: ACTIVE_ALLOCATION_STATUSES } },
      });
      if (remaining === 0) {
        await this.changeItemStatus(tx, oldItemId, 'AVAILABLE', actor, `배정 실물 변경 해제 (${id})`);
      }
      await this.changeItemStatus(tx, dto.newInventoryItemId, 'RESERVED', actor, `배정 실물 변경 (${id})`);

      await tx.rentalAllocationEvent.create({
        data: {
          id: randomUUID(),
          rentalAllocationId: id,
          eventType: ALLOCATION_EVENT_TYPES.ITEM_CHANGED,
          oldInventoryItemId: oldItemId,
          newInventoryItemId: dto.newInventoryItemId,
          reason: dto.reason,
          actorId: actor.id,
        },
      });
      return after;
    });

    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'RENTAL_ALLOCATION',
      entityId: id,
      before: { rentalInventoryItemId: oldItemId },
      after: { rentalInventoryItemId: dto.newInventoryItemId },
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
    const confirmedInventoryItemId = await this.resolveInventoryItemId(
      dto.confirmedInventoryItemId,
      dto.confirmedItemCode,
      'confirmedInventoryItemId',
    );

    const allocation = await this.prisma.rentalAllocation.findUnique({
      where: { id },
      include: { rentalInventoryItem: { select: { id: true, managementCode: true } } },
    });
    if (!allocation) throw new NotFoundException('렌탈 배정이 없습니다.');
    if (!['RESERVED', 'PREPARING'].includes(allocation.status))
      throw new BusinessException('INVALID_STATUS_TRANSITION', '예약 상태의 배정만 출고할 수 있습니다.', undefined, {
        allocationStatus: allocation.status,
      });
    this.assertVersion(dto.version, allocation.rowVersion);

    if (confirmedInventoryItemId !== allocation.rentalInventoryItemId)
      throw new BusinessException(
        'RENTAL_ID_MISMATCH',
        '예약된 실물 ID와 출고 확인 ID가 다릅니다. 먼저 배정 실물을 변경해 주세요.',
        undefined,
        {
          assignedInventoryItemId: allocation.rentalInventoryItemId,
          assignedManagementCode: allocation.rentalInventoryItem.managementCode,
          confirmedInventoryItemId,
          ...(dto.confirmedItemCode ? { confirmedItemCode: dto.confirmedItemCode } : {}),
        },
      );

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
          actorId: actor.id,
        },
      });
      return after;
    });

    await this.audit.log({
      userId: actor.id,
      action: 'STATUS_CHANGE',
      entityType: 'RENTAL_ALLOCATION',
      entityId: id,
      before: { status: allocation.status },
      after: { status: 'CHECKED_OUT', checkoutDate: dto.checkoutDate },
    });
    return updated;
  }

  // ---------------------------------------------------------------------------
  // 반납 (RENT-004)
  // ---------------------------------------------------------------------------

  /**
   * 배정 RETURNED + 실물 RETURNED_HOLD(또는 요청 상태) + available_from 저장.
   * 반납만으로 자동 AVAILABLE 전환하지 않는다 — 가용 전환은 status-events로 직원이 수동 처리.
   */
  async return(id: string, dto: ReturnDto, actor: AuthUser) {
    const allocation = await this.prisma.rentalAllocation.findUnique({
      where: { id },
      include: { rentalInventoryItem: { select: { id: true, status: true } } },
    });
    if (!allocation) throw new NotFoundException('렌탈 배정이 없습니다.');
    if (allocation.status !== 'CHECKED_OUT')
      throw new BusinessException('INVALID_STATUS_TRANSITION', '출고 상태의 배정만 반납할 수 있습니다.', undefined, {
        allocationStatus: allocation.status,
      });
    this.assertVersion(dto.version, allocation.rowVersion);

    const nextStatus = dto.nextStatus ?? 'RETURNED_HOLD';
    const availableFrom = parseDateOnly(dto.availableFrom);

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
          reason: `렌탈 반납 (${id})`,
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

    await this.audit.log({
      userId: actor.id,
      action: 'STATUS_CHANGE',
      entityType: 'RENTAL_ALLOCATION',
      entityId: id,
      before: { status: allocation.status },
      after: { status: 'RETURNED', itemStatus: nextStatus, availableFrom: dto.availableFrom },
    });
    return updated;
  }

  // ---------------------------------------------------------------------------
  // 내부 헬퍼
  // ---------------------------------------------------------------------------

  /** 실물 UUID 또는 관리코드 중 하나를 실물 UUID로 해석한다 (연동정합화 계약 §5). */
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
    const item = await this.prisma.rentalInventoryItem.findUnique({
      where: { managementCode: itemCode.trim() },
      select: { id: true },
    });
    if (!item) throw new NotFoundException(`해당 관리코드의 렌탈 실물이 없습니다: ${itemCode}`);
    return item.id;
  }

  /** 출고·반납 목록 평면 뷰 — 배정 필드 + 실물 관리코드/속성 + 고객명/주문번호/구성품 */
  private toAllocationView(row: AllocationViewRow, baseDate: Date) {
    const sku = row.rentalInventoryItem.rentalSku;
    const orderItem = row.orderItemComponent.orderItem;
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
      design: sku.design,
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
      /** 반납 뷰: 기준일 기준 반납예정일 경과(지연) 여부 */
      overdue: row.status === 'CHECKED_OUT' && row.returnDueDate < baseDate,
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
