import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { toDateOrUndefined as toDate, todayAsDbDate as today } from '../../common/date';
import { AuthUser } from '../../common/decorators';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { FilesService, UploadedMulterFile } from '../files/files.service';
import { buildWorkOrderView, workOrderStatusSelect } from '../work-orders/work-order-status';
import { applyComponentStatus, applyItemStatus } from './item-status';
import {
  AGGREGATE_ONLY_STATUSES,
  CANCELLED,
  COMPONENT_STATUS_FLOW,
  computeAggregateStatus,
  ITEM_STATUS_FLOW,
  validateTransition,
} from './production-status';
import { buildFittingSheetExcel } from './fitting-sheet-excel';
import { FITTING_FILE_PURPOSE, fittingCoverage } from './fitting.constants';
import { prepStatusFor } from './prep-status';
import {
  CreateFittingDto,
  CreateProductionEventDto,
  ProductionItemsQueryDto,
  ReceiveComponentDto,
  ReleaseComponentDto,
  UndoStageDto,
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

// 날짜 헬퍼는 common/date.ts가 단일 출처다 — '오늘'은 매장(로컬) 달력 기준이다.

/**
 * 구성품 단계 처리를 되돌릴 때 쓰는 표 — `그 단계가 남긴 상태 → 직전 상태`.
 * from에 없는 구성품은 그 단계로 처리된 적이 없으므로 건드리지 않는다.
 */
const COMPONENT_UNDO: Record<
  string,
  { from: string[]; to: string; clear?: 'IN' | 'OUT'; itemFallback: string }
> = {
  COMPONENT_BASTING: {
    from: ['BASTING_RECEIVED'],
    to: 'PRODUCTION_IN_PROGRESS',
    itemFallback: 'PRODUCTION_IN_PROGRESS',
  },
  COMPONENT_RECEIVE: {
    from: ['RECEIVED'],
    to: 'PRODUCTION_COMPLETED',
    clear: 'IN',
    itemFallback: 'PRODUCTION_COMPLETED',
  },
  COMPONENT_RELEASE: {
    from: ['RELEASED'],
    to: 'RECEIVED',
    clear: 'OUT',
    itemFallback: 'RECEIVED',
  },
};

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
    private readonly files: FilesService,
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
      // 상태 갱신·이력 생성은 단일 기록자(applyItemStatus)로 — CANCELLED 진입은 검증이 이미 거부했다.
      const written = await applyItemStatus(tx, {
        orderItemId,
        from: item.status,
        to: dto.newStatus,
        eventDate: toDate(dto.eventDate) ?? today(),
        expectedDate: toDate(dto.expectedDate),
        notes: mergeNotes(dto.notes, dto.reason),
        actorId: actor.id,
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
      // 응답은 기존과 같은 이벤트 뷰 모양을 유지한다 (written은 동일 상태 재설정이 아니므로 항상 있다).
      return tx.productionEvent.findUniqueOrThrow({
        where: { id: written!.eventId },
        select: EVENT_SELECT,
      });
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
    const result = await this.prisma.$transaction(async (tx) => {
      // 상태 갱신·이력 생성은 단일 기록자(applyComponentStatus)로.
      const written = await applyComponentStatus(tx, {
        componentId: component.id,
        orderItemId: component.orderItemId,
        from: component.status,
        to: change.newStatus,
        eventType: change.eventType,
        eventDate: change.eventDate,
        expectedDate: change.expectedDate,
        notes: change.notes,
        data: change.componentData,
        actorId: actor.id,
      });
      // 검증이 동일 상태 재설정을 이미 거부하므로 written은 항상 있다.
      const event = await tx.productionEvent.findUniqueOrThrow({
        where: { id: written!.eventId },
        select: EVENT_SELECT,
      });
      const updated = await tx.orderItemComponent.findUniqueOrThrow({
        where: { id: component.id },
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
    // D7 일원화(설계서 02 §8·§10.3 #4): 완성복 입고 고객 연락 제안은 진행(journey)
    // PRODUCT_RECEIVED 단계 진입에서만 만든다. production 쪽 자동 제안은 제거해 이중 노출을 없앤다.
    // 응답 필드는 하위호환을 위해 유지하되 항상 null(연락은 진행 카드에서).
    return { ...result, suggestedNotification: null };
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

    await applyItemStatus(tx, {
      orderItemId,
      from: item.status,
      to: computed,
      eventType: 'ITEM_STATUS_AGGREGATED',
      eventDate,
      notes: '구성품 상태 집계에 따른 품목 상태 갱신',
      actorId: actor.id,
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
  // 단계 처리 취소 (오조작 정정)
  // ---------------------------------------------------------------------------

  /**
   * 그 단계가 만든 제작 기록만 되돌린다 (2026-08-05 현업 확정).
   *
   * 업무를 되돌리는 기능이 아니다 — 담당자가 화면에서 잘못 누른 것을 없던 일로 만드는 것이다.
   * 그래서 사유를 묻지 않고, 되돌리는 범위도 그 단계가 찍은 것(품목 상태·구성품 상태·입출고
   * 일자)으로 한정한다. 공장에 이미 나간 일을 되돌리는 것은 오프라인에서 처리한다.
   */
  async undoStage(orderItemId: string, dto: UndoStageDto, actor: AuthUser) {
    const item = await this.prisma.orderItem.findUnique({
      where: { id: orderItemId },
      include: { components: { select: { id: true, status: true, active: true } } },
    });
    if (!item) throw new NotFoundException('주문 품목이 없습니다.');
    if (item.status === CANCELLED)
      throw new BusinessException('INVALID_STATUS_TRANSITION', '취소된 품목은 되돌릴 수 없습니다.');

    const eventDate = today();
    await this.prisma.$transaction(async (tx) => {
      if (dto.effect === 'ITEM_REQUEST' || dto.effect === 'ITEM_FITTING') {
        // 품목 단위로 찍은 단계 — 그 단계 직전 상태로 내린다.
        const target =
          dto.effect === 'ITEM_REQUEST'
            ? await prepStatusFor(tx, orderItemId)
            : item.components.some((c) => c.active && c.status === 'BASTING_RECEIVED')
              ? 'BASTING_RECEIVED'
              : 'PRODUCTION_REQUESTED';
        await this.setItemStatus(tx, orderItemId, item.status, target, eventDate, actor);
        return;
      }

      const undo = COMPONENT_UNDO[dto.effect];
      const targets = item.components.filter(
        (c) =>
          c.active &&
          c.status !== CANCELLED &&
          (dto.componentId ? c.id === dto.componentId : true) &&
          undo.from.includes(c.status),
      );
      for (const c of targets) {
        await applyComponentStatus(tx, {
          componentId: c.id,
          orderItemId,
          from: c.status,
          to: undo.to,
          eventDate,
          notes: '단계 처리 취소(잘못 누름)',
          data: {
            ...(undo.clear === 'IN' ? { actualInboundAt: null } : {}),
            ...(undo.clear === 'OUT' ? { actualOutboundAt: null } : {}),
          },
          actorId: actor.id,
        });
      }
      if (targets.length === 0) return;

      // 품목 상태는 구성품 집계를 따른다 — 집계가 안 나오면 그 단계 직전 상태로 내린다.
      const after = await tx.orderItem.findUniqueOrThrow({
        where: { id: orderItemId },
        include: { components: { select: { status: true, active: true } } },
      });
      const computed = computeAggregateStatus(after.components) ?? undo.itemFallback;
      await this.setItemStatus(tx, orderItemId, after.status, computed, eventDate, actor);
    });

    return this.prisma.orderItem.findUniqueOrThrow({
      where: { id: orderItemId },
      select: { id: true, status: true },
    });
  }

  /** 품목 상태를 지정 상태로 되돌리고 이력·감사로그를 남긴다 (취소 전용 — 검증은 호출부에서 끝냈다). */
  private async setItemStatus(
    tx: Prisma.TransactionClient,
    orderItemId: string,
    from: string,
    to: string,
    eventDate: Date,
    actor: AuthUser,
  ): Promise<void> {
    if (from === to) return;
    await applyItemStatus(tx, {
      orderItemId,
      from,
      to,
      eventDate,
      notes: '단계 처리 취소(잘못 누름)',
      actorId: actor.id,
    });
    await this.audit.log(
      {
        userId: actor.id,
        action: 'STATUS_CHANGE',
        entityType: 'ORDER_ITEM',
        entityId: orderItemId,
        before: { status: from },
        after: { status: to },
        reason: '단계 처리 취소',
      },
      tx,
    );
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
    /*
      제작 관리에 뜨는 품목 (2026-08-05 현업 확정).

      1) **주문이 있으면 뜬다.** 전에는 `계약 상태 = 계약완료`로 걸렀는데, 계약을 [수정하기]로
         되돌리면 작성중이 되어 **제작 중인 옷이 화면에서 통째로 사라졌다.** 계약서를 고치는 것과
         공장 일은 따로 돈다 — 되돌려도 입고·출고는 그대로 찍어야 한다. 주문은 계약완료로만
         생기므로, 주문이 있다는 것 자체가 "한 번은 계약이 성립했다"는 뜻이다.
      2) **준비가 끝난 것만 뜬다.** 준비 중(옵션대기·채촌대기)인 품목은 제작이 할 일이 없다.
         준비 진행은 이미 품목 상태에 반영되므로(prep-status) 따로 계산하지 않고 상태로 거른다.
      3) 진행(journey)이 없는 주문은 단계를 세울 수 없어 빈 껍데기로 보인다 — 계속 제외한다.
    */
    const READY_FROM = ITEM_STATUS_FLOW.indexOf('READY_TO_ORDER');
    // 흐름 밖 종결 상태 COMPLETED(렌탈 반납 완료)도 목록에 남긴다 — 반납이 끝난 계약이
    // 목록에서 사라지지 않고 '완료'로 보이게 한다 (방안 A, 2026-08-12).
    const preparedStatuses = [...ITEM_STATUS_FLOW.slice(READY_FROM), 'COMPLETED'] as string[];
    /*
      계약 상세(includePrep)는 준비 중인 품목까지 내려준다 — 진행 단계 대상(취소만 제외)과
      짝을 맞춰 준비 카드가 미완 품목을 빠뜨리지 않게 한다.

      전역 목록은 **계약 단위**로 거른다 (2026-08-13 현업 확정, 방안 A). 예전엔 품목 상태로 걸러
      준비 지난 품목만 내려줬는데, 그러면 한 계약의 맞춤·렌탈 중 한 트랙이 아직 준비 중이면 그
      트랙이 통째로 사라져 리스트가 계약을 반쪽만 보여줬다(한지민: 렌탈 2품목이 준비라 안 보임).
      그래서 "준비를 지난 품목이 하나라도 있는 계약"이면 그 계약의 **전 품목(취소 제외)** 을 내려
      상세와 같은 구성으로 보이게 한다. 어떤 계약이 뜨는지(제작 시작한 계약만)는 그대로다.
    */
    const startedContract: Prisma.OrderItemWhereInput['order'] = {
      contract: { orders: { some: { items: { some: { status: { in: preparedStatuses } } } } } },
    };
    const statusWhere: Prisma.OrderItemWhereInput = query.status
      ? { status: query.status }
      : { status: { not: CANCELLED } };
    const where: Prisma.OrderItemWhereInput = {
      ...statusWhere,
      order: {
        ...(query.contractId ? { contractId: query.contractId } : {}),
        journeys: { some: { status: { not: 'CANCELLED' } } },
        // 전역 목록만 계약 단위 게이트를 건다. 상세(includePrep)·특정상태 조회는 그대로.
        ...(query.includePrep || query.status ? {} : startedContract),
      },
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
              contractId: true,
              contract: {
                select: {
                  contractNo: true,
                  // 목록의 계약 구분 열 — 계약 목록과 같은 값을 보여준다.
                  contractType: { select: { name: true } },
                  customer: { select: { id: true, name: true, phone: true } },
                },
              },
            },
          },
          components: { select: COMPONENT_SELECT, orderBy: { sequenceNo: 'asc' } },
          // 작업지시서 상태를 같은 행에 얹기 위한 판정 소스 (work-orders와 단일 출처 공유)
          ...workOrderStatusSelect,
        },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.size,
      }),
    ]);
    // workOrder 관계를 판정 뷰로 덮어쓴다(계산 키가 우선). 잔여 판정 배열은 소량이라 그대로 둔다.
    const rows = items.map((item) => ({ ...item, workOrder: buildWorkOrderView(item) }));
    return new Paginated(rows, query.page, query.size, totalElements);
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
              areaCode: adj.areaCode ?? 'ETC',
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
    // 4대 표준 항목 기재 여부는 막지 않고 알려만 준다 (개발설계서 05 G-04).
    return { ...session, coverage: fittingCoverage(session.adjustments) };
  }

  async listFittings(orderItemId: string) {
    const item = await this.prisma.orderItem.findUnique({ where: { id: orderItemId }, select: { id: true } });
    if (!item) throw new NotFoundException('주문 품목이 없습니다.');
    const sessions = await this.prisma.fittingSession.findMany({
      where: { orderItemId },
      include: {
        adjustments: { include: { component: { select: { id: true, componentType: true } } } },
      },
      orderBy: [{ fittingDate: 'desc' }, { createdAt: 'desc' }],
    });
    return sessions.map((s) => ({ ...s, coverage: fittingCoverage(s.adjustments) }));
  }

  /**
   * 가봉 수정지시서 Excel (개발설계서 05 G-04).
   * 공장 전달은 이메일 수동 발송이므로 시스템은 첨부할 문서만 만든다.
   * 파일로 보관하지 않고 요청 시 즉시 생성해 흘려보낸다.
   */
  async buildFittingSheet(fittingId: string, actor: AuthUser) {
    const session = await this.prisma.fittingSession.findUnique({
      where: { id: fittingId },
      include: {
        adjustments: {
          include: { component: { select: { id: true, componentType: true, sequenceNo: true } } },
        },
        orderItem: {
          include: {
            order: { include: { contract: { include: { customer: true } } } },
          },
        },
      },
    });
    if (!session) throw new NotFoundException('가봉 기록이 없습니다.');

    const buffer = await buildFittingSheetExcel({
      customerName: session.orderItem.order.contract.customer.name,
      orderNo: session.orderItem.order.orderNo,
      itemLabel: session.orderItem.displayName,
      fittingDate: session.fittingDate,
      nextAppointmentDate: session.nextAppointmentDate,
      notes: session.notes,
      adjustments: session.adjustments.map((a) => ({
        areaCode: a.areaCode,
        area: a.area,
        instruction: a.instruction,
        componentType: a.component?.componentType ?? null,
        componentSequenceNo: a.component?.sequenceNo ?? null,
      })),
    });

    await this.audit.log({
      userId: actor.id,
      action: 'EXPORT',
      entityType: 'FITTING_SESSION',
      entityId: fittingId,
      // 세션이 나중에 지워져도 "누구의 어떤 품목을 출력했나"는 남아야 한다.
      after: {
        customerName: session.orderItem.order.contract.customer.name,
        orderNo: session.orderItem.order.orderNo,
        displayName: session.orderItem.displayName,
        fittingDate: session.fittingDate,
      },
    });

    const fileName = `fitting-${session.orderItem.order.orderNo}-${session.fittingDate
      .toISOString()
      .slice(0, 10)}.xlsx`;
    return { buffer, fileName };
  }

  // ---------------------------------------------------------------------------
  // 가봉 첨부 파일 (설계서 06 §5.4) — 공장에 보낸 가봉 작업지시서 보관용. EntityFile 재사용.
  // 현업 확정(2026-07-28): 업로드 값을 수치에 반영하지 않는다. "이 파일을 공장에 보냈다"를
  // 알아볼 수 있으면 되는 보관 목적이므로 purpose는 FACTORY_SENT다.
  // ---------------------------------------------------------------------------

  /** 가봉 세션에 파일 첨부. File 저장(FilesService 재사용) + EntityFile(FITTING_SESSION/FACTORY_SENT) 연결. */
  async uploadFittingFile(fittingId: string, file: UploadedMulterFile | undefined, actor: AuthUser) {
    const identity = await this.assertFittingExists(fittingId);
    const uploaded = await this.files.upload(file, actor);
    await this.prisma.entityFile.create({
      data: {
        id: randomUUID(),
        fileId: uploaded.id,
        entityType: 'FITTING_SESSION',
        entityId: fittingId,
        purpose: FITTING_FILE_PURPOSE,
      },
    });
    await this.audit.log({
      userId: actor.id,
      // 세션 생성(CREATE)과 같은 코드를 쓰면 감사로그에서 "가봉 세션 생성"과 구분되지 않는다.
      action: 'UPLOAD',
      entityType: 'FITTING_SESSION',
      entityId: fittingId,
      after: {
        ...identity,
        fileId: uploaded.id,
        purpose: FITTING_FILE_PURPOSE,
        originalName: uploaded.originalName,
      },
    });
    return { ...uploaded, purpose: FITTING_FILE_PURPOSE };
  }

  /** 가봉 세션 첨부 목록. */
  async listFittingFiles(fittingId: string) {
    await this.assertFittingExists(fittingId);
    const entityFiles = await this.prisma.entityFile.findMany({
      where: { entityType: 'FITTING_SESSION', entityId: fittingId },
      orderBy: { createdAt: 'asc' },
      include: { file: true },
    });
    return entityFiles.map((ef) => ({
      id: ef.file.id,
      entityFileId: ef.id,
      purpose: ef.purpose,
      originalName: ef.file.originalName,
      mimeType: ef.file.mimeType,
      sizeBytes: Number(ef.file.sizeBytes),
      checksumSha256: ef.file.checksumSha256,
      downloadUrl: `/api/v1/files/${ef.file.id}`,
      createdAt: ef.createdAt,
    }));
  }

  /** 가봉 세션 첨부 제거. EntityFile 링크를 먼저 끊고 미참조 File을 삭제한다(FilesService.remove). */
  async removeFittingFile(fittingId: string, fileId: string, actor: AuthUser) {
    const link = await this.prisma.entityFile.findFirst({
      where: { entityType: 'FITTING_SESSION', entityId: fittingId, fileId },
    });
    if (!link) throw new NotFoundException('가봉 첨부 파일이 없습니다.');
    const identity = await this.assertFittingExists(fittingId);
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: { originalName: true },
    });
    // 참조 중인 File은 삭제되지 않으므로(FilesService.remove 규칙) 링크를 먼저 제거한다.
    await this.prisma.entityFile.delete({ where: { id: link.id } });
    await this.files.remove(fileId, actor);
    await this.audit.log({
      userId: actor.id,
      action: 'DELETE',
      entityType: 'FITTING_SESSION',
      entityId: fittingId,
      // 파일은 곧 지워진다 — 이름을 로그에 남겨야 "무엇을 뗐는지" 알 수 있다.
      before: {
        ...identity,
        fileId,
        purpose: link.purpose,
        originalName: file?.originalName ?? null,
      },
    });
    return { id: fileId, deleted: true };
  }

  /**
   * 가봉 세션 존재 확인 + 감사로그용 식별 정보.
   * 파일 첨부·삭제 로그에 세션 UUID만 남기면 나중에 세션이 지워졌을 때
   * "누구의 어떤 품목에 붙인 파일인지" 되짚을 수 없다.
   */
  private async assertFittingExists(fittingId: string): Promise<Record<string, unknown>> {
    const session = await this.prisma.fittingSession.findUnique({
      where: { id: fittingId },
      select: {
        id: true,
        orderItem: {
          select: {
            displayName: true,
            order: {
              select: { orderNo: true, contract: { select: { customer: { select: { name: true } } } } },
            },
          },
        },
      },
    });
    if (!session) throw new NotFoundException('가봉 기록이 없습니다.');
    return {
      customerName: session.orderItem.order.contract.customer.name,
      orderNo: session.orderItem.order.orderNo,
      displayName: session.orderItem.displayName,
    };
  }

  private async findComponent(componentId: string) {
    const component = await this.prisma.orderItemComponent.findUnique({ where: { id: componentId } });
    if (!component) throw new NotFoundException('구성품이 없습니다.');
    return component;
  }
}
