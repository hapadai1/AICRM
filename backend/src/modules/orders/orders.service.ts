import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AddComponentDto, UpdateComponentDto } from './orders.dto';

const ITEMS_INCLUDE = {
  components: { orderBy: [{ componentType: 'asc' }, { sequenceNo: 'asc' }] },
} satisfies Prisma.OrderItemInclude;

/**
 * 주문 조회·구성품 관리.
 * 주문 경로에서 품목 수량을 변경하는 API는 의도적으로 제공하지 않는다(ORDER_ITEM_COUNT_LOCKED 원칙) —
 * 수량 증감은 계약 변경(contracts revisions)으로만 처리한다.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getOrder(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        contract: {
          select: {
            id: true,
            contractNo: true,
            status: true,
            customer: { select: { id: true, name: true, phone: true } },
          },
        },
        items: {
          include: ITEMS_INCLUDE,
          orderBy: [{ productCategory: 'asc' }, { sequenceNo: 'asc' }],
        },
      },
    });
    if (!order) throw new NotFoundException('주문이 없습니다.');
    return order;
  }

  async getItems(orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { id: true } });
    if (!order) throw new NotFoundException('주문이 없습니다.');
    return this.prisma.orderItem.findMany({
      where: { orderId },
      include: ITEMS_INCLUDE,
      orderBy: [{ productCategory: 'asc' }, { sequenceNo: 'asc' }],
    });
  }

  /** 구성품 추가 (예: 정장에 VEST). 동일 구성품 복수 추가 시 sequence_no 증가. */
  async addComponent(orderItemId: string, dto: AddComponentDto, actor: AuthUser) {
    const item = await this.prisma.orderItem.findUnique({
      where: { id: orderItemId },
      include: { components: true },
    });
    if (!item) throw new NotFoundException('주문 품목이 없습니다.');
    if (item.status === 'CANCELLED')
      throw new BusinessException('INVALID_STATUS_TRANSITION', '취소된 품목에는 구성품을 추가할 수 없습니다.', undefined, {
        status: item.status,
      });

    const nextSeq =
      item.components
        .filter((c) => c.componentType === dto.componentType)
        .reduce((max, c) => Math.max(max, c.sequenceNo), 0) + 1;

    const component = await this.prisma.orderItemComponent.create({
      data: {
        id: randomUUID(),
        orderItemId,
        componentType: dto.componentType,
        sequenceNo: nextSeq,
        status: 'CREATED',
        expectedInboundDate: dto.expectedInboundDate ? new Date(dto.expectedInboundDate) : null,
        notes: dto.notes ?? null,
      },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'ORDER_ITEM_COMPONENT',
      entityId: component.id,
      after: { orderItemId, componentType: component.componentType, sequenceNo: component.sequenceNo },
    });
    return component;
  }

  /** 구성품 수정: 메모·입고 예정일. 수량 개념 없음. */
  async updateComponent(id: string, dto: UpdateComponentDto, actor: AuthUser) {
    const before = await this.prisma.orderItemComponent.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('구성품이 없습니다.');

    const updated = await this.prisma.orderItemComponent.update({
      where: { id },
      data: {
        ...(dto.expectedInboundDate !== undefined
          ? { expectedInboundDate: dto.expectedInboundDate ? new Date(dto.expectedInboundDate) : null }
          : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'ORDER_ITEM_COMPONENT',
      entityId: id,
      before: { expectedInboundDate: before.expectedInboundDate, notes: before.notes },
      after: { expectedInboundDate: updated.expectedInboundDate, notes: updated.notes },
    });
    return updated;
  }
}
