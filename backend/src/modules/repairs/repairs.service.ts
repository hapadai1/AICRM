import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException, FieldError } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationSuggestionService } from '../notifications/notification-suggestion.service';
import {
  CreateRepairDto,
  CreateRepairStatusEventDto,
  LinkTargetsQueryDto,
  ListRepairsQueryDto,
  UpdateRepairDto,
} from './repairs.dto';

/** 수선 상태 순서 (통합설계서 §12.1: 접수→수선 요청→수선 중→수선 입고→고객 연락→출고 완료) */
export const REPAIR_STATUS_FLOW = [
  'RECEIVED',
  'REQUESTED',
  'IN_PROGRESS',
  'RETURNED_TO_SHOP',
  'CUSTOMER_NOTIFIED',
  'RELEASED',
] as const;

const CANCELLED = 'CANCELLED';

/**
 * 고객 연락을 제안할 수선 상태 (개발설계서 05 G-06).
 * 설계 PDF 1페이지 수선 구분의 "고객연락" 업무에 대응한다.
 * 실제 발송 여부는 notification_rules에 규칙이 있을 때만 제안되며,
 * 규칙이 없으면 아무 일도 일어나지 않는다(기존 동작 유지).
 */
const NOTIFY_STATUSES = ['RECEIVED', 'CUSTOMER_NOTIFIED'];

const CUSTOM_TYPES = ['CUSTOM_DURING', 'AFTER_SALE'];
const RENTAL_TYPES = ['RENTAL_PRE', 'RENTAL_POST'];

const REPAIR_SUMMARY_SELECT = {
  id: true,
  repairType: true,
  requestDate: true,
  dueDate: true,
  status: true,
  description: true,
  cost: true,
  notes: true,
  receiptMethod: true,
  releaseMethod: true,
  pickupAddress: true,
  deliveryAddress: true,
  createdAt: true,
  updatedAt: true,
  customer: { select: { id: true, name: true, phone: true } },
  order: { select: { id: true, orderNo: true } },
  orderItem: { select: { id: true, displayName: true, productCategory: true } },
  component: { select: { id: true, componentType: true, sequenceNo: true } },
  rentalInventoryItem: { select: { id: true, managementCode: true } },
} as const;

const REPAIR_DETAIL_SELECT = {
  ...REPAIR_SUMMARY_SELECT,
  statusEvents: {
    select: {
      id: true,
      previousStatus: true,
      newStatus: true,
      eventDate: true,
      notes: true,
      createdAt: true,
      actor: { select: { id: true, displayName: true } },
    },
    orderBy: [{ eventDate: 'asc' }, { createdAt: 'asc' }],
  },
} satisfies Prisma.RepairRequestSelect;

function toDate(value?: string): Date | undefined {
  return value ? new Date(value) : undefined;
}

function today(): Date {
  return new Date(new Date().toISOString().slice(0, 10));
}

