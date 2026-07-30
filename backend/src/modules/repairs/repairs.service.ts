import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException, FieldError } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JourneysService } from '../journeys/journeys.service';
import {
  CreateRepairDto,
  CreateRepairStatusEventDto,
  ListRepairsQueryDto,
  RepairItemDto,
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

const CUSTOM_TYPES = ['CUSTOM_DURING', 'AFTER_SALE'];

const REPAIR_SUMMARY_SELECT = {
  id: true,
  repairType: true,
  requestDate: true,
  dueDate: true,
  status: true,
  description: true,
  notes: true,
  items: {
    select: { id: true, targetProduct: true, quantity: true, sequenceNo: true },
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
    private readonly journeys: JourneysService,
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

  /** 수선 접수: 대상 품목·방식 검증 후 접수(RECEIVED) 상태로 생성한다 (통합설계서 §12.1). */
  async create(dto: CreateRepairDto, actor: AuthUser) {
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer)
      throw new BusinessException('CUSTOMER_NOT_FOUND', '고객이 없습니다.', [
        { field: 'customerId', reason: 'NOT_FOUND' },
      ]);

    this.assertItems(dto.repairType, dto.items);
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
    // 품목도 기존 줄과 합쳐 판정한다 — 필수 유형에서 빈 목록으로 되돌릴 수 없다.
    this.assertItems(before.repairType, dto.items ?? before.items);

    const updated = await this.prisma.repairRequest.update({
      where: { id },
      data: {
        ...(dto.dueDate !== undefined ? { dueDate: toDate(dto.dueDate) } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        // 줄 단위 수정은 없다 — 주면 통째로 갈아끼운다(순번이 화면 입력 순서다).
        ...(dto.items !== undefined
          ? { items: { deleteMany: {}, create: this.itemRows(dto.items) } }
          : {}),
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

    // D8 일원화(설계서 02 §8·§10.3 #5): 수선 고객 연락 제안은 REPAIR 진행(journey)
    // REPAIR_CHECKED_IN 단계 진입에서만 만든다. 상태변경 기반 자동 제안은 제거해 이중 노출을 없앤다.
    // 연락 문구를 매장 고정메시지 2종으로 줄이면서 REPAIR:* 규칙·초안 템플릿은 시드에서 제거됐다.
    // 응답 필드는 하위호환을 위해 유지하되 항상 null(연락은 진행 카드에서).
    return { ...result, suggestedNotification: null };
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
   * 수선 대상 품목 검증 (통합설계서 §12.1 수선 대상):
   * - CUSTOM_DURING / AFTER_SALE → 품목 1줄 이상 필수
   * - GENERAL → 선택(대상 설명은 description)
   * 계약에 등록된 주문 품목을 찾아 연결하던 방식은 폐기됐다 — 우리가 만들지 않은 옷,
   * 구성품으로 쪼개지지 않은 물건도 들어오므로 품목을 자유롭게 고른다.
   * 렌탈 실물 수선은 이 도메인에서 접수하지 않는다(렌탈 진행에서 관리).
   */
  private assertItems(repairType: string, items?: { targetProduct: string }[]): void {
    if (CUSTOM_TYPES.includes(repairType) && !items?.length)
      throw new BusinessException('VALIDATION_ERROR', '맞춤 수선은 대상 품목이 필요합니다.', [
        { field: 'items', reason: 'REQUIRED_FOR_CUSTOM' },
      ]);
  }

  /** 화면 입력 순서를 순번으로 굳힌다 — 같은 품목을 여러 줄로 나눠 적어도 그대로 둔다. */
  private itemRows(items?: RepairItemDto[]) {
    return (items ?? []).map((item, index) => ({
      id: randomUUID(),
      targetProduct: item.targetProduct,
      quantity: item.quantity,
      sequenceNo: index + 1,
    }));
  }
}
