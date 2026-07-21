import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  AGGREGATE_ONLY_STATUSES,
  CANCELLED,
  COMPONENT_STATUS_FLOW,
  computeAggregateStatus,
  ITEM_STATUS_FLOW,
  validateTransition,
} from './production-status';
import {
  CreateFittingDto,
  CreateProductionEventDto,
  ProductionItemsQueryDto,
  ReceiveComponentDto,
  ReleaseComponentDto,
} from './production.dto';

const EVENT_SELECT = {
  id: true,
  orderItemId: true,
  componentId: true,
  eventType: true,
  previousStatus: true,
  newStatus: true,
  expectedDate: true,
  eventDate: true,
  notes: true,
  createdAt: true,
  actor: { select: { id: true, displayName: true } },
} as const;

const COMPONENT_SELECT = {
  id: true,
  componentType: true,
  sequenceNo: true,
  status: true,
  expectedInboundDate: true,
  actualInboundAt: true,
  actualOutboundAt: true,
  notes: true,
  active: true,
} as const;

function toDate(value?: string): Date | undefined {
  return value ? new Date(value) : undefined;
}

function today(): Date {
  return new Date(new Date().toISOString().slice(0, 10));
}

/** 역행·취소 사유를 이벤트 메모에 함께 남긴다 (production_events에 별도 사유 컬럼 없음). */
function mergeNotes(notes?: string, reason?: string): string | undefined {
  if (notes && reason) return `${notes} (사유: ${reason})`;
  return notes ?? reason;
}