@Injectable()
export class RepairsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly suggestions: NotificationSuggestionService,
  ) {}

  async list(query: ListRepairsQueryDto) {
    const where: Prisma.RepairRequestWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
    };
    const [totalElements, items] = await this.prisma.$transaction([
      this.prisma.repairRequest.count({ where }),
      this.prisma.repairRequest.findMany({
        where,
        select: REPAIR_SUMMARY_SELECT,
        orderBy: [{ requestDate: 'desc' }, { createdAt: 'desc' }],
        skip: query.skip,
        take: query.size,
      }),
    ]);
    return new Paginated(items, query.page, query.size, totalElements);
  }

  /**
   * 수선 접수 모달 연결 대상 후보 (연동정합화 계약 §8):
   * - orderItems: 고객의 맞춤(CUSTOM) 주문 품목(취소 제외) + 활성 구성품
   * - rentalItems: 고객 렌탈 배정(취소 제외)에 연결된 실물 요약(최근 배정 기준 중복 제거)
   */
  async linkTargets(query: LinkTargetsQueryDto) {
    const customer = await this.prisma.customer.findUnique({ where: { id: query.customerId } });
    if (!customer)
      throw new BusinessException('CUSTOMER_NOT_FOUND', '고객이 없습니다.', [
        { field: 'customerId', reason: 'NOT_FOUND' },
      ]);

    const [items, allocations] = await Promise.all([
      this.prisma.orderItem.findMany({
        where: {
          status: { not: 'CANCELLED' },
          order: { transactionType: 'CUSTOM', contract: { customerId: query.customerId } },
        },
        select: {
          id: true,
          displayName: true,
          productCategory: true,
          sequenceNo: true,
          status: true,
          order: { select: { id: true, orderNo: true } },
          components: {
            where: { active: true },
            select: { id: true, componentType: true, sequenceNo: true, status: true },
            orderBy: [{ componentType: 'asc' }, { sequenceNo: 'asc' }],
          },
        },
        orderBy: [{ createdAt: 'desc' }, { sequenceNo: 'asc' }],
      }),
      this.prisma.rentalAllocation.findMany({
        where: {
          status: { not: 'CANCELLED' },
          orderItemComponent: { orderItem: { order: { contract: { customerId: query.customerId } } } },
        },
        orderBy: [{ pickupDate: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          status: true,
          pickupDate: true,
          returnDueDate: true,
          rentalInventoryItem: { include: { rentalSku: true } },
        },
      }),
    ]);

    // 동일 실물이 여러 배정에 걸치면 최근 배정 하나로 요약한다.
    const rentalItems = new Map<string, Record<string, unknown>>();
    for (const allocation of allocations) {
      const item = allocation.rentalInventoryItem;
      if (rentalItems.has(item.id)) continue;
      rentalItems.set(item.id, {
        id: item.id,
        managementCode: item.managementCode,
        componentType: item.rentalSku.componentType,
        design: item.rentalSku.design,
        color: item.rentalSku.color,
        size: item.rentalSku.size,
        status: item.status,
        allocationId: allocation.id,
        allocationStatus: allocation.status,
        pickupDate: allocation.pickupDate,
        returnDueDate: allocation.returnDueDate,
      });
    }

    return {
      orderItems: items.map((item) => ({
        id: item.id,
        displayName: item.displayName,
        productCategory: item.productCategory,
        sequenceNo: item.sequenceNo,
        status: item.status,
        orderId: item.order.id,
        orderNo: item.order.orderNo,
        components: item.components,
      })),
      rentalItems: [...rentalItems.values()],
    };
  }

  /** 수선 접수: 유형별 연결 검증 후 접수(RECEIVED) 상태로 생성한다 (통합설계서 §12.1). */
  async create(dto: CreateRepairDto, actor: AuthUser) {
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer)
      throw new BusinessException('CUSTOMER_NOT_FOUND', '고객이 없습니다.', [
        { field: 'customerId', reason: 'NOT_FOUND' },
      ]);

    const links = await this.resolveLinks(dto);
    this.assertMethodAddresses(dto);

    const repair = await this.prisma.$transaction(async (tx) => {
      const requestDate = new Date(dto.requestDate);
      const created = await tx.repairRequest.create({
        data: {
          id: randomUUID(),
          customerId: dto.customerId,
          orderId: links.orderId,
          orderItemId: links.orderItemId,
          componentId: links.componentId,
          rentalInventoryItemId: links.rentalInventoryItemId,
          repairType: dto.repairType,
          requestDate,
          dueDate: toDate(dto.dueDate),
          status: 'RECEIVED',
          description: dto.description,
          cost: dto.cost,
          notes: dto.notes,
          ...this.methodData(dto),
          statusEvents: {
            create: {
              id: randomUUID(),
              previousStatus: null,
              newStatus: 'RECEIVED',
              eventDate: requestDate,
              notes: '수선 접수',
              actorId: actor.id,
            },
          },
        },
        select: REPAIR_DETAIL_SELECT,
      });
      await this.audit.log(
        { userId: actor.id, action: 'CREATE', entityType: 'REPAIR_REQUEST', entityId: created.id, after: created },
        tx,
      );
      return created;
    });
    return repair;
  }

  async get(id: string) {
    const repair = await this.prisma.repairRequest.findUnique({
      where: { id },
      select: REPAIR_DETAIL_SELECT,
    });
    if (!repair) throw new NotFoundException('수선 요청이 없습니다.');
    return repair;
  }

  async update(id: string, dto: UpdateRepairDto, actor: AuthUser) {
    const before = await this.prisma.repairRequest.findUnique({ where: { id }, select: REPAIR_SUMMARY_SELECT });
    if (!before) throw new NotFoundException('수선 요청이 없습니다.');

    // 방식을 바꿀 때는 기존 값과 합쳐 판정해야 한다(주소만 지우는 경우 방지).
    this.assertMethodAddresses({
      receiptMethod: dto.receiptMethod ?? before.receiptMethod ?? undefined,
      releaseMethod: dto.releaseMethod ?? before.releaseMethod ?? undefined,
      pickupAddress: dto.pickupAddress ?? before.pickupAddress ?? undefined,
      deliveryAddress: dto.deliveryAddress ?? before.deliveryAddress ?? undefined,
    });

    const updated = await this.prisma.repairRequest.update({
      where: { id },
      data: {
        ...(dto.dueDate !== undefined ? { dueDate: toDate(dto.dueDate) } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.cost !== undefined ? { cost: dto.cost } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...this.methodData(dto),
      },
      select: REPAIR_DETAIL_SELECT,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'REPAIR_REQUEST',
      entityId: id,
      before,
      after: updated,
    });
    return updated;
  }

  /**
   * 수선 상태 변경. 허용 전이는 순서상 바로 다음 단계만 가능하며
   * CANCELLED는 어느 상태에서든 진입할 수 있다. 위반 시 INVALID_STATUS_TRANSITION.
   */
  async createStatusEvent(id: string, dto: CreateRepairStatusEventDto, actor: AuthUser) {
    const repair = await this.prisma.repairRequest.findUnique({ where: { id } });
    if (!repair) throw new NotFoundException('수선 요청이 없습니다.');

    this.validateStatusTransition(repair.status, dto.newStatus);

    const result = await this.prisma.$transaction(async (tx) => {
      const event = await tx.repairStatusEvent.create({
        data: {
          id: randomUUID(),
          repairRequestId: id,
          previousStatus: repair.status,
          newStatus: dto.newStatus,
          eventDate: toDate(dto.eventDate) ?? today(),
          notes: dto.notes,
          actorId: actor.id,
        },
        select: {
          id: true,
          repairRequestId: true,
          previousStatus: true,
          newStatus: true,
          eventDate: true,
          notes: true,
          createdAt: true,
          actor: { select: { id: true, displayName: true } },
        },
      });
      await tx.repairRequest.update({ where: { id }, data: { status: dto.newStatus } });
      await this.audit.log(
        {
          userId: actor.id,
          action: 'STATUS_CHANGE',
          entityType: 'REPAIR_REQUEST',
          entityId: id,
          before: { status: repair.status },
          after: { status: dto.newStatus },
        },
        tx,
      );
      return event;
    });

    // 연락 대상 상태면 문구를 준비해 화면의 확인창 재료로 함께 돌려준다.
    // 발송은 별도 요청이므로 발송 실패가 상태 변경을 되돌리지 않는다.
    // 기존 응답 필드는 그대로 두고 suggestedNotification만 덧붙인다(하위호환).
    return { ...result, suggestedNotification: await this.buildSuggestion(repair, dto.newStatus) };
  }

  private async buildSuggestion(
    repair: { id: string; customerId: string; orderId: string | null },
    newStatus: string,
  ) {
    if (!NOTIFY_STATUSES.includes(newStatus)) return null;
    const templateId = await this.suggestions.templateIdForTrigger(`REPAIR:${newStatus}`);
    if (!templateId) return null;
    return this.suggestions.build({
      templateId,
      customerId: repair.customerId,
      orderId: repair.orderId,
      // 같은 수선의 같은 상태는 한 번만 발송된다.
      triggerKey: `repair:${repair.id}:${newStatus}`,
    });
  }

  /**
   * 방문 수거·배송이면 주소가 있어야 한다 (개발설계서 05 G-07).
   * 접수·출고 방식이 없으면(기존 데이터·미입력) 검증하지 않는다.
   */
  private assertMethodAddresses(dto: {
    receiptMethod?: string;
    releaseMethod?: string;
    pickupAddress?: string;
    deliveryAddress?: string;
  }): void {
    const errors: FieldError[] = [];
    if (dto.receiptMethod === 'PICKUP' && !dto.pickupAddress?.trim())
      errors.push({ field: 'pickupAddress', reason: 'REQUIRED_FOR_PICKUP' });
    if (dto.releaseMethod === 'DELIVERY' && !dto.deliveryAddress?.trim())
      errors.push({ field: 'deliveryAddress', reason: 'REQUIRED_FOR_DELIVERY' });
    if (errors.length > 0)
      throw new BusinessException('VALIDATION_ERROR', '방문 주소를 입력해 주세요.', errors);
  }

  private methodData(dto: {
    receiptMethod?: string;
    releaseMethod?: string;
    pickupAddress?: string;
    deliveryAddress?: string;
  }) {
    return {
      ...(dto.receiptMethod !== undefined ? { receiptMethod: dto.receiptMethod } : {}),
      ...(dto.releaseMethod !== undefined ? { releaseMethod: dto.releaseMethod } : {}),
      ...(dto.pickupAddress !== undefined ? { pickupAddress: dto.pickupAddress } : {}),
      ...(dto.deliveryAddress !== undefined ? { deliveryAddress: dto.deliveryAddress } : {}),
    };
  }

  private validateStatusTransition(current: string, next: string): void {
    const flow: readonly string[] = REPAIR_STATUS_FLOW;
    if (!flow.includes(next) && next !== CANCELLED)
      throw new BusinessException('VALIDATION_ERROR', `허용되지 않은 수선 상태 코드입니다: ${next}`, [
        { field: 'newStatus', reason: 'UNKNOWN_STATUS' },
      ]);
    if (current === CANCELLED)
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '취소된 수선 요청의 상태는 변경할 수 없습니다.',
        undefined,
        { current, next },
      );
    if (next === CANCELLED) return;
    if (flow.indexOf(next) !== flow.indexOf(current) + 1)
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        `수선 상태를 ${current}에서 ${next}(으)로 변경할 수 없습니다.`,
        undefined,
        { current, next, allowed: flow[flow.indexOf(current) + 1] ?? null },
      );
  }

  /**
   * 수선 유형별 연결 검증 (통합설계서 §12.1 수선 대상·연결 방식):
   * - CUSTOM_DURING / AFTER_SALE → orderItemId 또는 componentId 필수, 렌탈 연결 불가
   * - RENTAL_PRE / RENTAL_POST → rentalInventoryItemId 필수, 맞춤 연결 불가
   * - GENERAL → 고객만 연결(대상 설명은 description), 다른 연결 불가
   */
  private async resolveLinks(dto: CreateRepairDto): Promise<{
    orderId?: string;
    orderItemId?: string;
    componentId?: string;
    rentalInventoryItemId?: string;
  }> {
    const invalid = (message: string, fieldErrors?: FieldError[]) =>
      new BusinessException('VALIDATION_ERROR', message, fieldErrors);

    if (CUSTOM_TYPES.includes(dto.repairType)) {
      if (!dto.orderItemId && !dto.componentId)
        throw invalid('맞춤 수선은 주문 품목 또는 구성품 연결이 필요합니다.', [
          { field: 'orderItemId', reason: 'REQUIRED_FOR_CUSTOM' },
        ]);
      if (dto.rentalInventoryItemId)
        throw invalid('맞춤 수선에는 렌탈 실물을 연결할 수 없습니다.', [
          { field: 'rentalInventoryItemId', reason: 'NOT_ALLOWED_FOR_CUSTOM' },
        ]);

      if (dto.componentId) {
        const component = await this.prisma.orderItemComponent.findUnique({
          where: { id: dto.componentId },
          include: { orderItem: { select: { id: true, orderId: true } } },
        });
        if (!component)
          throw invalid('연결할 구성품이 없습니다.', [{ field: 'componentId', reason: 'NOT_FOUND' }]);
        if (dto.orderItemId && dto.orderItemId !== component.orderItemId)
          throw invalid('구성품이 지정한 주문 품목에 속하지 않습니다.', [
            { field: 'componentId', reason: 'NOT_IN_ORDER_ITEM' },
          ]);
        return {
          componentId: component.id,
          orderItemId: component.orderItemId,
          orderId: component.orderItem.orderId,
        };
      }

      const item = await this.prisma.orderItem.findUnique({ where: { id: dto.orderItemId! } });
      if (!item)
        throw invalid('연결할 주문 품목이 없습니다.', [{ field: 'orderItemId', reason: 'NOT_FOUND' }]);
      return { orderItemId: item.id, orderId: item.orderId };
    }

    if (RENTAL_TYPES.includes(dto.repairType)) {
      if (!dto.rentalInventoryItemId)
        throw invalid('렌탈 수선은 렌탈 실물 연결이 필요합니다.', [
          { field: 'rentalInventoryItemId', reason: 'REQUIRED_FOR_RENTAL' },
        ]);
      if (dto.orderItemId || dto.componentId)
        throw invalid('렌탈 수선에는 맞춤 품목·구성품을 연결할 수 없습니다.', [
          { field: 'orderItemId', reason: 'NOT_ALLOWED_FOR_RENTAL' },
        ]);
      const rentalItem = await this.prisma.rentalInventoryItem.findUnique({
        where: { id: dto.rentalInventoryItemId },
      });
      if (!rentalItem)
        throw invalid('연결할 렌탈 실물이 없습니다.', [
          { field: 'rentalInventoryItemId', reason: 'NOT_FOUND' },
        ]);
      return { rentalInventoryItemId: rentalItem.id };
    }

    // GENERAL: 고객만 연결하고 대상 설명(description)을 입력한다.
    if (dto.orderItemId || dto.componentId || dto.rentalInventoryItemId)
      throw invalid('일반 수선은 고객 외 대상을 연결할 수 없습니다.', [
        { field: 'repairType', reason: 'GENERAL_MUST_NOT_LINK' },
      ]);
    return {};
  }
}
