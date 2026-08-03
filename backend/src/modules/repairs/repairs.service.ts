import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException, FieldError } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JourneysService } from '../journeys/journeys.service';
import { NotificationSuggestionService } from '../notifications/notification-suggestion.service';
import {
  CreateRepairDto,
  CreateRepairStatusEventDto,
  ListRepairsQueryDto,
  RepairItemDto,
  RepairProgressDto,
  UpdateRepairDto,
} from './repairs.dto';

/**
 * 수선 상태 순서 (접수→수선 요청→수선 입고→고객 연락→출고 완료).
 * 상태는 "그 단계를 끝낸 시점"을 뜻한다 — 접수 등록이 곧 접수 완료다.
 * '수선 중'(IN_PROGRESS)은 담당자가 따로 누를 일이 없어 2026-07-29 흐름에서 뺐다
 * (업무 버튼 수선요청 완료·입고 완료·고객요청·출고 완료와 1:1로 맞춘다).
 */
export const REPAIR_STATUS_FLOW = [
  'RECEIVED',
  'REQUESTED',
  'RETURNED_TO_SHOP',
  'CUSTOMER_NOTIFIED',
  'RELEASED',
] as const;

const CANCELLED = 'CANCELLED';

/**
 * 유닛(벌) 하나의 진행 — 대기 → 입고 완료 → 출고 완료.
 * 수선요청은 줄 단위(RepairRequestItem.requestedAt)라 여기 없다.
 */
export const REPAIR_UNIT_STATUS_FLOW = ['PENDING', 'RETURNED', 'RELEASED'] as const;
export type RepairUnitStatus = (typeof REPAIR_UNIT_STATUS_FLOW)[number];

/**
 * 담당자가 손으로 누르는 건 단위 전이는 고객 연락뿐이다(되돌리기 포함).
 * 나머지 단계는 줄·유닛 진행에서 계산된다 — rollupStatus 참고.
 */
const MANUAL_STATUSES = ['CUSTOMER_NOTIFIED', 'RETURNED_TO_SHOP'];