@Injectable()
export class ProductionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // 품목 상태 이벤트
  // ---------------------------------------------------------------------------

  async createItemEvent(orderItemId: string, dto: CreateProductionEventDto, actor: AuthUser) {
    const item = await this.prisma.orderItem.findUnique({ where: { id: orderItemId } });
    if (!item) throw new NotFoundException('주문 품목이 없습니다.');

    if (AGGREGATE_ONLY_STATUSES.includes(dto.newStatus))
      throw new BusinessException(
        'VALIDATION_ERROR',
        `${dto.newStatus}는 구성품 상태에서 자동 집계되는 상태로 직접 설정할 수 없습니다.`,
        [{ field: 'newStatus', reason: 'AGGREGATE_ONLY' }],
      );
    validateTransition(ITEM_STATUS_FLOW, item.status, dto.newStatus, dto.reason, '품목');

    const event = await this.prisma.$transaction(async (tx) => {
      const created = await tx.productionEvent.create({
        data: {
          id: randomUUID(),
          orderItemId,
          componentId: null,
          eventType: dto.newStatus,
          previousStatus: item.status,
          newStatus: dto.newStatus,
          expectedDate: toDate(dto.expectedDate),
          eventDate: toDate(dto.eventDate) ?? today(),
          notes: mergeNotes(dto.notes, dto.reason),
          actorId: actor.id,
        },
        select: EVENT_SELECT,
      });
      await tx.orderItem.update({
        where: { id: orderItemId },
        data: {
          status: dto.newStatus,
          ...(dto.newStatus === CANCELLED
            ? { cancelledReason: dto.reason ?? dto.notes, cancelledAt: new Date() }
            : {}),
        },
      });
      await this.audit.log(
        {
          userId: actor.id,
          action: 'STATUS_CHANGE',
          entityType: 'ORDER_ITEM',
          entityId: orderItemId,
          before: { status: item.status },
          after: { status: dto.newStatus },
          reason: dto.reason,
        },
        tx,
      );
      return created;
    });
    return event;
  }

  // ---------------------------------------------------------------------------
  // 구성품 상태 이벤트·입고·출고
  // ---------------------------------------------------------------------------

  async createComponentEvent(componentId: string, dto: CreateProductionEventDto, actor: AuthUser) {
    const component = await this.findComponent(componentId);
    validateTransition(COMPONENT_STATUS_FLOW, component.status, dto.newStatus, dto.reason, '구성품');

    return this.applyComponentChange(component, actor, {
      eventType: dto.newStatus,
      newStatus: dto.newStatus,
      eventDate: toDate(dto.eventDate) ?? today(),
      expectedDate: toDate(dto.expectedDate),
      notes: mergeNotes(dto.notes, dto.reason),
      reason: dto.reason,
    });
  }

  /** 구성품 입고: actual_inbound_at 기록 + RECEIVED 이벤트 + 품목 집계 갱신 */
  async receiveComponent(componentId: string, dto: ReceiveComponentDto, actor: AuthUser) {
    const component = await this.findComponent(componentId);
    if (component.status === CANCELLED || component.status === 'RECEIVED' || component.status === 'RELEASED')
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        component.status === CANCELLED
          ? '취소된 구성품은 입고할 수 없습니다.'
          : '이미 입고 처리된 구성품입니다.',
        undefined,
        { current: component.status },
      );

    const receivedAt = toDate(dto.receivedAt) ?? new Date();
    return this.applyComponentChange(component, actor, {
      eventType: 'RECEIVED',
      newStatus: 'RECEIVED',
      eventDate: toDate(dto.receivedAt) ?? today(),
      notes: dto.notes,
      componentData: { actualInboundAt: receivedAt },
    });
  }

  /** 구성품 출고: 입고(RECEIVED) 상태에서만 가능. actual_outbound_at 기록 + RELEASED 이벤트 */
  async releaseComponent(componentId: string, dto: ReleaseComponentDto, actor: AuthUser) {
    const component = await this.findComponent(componentId);
    if (component.status !== 'RECEIVED')
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '입고 상태의 구성품만 출고할 수 있습니다.',
        undefined,
        { current: component.status, required: 'RECEIVED' },
      );

    const releasedAt = toDate(dto.releasedAt) ?? new Date();
    return this.applyComponentChange(component, actor, {
      eventType: 'RELEASED',
      newStatus: 'RELEASED',
      eventDate: toDate(dto.releasedAt) ?? today(),
      notes: dto.notes,
      componentData: { actualOutboundAt: releasedAt },
    });
  }

  /**
   * 구성품 이벤트 저장 + 구성품 상태 갱신 + 품목 집계 상태 재계산을 단일 트랜잭션으로 처리한다.
   * (데이터모델 §10.3 "구성품별 이벤트를 우선 저장하고 품목 상태는 집계로 갱신")
   */
  private async applyComponentChange(
    component: { id: string; orderItemId: string; status: string },
    actor: AuthUser,
    change: {
      eventType: string;
      newStatus: string;
      eventDate: Date;
      expectedDate?: Date;
      notes?: string;
      reason?: string;
      componentData?: Prisma.OrderItemComponentUncheckedUpdateInput;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const event = await tx.productionEvent.create({
        data: {
          id: randomUUID(),
          orderItemId: component.orderItemId,
          componentId: component.id,
          eventType: change.eventType,
          previousStatus: component.status,
          newStatus: change.newStatus,
          expectedDate: change.expectedDate,
          eventDate: change.eventDate,
          notes: change.notes,
          actorId: actor.id,
        },
        select: EVENT_SELECT,
      });
      const updated = await tx.orderItemComponent.update({
        where: { id: component.id },
        data: { status: change.newStatus, ...(change.componentData ?? {}) },
        select: COMPONENT_SELECT,
      });
      await this.audit.log(
        {
          userId: actor.id,
          action: 'STATUS_CHANGE',
          entityType: 'ORDER_ITEM_COMPONENT',
          entityId: component.id,
          before: { status: component.status },
          after: { status: change.newStatus },
          reason: change.reason,
        },
        tx,
      );

      const itemStatus = await this.aggregateItemStatus(tx, component.orderItemId, change.eventDate, actor);
      return { event, component: updated, orderItemStatus: itemStatus };
    });
  }

  /** 구성품 상태를 집계해 품목 상태를 갱신하고, 변경 시 집계 이벤트를 남긴다. */
  private async aggregateItemStatus(
    tx: Prisma.TransactionClient,
    orderItemId: string,
    eventDate: Date,
    actor: AuthUser,
  ): Promise<string> {
    const item = await tx.orderItem.findUniqueOrThrow({
      where: { id: orderItemId },
      include: { components: { select: { status: true, active: true } } },
    });
    const computed = computeAggregateStatus(item.components);
    if (!computed || computed === item.status || item.status === CANCELLED) return item.status;

    await tx.orderItem.update({ where: { id: orderItemId }, data: { status: computed } });
    await tx.productionEvent.create({
      data: {
        id: randomUUID(),
        orderItemId,
        componentId: null,
        eventType: 'ITEM_STATUS_AGGREGATED',
        previousStatus: item.status,
        newStatus: computed,
        eventDate,
        notes: '구성품 상태 집계에 따른 품목 상태 갱신',
        actorId: actor.id,
      },
    });
    await this.audit.log(
      {
        userId: actor.id,
        action: 'STATUS_CHANGE',
        entityType: 'ORDER_ITEM',
        entityId: orderItemId,
        before: { status: item.status },
        after: { status: computed },
        reason: '구성품 입출고 집계',
      },
      tx,
    );
    return computed;
  }

  // ---------------------------------------------------------------------------
  // 조회
  // ---------------------------------------------------------------------------

  /** 주문 단위 제작 이벤트 타임라인 */
  async getOrderProductionHistory(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderNo: true, transactionType: true, status: true },
    });
    if (!order) throw new NotFoundException('주문이 없습니다.');

    const events = await this.prisma.productionEvent.findMany({
      where: { orderItem: { orderId } },
      select: {
        ...EVENT_SELECT,
        orderItem: { select: { id: true, displayName: true, productCategory: true, sequenceNo: true } },
        component: { select: { id: true, componentType: true, sequenceNo: true } },
      },
      orderBy: [{ eventDate: 'asc' }, { createdAt: 'asc' }],
    });
    return { order, events };
  }

  /** 제작 현황 목록: 품목 + 구성품 + 집계 상태 */
  async listProductionItems(query: ProductionItemsQueryDto) {
    const where: Prisma.OrderItemWhereInput = {
      ...(query.status ? { status: query.status } : {}),
    };
    const [totalElements, items] = await this.prisma.$transaction([
      this.prisma.orderItem.count({ where }),
      this.prisma.orderItem.findMany({
        where,
        select: {
          id: true,
          displayName: true,
          productCategory: true,
          sequenceNo: true,
          status: true,
          createdAt: true,
          order: {
            select: {
              id: true,
              orderNo: true,
              transactionType: true,
              completionDueDate: true,
              contract: { select: { customer: { select: { id: true, name: true, phone: true } } } },
            },
          },
          components: { select: COMPONENT_SELECT, orderBy: { sequenceNo: 'asc' } },
        },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.size,
      }),
    ]);
    return new Paginated(items, query.page, query.size, totalElements);
  }

  // ---------------------------------------------------------------------------
  // 가봉
  // ---------------------------------------------------------------------------

  async createFitting(orderItemId: string, dto: CreateFittingDto, actor: AuthUser) {
    const item = await this.prisma.orderItem.findUnique({
      where: { id: orderItemId },
      include: { components: { select: { id: true } } },
    });
    if (!item) throw new NotFoundException('주문 품목이 없습니다.');

    const componentIds = new Set(item.components.map((c) => c.id));
    for (const adj of dto.adjustments ?? []) {
      if (adj.componentId && !componentIds.has(adj.componentId))
        throw new BusinessException('VALIDATION_ERROR', '보정 대상 구성품이 해당 품목에 속하지 않습니다.', [
          { field: 'adjustments.componentId', reason: 'NOT_IN_ORDER_ITEM' },
        ]);
    }
    if (dto.appointmentId) {
      const appointment = await this.prisma.appointment.findUnique({ where: { id: dto.appointmentId } });
      if (!appointment)
        throw new BusinessException('VALIDATION_ERROR', '연결할 예약이 없습니다.', [
          { field: 'appointmentId', reason: 'NOT_FOUND' },
        ]);
    }

    const session = await this.prisma.$transaction(async (tx) => {
      const created = await tx.fittingSession.create({
        data: {
          id: randomUUID(),
          orderItemId,
          appointmentId: dto.appointmentId,
          fittingDate: new Date(dto.fittingDate),
          notes: dto.notes,
          nextAppointmentDate: toDate(dto.nextAppointmentDate),
          adjustments: {
            create: (dto.adjustments ?? []).map((adj) => ({
              id: randomUUID(),
              componentId: adj.componentId,
              area: adj.area,
              instruction: adj.instruction,
            })),
          },
        },
        include: {
          adjustments: { include: { component: { select: { id: true, componentType: true } } } },
        },
      });
      await this.audit.log(
        {
          userId: actor.id,
          action: 'CREATE',
          entityType: 'FITTING_SESSION',
          entityId: created.id,
          after: created,
        },
        tx,
      );
      return created;
    });
    return session;
  }

  async listFittings(orderItemId: string) {
    const item = await this.prisma.orderItem.findUnique({ where: { id: orderItemId }, select: { id: true } });
    if (!item) throw new NotFoundException('주문 품목이 없습니다.');
    return this.prisma.fittingSession.findMany({
      where: { orderItemId },
      include: {
        adjustments: { include: { component: { select: { id: true, componentType: true } } } },
      },
      orderBy: [{ fittingDate: 'desc' }, { createdAt: 'desc' }],
    });
  }

  private async findComponent(componentId: string) {
    const component = await this.prisma.orderItemComponent.findUnique({ where: { id: componentId } });
    if (!component) throw new NotFoundException('구성품이 없습니다.');
    return component;
  }
}