const REPAIR_SUMMARY_SELECT = {
  id: true,
  repairType: true,
  requestDate: true,
  dueDate: true,
  status: true,
  description: true,
  notes: true,
  items: {
    select: {
      id: true,
      targetProduct: true,
      quantity: true,
      sequenceNo: true,
      requestedAt: true,
      units: {
        select: { id: true, unitNo: true, status: true },
        orderBy: { unitNo: 'asc' },
      },
    },
    orderBy: { sequenceNo: 'asc' },
  },
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
  // 목록에도 이력을 함께 준다 — 품목 표가 벌마다 "언제·누가" 처리했는지 보여주는데,
  // 목록(고객 업무 처리)과 상세가 같은 표를 쓰므로 목록에서만 날짜가 비면 안 된다.
  statusEvents: {
    select: {
      id: true,
      repairRequestItemId: true,
      repairRequestItemUnitId: true,
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

const REPAIR_DETAIL_SELECT = REPAIR_SUMMARY_SELECT;

/** 롤업 판정에 필요한 최소 형태 */
interface RollupItem {
  requestedAt: Date | null;
  units: { status: string }[];
}

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
    private readonly journeys: JourneysService,
    private readonly suggestions: NotificationSuggestionService,
  ) {}

  async list(query: ListRepairsQueryDto) {
    const where: Prisma.RepairRequestWhereInput = {
      // 상태를 지정하면 그대로, 아니면 excludeReleased일 때 출고완료만 뺀다.
      ...(query.status
        ? { status: query.status }
        : query.excludeReleased
          ? { status: { not: 'RELEASED' } }
          : {}),
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
   * 수선 접수: 대상 품목·방식 검증 후 접수(RECEIVED) 상태로 생성한다 (통합설계서 §12.1).
   * 줄마다 수량만큼 유닛(벌)을 함께 만든다 — 입고·출고를 벌 단위로 누르기 때문이다.
   */
  async create(dto: CreateRepairDto, actor: AuthUser) {
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer)
      throw new BusinessException('CUSTOMER_NOT_FOUND', '고객이 없습니다.', [
        { field: 'customerId', reason: 'NOT_FOUND' },
      ]);

    this.assertItems(dto.items);
    this.assertMethodAddresses(dto);

    const repair = await this.prisma.$transaction(async (tx) => {
      const requestDate = new Date(dto.requestDate);
      const created = await tx.repairRequest.create({
        data: {
          id: randomUUID(),
          customerId: dto.customerId,
          items: { create: this.itemRows(dto.items) },
          repairType: dto.repairType,
          requestDate,
          dueDate: toDate(dto.dueDate),
          status: 'RECEIVED',
          description: dto.description,
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
      // 수선 접수 = REPAIR 진행 트랙 자동생성(REPAIR_RECEIVED 자동완료). 멱등(설계서 02 §7.2·§9.2).
      await this.journeys.createRepairJourney(tx, dto.customerId, created.id, actor);
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
    // 품목도 기존 줄과 합쳐 판정한다 — 빈 목록으로 되돌릴 수 없다.
    this.assertItems(dto.items ?? before.items);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.repairRequest.update({
        where: { id },
        data: {
          ...(dto.dueDate !== undefined ? { dueDate: toDate(dto.dueDate) } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...this.methodData(dto),
        },
      });
      if (dto.items !== undefined) await this.syncItems(tx, id, before.items, dto.items);
      return tx.repairRequest.findUniqueOrThrow({ where: { id }, select: REPAIR_DETAIL_SELECT });
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
   * 접수 줄 재구성 — 진행이 시작된 줄은 지키고 나머지만 맞춘다.
   * 예전에는 줄을 통째로 지우고 다시 만들었는데, 이제 줄·유닛에 진행 기록이 붙어 그러면 날아간다.
   *  - 진행 시작(수선요청 완료 또는 대기가 아닌 유닛이 있음) → 삭제·품목 변경 불가
   *  - 수량은 늘리기 자유, 줄이기는 대기 상태로 남은 벌만큼만
   * 줄은 화면 입력 순서(순번)로 짝짓는다 — 순서를 바꾸면 그 자리의 줄을 고친 것으로 본다.
   */
  private async syncItems(
    tx: Prisma.TransactionClient,
    repairId: string,
    before: {
      id: string;
      targetProduct: string;
      sequenceNo: number;
      requestedAt: Date | null;
      units: { id: string; unitNo: number; status: string }[];
    }[],
    next: RepairItemDto[],
  ): Promise<void> {
    for (let index = 0; index < Math.max(before.length, next.length); index += 1) {
      const old = before[index];
      const row = next[index];
      const started = old ? this.isStarted(old) : false;

      if (old && !row) {
        if (started) throw this.itemInProgress(old.targetProduct, '삭제');
        await tx.repairRequestItem.delete({ where: { id: old.id } });
        continue;
      }
      if (!old && row) {
        await tx.repairRequestItem.create({
          data: {
            id: randomUUID(),
            repairRequestId: repairId,
            targetProduct: row.targetProduct,
            quantity: row.quantity,
            sequenceNo: index + 1,
            units: { create: this.unitRows(row.quantity, 1) },
          },
        });
        continue;
      }
      if (!old || !row) continue;

      if (started && row.targetProduct !== old.targetProduct)
        throw this.itemInProgress(old.targetProduct, '변경');
      // 이미 입고·출고된 벌은 줄일 수 없다 — 그만큼은 물건이 실제로 움직인 기록이다.
      const moved = old.units.filter((unit) => unit.status !== 'PENDING').length;
      if (row.quantity < moved) throw this.itemInProgress(old.targetProduct, '수량 축소');

      await tx.repairRequestItem.update({
        where: { id: old.id },
        data: { targetProduct: row.targetProduct, quantity: row.quantity, sequenceNo: index + 1 },
      });
      const delta = row.quantity - old.units.length;
      if (delta > 0) {
        const maxUnitNo = old.units.reduce((max, unit) => Math.max(max, unit.unitNo), 0);
        await tx.repairRequestItemUnit.createMany({
          data: this.unitRows(delta, maxUnitNo + 1).map((unit) => ({
            ...unit,
            repairRequestItemId: old.id,
          })),
        });
      } else if (delta < 0) {
        // 뒤 번호부터, 아직 대기인 벌만 뺀다.
        const removable = old.units
          .filter((unit) => unit.status === 'PENDING')
          .sort((a, b) => b.unitNo - a.unitNo)
          .slice(0, -delta);
        await tx.repairRequestItemUnit.deleteMany({
          where: { id: { in: removable.map((unit) => unit.id) } },
        });
      }
    }
  }

  private isStarted(item: { requestedAt: Date | null; units: { status: string }[] }): boolean {
    return !!item.requestedAt || item.units.some((unit) => unit.status !== 'PENDING');
  }

  private itemInProgress(targetProduct: string, action: string): BusinessException {
    return new BusinessException(
      'REPAIR_ITEM_IN_PROGRESS',
      `진행이 시작된 품목(${targetProduct})은 ${action}할 수 없습니다.`,
      [{ field: 'items', reason: 'IN_PROGRESS' }],
    );
  }

  /**
   * 수선요청 완료(줄 단위) — 그 줄을 수선집에 보냈다는 기록. 상의 2벌은 한 번에 나간다.
   */
  async requestItem(repairId: string, itemId: string, dto: RepairProgressDto, actor: AuthUser) {
    const repair = await this.loadForProgress(repairId);
    const item = repair.items.find((row) => row.id === itemId);
    if (!item) throw new NotFoundException('수선 대상 품목이 없습니다.');
    if (item.requestedAt)
      throw new BusinessException('INVALID_STATUS_TRANSITION', '이미 수선요청을 끝낸 품목입니다.');

    const eventDate = toDate(dto.eventDate) ?? today();
    await this.prisma.$transaction(async (tx) => {
      await tx.repairRequestItem.update({ where: { id: itemId }, data: { requestedAt: eventDate } });
      await this.recordEvent(tx, {
        repairId,
        itemId,
        previousStatus: 'RECEIVED',
        newStatus: 'REQUESTED',
        eventDate,
        notes: dto.notes,
        actor,
      });
      await this.rollup(tx, repairId, eventDate, actor);
    });
    return this.get(repairId);
  }

  /** 수선요청 되돌리기 — 아직 아무 벌도 들어오지 않은 줄만 가능하다. */
  async revertItemRequest(repairId: string, itemId: string, actor: AuthUser) {
    const repair = await this.loadForProgress(repairId);
    const item = repair.items.find((row) => row.id === itemId);
    if (!item) throw new NotFoundException('수선 대상 품목이 없습니다.');
    if (!item.requestedAt)
      throw new BusinessException('INVALID_STATUS_TRANSITION', '아직 수선요청 전 품목입니다.');
    if (item.units.some((unit) => unit.status !== 'PENDING'))
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '이미 입고된 벌이 있어 수선요청을 되돌릴 수 없습니다.',
      );

    const eventDate = today();
    await this.prisma.$transaction(async (tx) => {
      await tx.repairRequestItem.update({ where: { id: itemId }, data: { requestedAt: null } });
      await this.recordEvent(tx, {
        repairId,
        itemId,
        previousStatus: 'REQUESTED',
        newStatus: 'RECEIVED',
        eventDate,
        notes: '수선요청 되돌림',
        actor,
      });
      await this.rollup(tx, repairId, eventDate, actor);
    });
    return this.get(repairId);
  }

  /**
   * 벌 하나를 다음 칸으로 — 입고(RETURNED) 또는 출고(RELEASED).
   * 입고는 그 줄의 수선요청이 끝난 뒤에만, 출고는 그 벌이 입고된 뒤에만 누를 수 있다.
   * 출고는 건 전체가 아니라 벌 단위라 먼저 찾아가는 손님에게 그 벌만 내줄 수 있다(부분 출고).
   */
  async advanceUnit(
    repairId: string,
    unitId: string,
    toStatus: RepairUnitStatus,
    dto: RepairProgressDto,
    actor: AuthUser,
  ) {
    const repair = await this.loadForProgress(repairId);
    const { item, unit } = this.findUnit(repair, unitId);
    const from = REPAIR_UNIT_STATUS_FLOW[REPAIR_UNIT_STATUS_FLOW.indexOf(toStatus) - 1];
    if (unit.status !== from)
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        toStatus === 'RETURNED' ? '이미 입고된 벌입니다.' : '입고된 벌만 출고할 수 있습니다.',
        undefined,
        { current: unit.status, next: toStatus },
      );
    if (toStatus === 'RETURNED' && !item.requestedAt)
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '수선요청을 먼저 끝낸 뒤 입고할 수 있습니다.',
      );

    const eventDate = toDate(dto.eventDate) ?? today();
    await this.prisma.$transaction(async (tx) => {
      await tx.repairRequestItemUnit.update({ where: { id: unitId }, data: { status: toStatus } });
      await this.recordEvent(tx, {
        repairId,
        unitId,
        previousStatus: unit.status,
        newStatus: toStatus,
        eventDate,
        notes: dto.notes,
        actor,
      });
      await this.rollup(tx, repairId, eventDate, actor);
    });
    return this.get(repairId);
  }

  /** 벌 하나를 한 칸 되돌린다 (출고 완료→입고 완료→대기). */
  async revertUnit(repairId: string, unitId: string, actor: AuthUser) {
    const repair = await this.loadForProgress(repairId);
    const { unit } = this.findUnit(repair, unitId);
    const prev = REPAIR_UNIT_STATUS_FLOW[REPAIR_UNIT_STATUS_FLOW.indexOf(unit.status as RepairUnitStatus) - 1];
    if (!prev)
      throw new BusinessException('INVALID_STATUS_TRANSITION', '더 되돌릴 단계가 없습니다.');

    const eventDate = today();
    await this.prisma.$transaction(async (tx) => {
      await tx.repairRequestItemUnit.update({ where: { id: unitId }, data: { status: prev } });
      await this.recordEvent(tx, {
        repairId,
        unitId,
        previousStatus: unit.status,
        newStatus: prev,
        eventDate,
        notes: unit.status === 'RELEASED' ? '출고 되돌림' : '입고 되돌림',
        actor,
      });
      await this.rollup(tx, repairId, eventDate, actor);
    });
    return this.get(repairId);
  }

  /** 진행 처리 공통 — 건이 있어야 하고, 취소된 건은 더 누를 수 없다. */
  private async loadForProgress(id: string) {
    const repair = await this.prisma.repairRequest.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        items: {
          select: {
            id: true,
            targetProduct: true,
            requestedAt: true,
            units: { select: { id: true, unitNo: true, status: true }, orderBy: { unitNo: 'asc' } },
          },
          orderBy: { sequenceNo: 'asc' },
        },
      },
    });
    if (!repair) throw new NotFoundException('수선 요청이 없습니다.');
    if (repair.status === CANCELLED)
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '취소된 수선 요청은 진행할 수 없습니다.',
      );
    return repair;
  }

  private findUnit(
    repair: Awaited<ReturnType<RepairsService['loadForProgress']>>,
    unitId: string,
  ) {
    for (const item of repair.items) {
      const unit = item.units.find((row) => row.id === unitId);
      if (unit) return { item, unit };
    }
    throw new NotFoundException('수선 대상 벌이 없습니다.');
  }

  private async recordEvent(
    tx: Prisma.TransactionClient,
    params: {
      repairId: string;
      itemId?: string;
      unitId?: string;
      previousStatus?: string | null;
      newStatus: string;
      eventDate: Date;
      notes?: string;
      actor: AuthUser;
    },
  ): Promise<void> {
    await tx.repairStatusEvent.create({
      data: {
        id: randomUUID(),
        repairRequestId: params.repairId,
        repairRequestItemId: params.itemId ?? null,
        repairRequestItemUnitId: params.unitId ?? null,
        previousStatus: params.previousStatus ?? null,
        newStatus: params.newStatus,
        eventDate: params.eventDate,
        notes: params.notes,
        actorId: params.actor.id,
      },
    });
  }

  /**
   * 건 상태를 줄·유닛 진행에서 다시 계산해 맞춘다.
   *
   * 담당자는 품목 버튼만 누르고 건 상태는 여기서 따라간다. 백엔드가 한 칸 전이만 허용하므로
   * (validateStatusTransition) 두 칸 이상 움직여야 하면 중간 단계도 순서대로 기록한다 —
   * 연락 없이 전량 출고된 경우가 그렇다.
   */
  private async rollup(
    tx: Prisma.TransactionClient,
    repairId: string,
    eventDate: Date,
    actor: AuthUser,
  ): Promise<void> {
    const repair = await tx.repairRequest.findUniqueOrThrow({
      where: { id: repairId },
      select: {
        status: true,
        items: { select: { requestedAt: true, units: { select: { status: true } } } },
      },
    });
    if (repair.status === CANCELLED) return;

    let target = this.rollupStatus(repair.items);
    // 고객 연락은 이미 일어난 사실이라 되돌리지 않는다 — 한 번 연락한 건은 전 벌 입고 자리에
    // 내려와도 '고객 연락'에 머문다(출고를 되돌려도 연락 버튼이 다시 뜨지 않게).
    if (target === 'RETURNED_TO_SHOP') {
      const notified = await tx.repairStatusEvent.findFirst({
        where: { repairRequestId: repairId, newStatus: 'CUSTOMER_NOTIFIED' },
        select: { id: true },
      });
      if (notified) target = 'CUSTOMER_NOTIFIED';
    }

    const flow: readonly string[] = REPAIR_STATUS_FLOW;
    let index = flow.indexOf(repair.status);
    const targetIndex = flow.indexOf(target);
    if (index < 0 || targetIndex < 0 || index === targetIndex) return;

    const step = targetIndex > index ? 1 : -1;
    while (index !== targetIndex) {
      await this.recordEvent(tx, {
        repairId,
        previousStatus: flow[index],
        newStatus: flow[index + step],
        eventDate,
        notes:
          step > 0 && flow[index + step] === 'CUSTOMER_NOTIFIED' && targetIndex > index + step
            ? '연락 전 출고로 자동 정리'
            : '품목 진행에 따라 자동 정리',
        actor,
      });
      index += step;
    }
    await tx.repairRequest.update({ where: { id: repairId }, data: { status: target } });
    await this.audit.log(
      {
        userId: actor.id,
        action: 'STATUS_CHANGE',
        entityType: 'REPAIR_REQUEST',
        entityId: repairId,
        before: { status: repair.status },
        after: { status: target },
      },
      tx,
    );
  }

  /**
   * 줄·유닛 진행 → 건 상태.
   * 전 벌 출고 = 수선 완료, 전 벌 입고 = 수선 입고, 전 줄 요청 = 수선 요청, 그 밖은 접수.
   * 일부만 출고된 상태는 '수선 입고'로 남는다 — 아직 안 찾아간 벌이 매장에 있다.
   */
  private rollupStatus(items: RollupItem[]): string {
    const units = items.flatMap((item) => item.units);
    // 품목 없이 접수된 옛 건은 계산할 근거가 없으므로 접수 상태로 둔다.
    if (!items.length || !units.length) return 'RECEIVED';
    if (units.every((unit) => unit.status === 'RELEASED')) return 'RELEASED';
    if (units.every((unit) => unit.status !== 'PENDING')) return 'RETURNED_TO_SHOP';
    if (items.every((item) => item.requestedAt)) return 'REQUESTED';
    return 'RECEIVED';
  }

  /**
   * 건 단위 상태 변경 — 이제 고객 연락(과 그 되돌리기)만 여기로 온다.
   * 수선요청·입고·출고는 품목 줄·벌에서 처리하고 건 상태는 rollup이 따라간다.
   */
  async createStatusEvent(id: string, dto: CreateRepairStatusEventDto, actor: AuthUser) {
    const repair = await this.prisma.repairRequest.findUnique({ where: { id } });
    if (!repair) throw new NotFoundException('수선 요청이 없습니다.');

    if (!MANUAL_STATUSES.includes(dto.newStatus))
      throw new BusinessException('VALIDATION_ERROR', '이 단계는 품목별로 처리합니다.', [
        { field: 'newStatus', reason: 'NOT_MANUAL' },
      ]);
    // 수선 입고는 전 벌이 들어와야 붙는 계산값이다 — 여기로는 연락 되돌리기로만 갈 수 있다.
    if (dto.newStatus === 'RETURNED_TO_SHOP' && repair.status !== 'CUSTOMER_NOTIFIED')
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '수선 입고는 품목별 입고 처리로 정해집니다.',
        undefined,
        { current: repair.status, next: dto.newStatus },
      );
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

    // '고객 연락'(CUSTOMER_NOTIFIED) 전이 시 연락 문구를 준비해 확인창 재료로 돌려준다.
    // 수선 메뉴에서 직접 연락할 수 있게 복원한 경로다(2026-07-30 현업 요청) — 담당자가
    // 확인창에서 [발송]을 눌러야 실제로 나가며, 카카오톡 연동이 없어도 CRM 연락 이력은 남는다.
    // 진행 카드(REPAIR_CHECKED_IN)와 같은 고정 문구를 공유하고, triggerKey로 중복 발송을 막는다.
    return {
      ...result,
      suggestedNotification: await this.buildNotifiedSuggestion(repair, dto.newStatus),
    };
  }

  /**
   * 수선 입고 안내(고객 연락) 문구 준비 (개발설계서 05 G-06).
   *
   * '고객 연락'(CUSTOMER_NOTIFIED)으로 전이할 때만 REPAIR_CHECKED_IN 진행 단계의 고정 문구를
   * 치환해 확인창 재료로 돌려준다. 실제 발송은 화면 확인창에서 별도 요청(POST /notifications/send)
   * 으로 이뤄지며, 그때 발송 이력(NotificationHistory)이 남는다 — 외부 알림톡 연동이 없어도
   * SMS 스텁으로 발송·이력이 기록된다. 단계에 문구가 없으면(관리자가 지웠으면) null이라
   * 확인창이 뜨지 않는다(기존 동작과 동일).
   */
  private async buildNotifiedSuggestion(
    repair: { id: string; customerId: string; orderId: string | null },
    newStatus: string,
  ) {
    if (newStatus !== 'CUSTOMER_NOTIFIED') return null;
    const stage = await this.prisma.journeyStage.findUnique({
      where: { trackType_code: { trackType: 'REPAIR', code: 'REPAIR_CHECKED_IN' } },
      select: { templateId: true },
    });
    if (!stage?.templateId) return null;
    return this.suggestions.build({
      templateId: stage.templateId,
      customerId: repair.customerId,
      orderId: repair.orderId,
      // 같은 수선의 고객 연락은 한 번만 나간다(되돌렸다 다시 전진해도 재발송하지 않는다).
      triggerKey: `repair:${repair.id}:CUSTOMER_NOTIFIED`,
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
    // CANCELLED는 더 이상 진입 대상이 아니다 — 흐름 밖 코드는 모두 거절한다.
    // (과거에 취소된 건은 CANCELLED로 남지만, 어떤 상태로도 다시 전이할 수 없다.)
    if (!flow.includes(next))
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
    // 바로 다음 단계로 진행하거나 바로 이전 단계로 되돌리는 것만 허용한다.
    const delta = flow.indexOf(next) - flow.indexOf(current);
    if (delta !== 1 && delta !== -1)
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        `수선 상태를 ${current}에서 ${next}(으)로 변경할 수 없습니다.`,
        undefined,
        { current, next },
      );
  }

  /**
   * 수선 대상 품목 검증 (통합설계서 §12.1 수선 대상):
   * 유형과 무관하게 1줄 이상 필수다. 진행(수선요청·입고·출고)이 품목 위에서 돌아가므로
   * 품목 없는 건은 누를 것이 없다 — 예전에는 일반 수선만 품목을 비울 수 있었다.
   * 계약에 등록된 주문 품목을 찾아 연결하던 방식은 폐기됐다 — 우리가 만들지 않은 옷,
   * 구성품으로 쪼개지지 않은 물건도 들어오므로 품목을 자유롭게 고른다.
   * 렌탈 실물 수선은 이 도메인에서 접수하지 않는다(렌탈 진행에서 관리).
   */
  private assertItems(items?: { targetProduct: string }[]): void {
    if (!items?.length)
      throw new BusinessException('VALIDATION_ERROR', '수선 대상 품목을 한 줄 이상 입력해 주세요.', [
        { field: 'items', reason: 'REQUIRED' },
      ]);
  }

  /**
   * 화면 입력 순서를 순번으로 굳힌다 — 같은 품목을 여러 줄로 나눠 적어도 그대로 둔다.
   * 줄마다 수량만큼 유닛을 만든다(상의 2 → #1·#2).
   */
  private itemRows(items?: RepairItemDto[]) {
    return (items ?? []).map((item, index) => ({
      id: randomUUID(),
      targetProduct: item.targetProduct,
      quantity: item.quantity,
      sequenceNo: index + 1,
      units: { create: this.unitRows(item.quantity, 1) },
    }));
  }

  /** `fromUnitNo`부터 `count`개의 유닛을 만든다(수량을 늘릴 때는 뒤에 붙인다). */
  private unitRows(count: number, fromUnitNo: number) {
    return Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      unitNo: fromUnitNo + index,
      status: 'PENDING',
    }));
  }
}
