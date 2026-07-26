import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  ConfirmRentalSelectionDto,
  SaveRentalLineDto,
  SelectRentalItemDto,
} from './rentals.dto';

const SESSION_INCLUDE = {
  orderItem: {
    select: {
      id: true,
      displayName: true,
      productCategory: true,
      order: {
        select: {
          orderNo: true,
          transactionType: true,
          contract: { select: { id: true, contractNo: true, customer: { select: { id: true, name: true } } } },
        },
      },
      components: {
        where: { active: true },
        orderBy: [{ componentType: 'asc' as const }, { sequenceNo: 'asc' as const }],
      },
    },
  },
  lines: {
    include: {
      selectedInventoryItem: { include: { rentalSku: true } },
    },
  },
} satisfies Prisma.RentalSelectionSessionInclude;

type SessionWithDetail = Prisma.RentalSelectionSessionGetPayload<{
  include: typeof SESSION_INCLUDE;
}>;

/**
 * 렌탈 스타일 선택 세션 (v2 D3 / 설계서 04 §4).
 * 렌탈 주문 품목의 구성품(상의/하의/베스트)별로 컬러·사이즈·비고를 지정하고,
 * 재고상태 AVAILABLE 실물을 후보로 골라 담는다(날짜 미확정 — 배정은 이후 렌탈예약).
 */
@Injectable()
export class RentalSelectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** POST /order-items/:id/rental-selection — 렌탈 선택 세션 시작/현재본 반환 (RENTAL 품목만) */
  async startSession(orderItemId: string) {
    const item = await this.prisma.orderItem.findUnique({
      where: { id: orderItemId },
      include: { order: { select: { transactionType: true } } },
    });
    if (!item) throw new NotFoundException('주문 품목이 없습니다.');
    if (item.order.transactionType !== 'RENTAL')
      throw new BusinessException(
        'VALIDATION_ERROR',
        '렌탈 주문 품목만 렌탈 스타일 선택을 시작할 수 있습니다.',
        [{ field: 'orderItemId', reason: 'NOT_RENTAL_ITEM' }],
      );

    const current = await this.prisma.rentalSelectionSession.findFirst({
      where: { orderItemId, isCurrent: true },
      select: { id: true },
    });
    if (current) return this.detail(current.id);

    const last = await this.prisma.rentalSelectionSession.aggregate({
      where: { orderItemId },
      _max: { selectionVersionNo: true },
    });
    const created = await this.prisma.rentalSelectionSession.create({
      data: {
        id: randomUUID(),
        orderItemId,
        selectionVersionNo: (last._max.selectionVersionNo ?? 0) + 1,
        status: 'IN_PROGRESS',
        isCurrent: true,
      },
    });
    return this.detail(created.id);
  }

  /** GET /order-items/:id/rental-selection — 현재 세션 상세 (없으면 { session: null }) */
  async currentSession(orderItemId: string) {
    const item = await this.prisma.orderItem.findUnique({ where: { id: orderItemId } });
    if (!item) throw new NotFoundException('주문 품목이 없습니다.');
    const current = await this.prisma.rentalSelectionSession.findFirst({
      where: { orderItemId, isCurrent: true },
      select: { id: true },
    });
    if (!current) return { session: null };
    return { session: await this.detail(current.id) };
  }

  /** GET /rental-selections/:id — 부위 슬롯(구성품) + 저장값 */
  async detail(sessionId: string) {
    const session = await this.load(sessionId);
    const lineByComponent = new Map(session.lines.map((l) => [l.orderItemComponentId, l]));
    return {
      sessionId: session.id,
      orderItemId: session.orderItemId,
      displayName: session.orderItem.displayName,
      productCategory: session.orderItem.productCategory,
      orderNo: session.orderItem.order.orderNo,
      customerId: session.orderItem.order.contract.customer.id,
      customerName: session.orderItem.order.contract.customer.name,
      status: session.status,
      isCurrent: session.isCurrent,
      confirmedAt: session.confirmedAt,
      version: session.rowVersion,
      components: session.orderItem.components.map((c) => {
        const line = lineByComponent.get(c.id);
        return {
          orderItemComponentId: c.id,
          componentType: c.componentType,
          sequenceNo: c.sequenceNo,
          colorCode: line?.colorCode ?? null,
          sizeCode: line?.sizeCode ?? null,
          notes: line?.notes ?? null,
          selectedInventoryItemId: line?.selectedInventoryItemId ?? null,
          selectedItem: line?.selectedInventoryItem
            ? {
                id: line.selectedInventoryItem.id,
                managementCode: line.selectedInventoryItem.managementCode,
                design: line.selectedInventoryItem.rentalSku.design,
                color: line.selectedInventoryItem.rentalSku.color,
                size: line.selectedInventoryItem.rentalSku.size,
                status: line.selectedInventoryItem.status,
              }
            : null,
        };
      }),
    };
  }

  /** PUT /rental-selections/:id/lines/:componentId — 부위별 컬러·사이즈·비고 upsert */
  async saveLine(sessionId: string, componentId: string, dto: SaveRentalLineDto) {
    const session = await this.load(sessionId);
    this.ensureEditable(session);
    if (dto.version !== undefined) this.ensureVersion(session, dto.version);
    const component = this.requireComponent(session, componentId);

    // 코드 유효성: 기준정보(활성) 코드와 대조
    if (dto.colorCode) await this.assertActiveColor(dto.colorCode);
    if (dto.sizeCode) await this.assertActiveSize(dto.sizeCode);

    const lineData = {
      componentType: component.componentType,
      colorCode: dto.colorCode ?? null,
      sizeCode: dto.sizeCode ?? null,
      notes: dto.notes ?? null,
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.rentalSelectionLine.upsert({
        where: {
          sessionId_orderItemComponentId: { sessionId, orderItemComponentId: componentId },
        },
        create: {
          id: randomUUID(),
          sessionId,
          orderItemComponentId: componentId,
          ...lineData,
        },
        // 컬러·사이즈가 바뀌면 이미 고른 후보 실물은 조건 불일치일 수 있어 선택을 비운다.
        update: { ...lineData, selectedInventoryItemId: null },
      });
      await tx.rentalSelectionSession.update({
        where: { id: sessionId },
        data: { rowVersion: { increment: 1 } },
      });
    });
    return this.detail(sessionId);
  }

  /**
   * GET /rental-selections/:id/lines/:componentId/candidates — 후보 실물 검색.
   * 컨설팅 단계이므로 날짜 없이 재고상태 AVAILABLE + active 실물을
   * 부위(componentType) × 컬러 × 사이즈로 필터한다 (v2 M1 확정).
   */
  async candidates(sessionId: string, componentId: string) {
    const session = await this.load(sessionId);
    const component = this.requireComponent(session, componentId);
    const line = session.lines.find((l) => l.orderItemComponentId === componentId);

    const items = await this.prisma.rentalInventoryItem.findMany({
      where: {
        active: true,
        status: 'AVAILABLE',
        rentalSku: {
          componentType: component.componentType,
          ...(line?.colorCode ? { color: line.colorCode } : {}),
          ...(line?.sizeCode ? { size: line.sizeCode } : {}),
        },
      },
      include: { rentalSku: true },
      orderBy: { managementCode: 'asc' },
    });

    return {
      sessionId,
      orderItemComponentId: componentId,
      componentType: component.componentType,
      colorCode: line?.colorCode ?? null,
      sizeCode: line?.sizeCode ?? null,
      candidates: items.map((i) => ({
        id: i.id,
        managementCode: i.managementCode,
        design: i.rentalSku.design,
        color: i.rentalSku.color,
        size: i.rentalSku.size,
        status: i.status,
      })),
    };
  }

  /** PUT /rental-selections/:id/lines/:componentId/item — 후보 실물 선택(또는 해제) */
  async selectItem(sessionId: string, componentId: string, dto: SelectRentalItemDto) {
    const session = await this.load(sessionId);
    this.ensureEditable(session);
    if (dto.version !== undefined) this.ensureVersion(session, dto.version);
    const component = this.requireComponent(session, componentId);

    let inventoryItemId: string | null = null;
    if (dto.inventoryItemId) {
      inventoryItemId = dto.inventoryItemId;
    } else if (dto.itemCode) {
      const found = await this.prisma.rentalInventoryItem.findUnique({
        where: { managementCode: dto.itemCode },
        select: { id: true },
      });
      if (!found) throw new NotFoundException(`해당 관리코드의 실물이 없습니다: ${dto.itemCode}`);
      inventoryItemId = found.id;
    }

    if (inventoryItemId) {
      // 선택 실물이 부위(componentType)와 맞는 활성 실물인지 확인한다.
      const item = await this.prisma.rentalInventoryItem.findUnique({
        where: { id: inventoryItemId },
        include: { rentalSku: true },
      });
      if (!item) throw new NotFoundException('선택한 실물이 없습니다.');
      if (!item.active || item.rentalSku.componentType !== component.componentType)
        throw new BusinessException(
          'VALIDATION_ERROR',
          '선택한 실물이 이 부위의 후보가 아닙니다.',
          [{ field: 'inventoryItemId', reason: 'ITEM_COMPONENT_MISMATCH' }],
        );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.rentalSelectionLine.upsert({
        where: {
          sessionId_orderItemComponentId: { sessionId, orderItemComponentId: componentId },
        },
        create: {
          id: randomUUID(),
          sessionId,
          orderItemComponentId: componentId,
          componentType: component.componentType,
          selectedInventoryItemId: inventoryItemId,
        },
        update: { selectedInventoryItemId: inventoryItemId },
      });
      await tx.rentalSelectionSession.update({
        where: { id: sessionId },
        data: { rowVersion: { increment: 1 } },
      });
    });
    return this.detail(sessionId);
  }

  /** POST /rental-selections/:id/confirm — 확정(status=CONFIRMED, 감사로그) */
  async confirm(sessionId: string, dto: ConfirmRentalSelectionDto, actor: AuthUser) {
    const session = await this.load(sessionId);
    if (session.status === 'CONFIRMED')
      throw new BusinessException('INVALID_STATUS_TRANSITION', '이미 확정된 렌탈 선택입니다.');
    if (dto.version !== undefined) this.ensureVersion(session, dto.version);

    const now = new Date();
    const summary = session.lines.map((l) => ({
      orderItemComponentId: l.orderItemComponentId,
      componentType: l.componentType,
      colorCode: l.colorCode,
      sizeCode: l.sizeCode,
      selectedInventoryItemId: l.selectedInventoryItemId,
      notes: l.notes,
    }));

    const updated = await this.prisma.$transaction(async (tx) => {
      const confirmed = await tx.rentalSelectionSession.update({
        where: { id: sessionId },
        data: { status: 'CONFIRMED', confirmedAt: now, rowVersion: { increment: 1 } },
      });
      await this.audit.log(
        {
          userId: actor.id,
          action: 'CONFIRM',
          entityType: 'RENTAL_SELECTION_SESSION',
          entityId: sessionId,
          before: { status: session.status, rowVersion: session.rowVersion },
          after: {
            status: 'CONFIRMED',
            orderItemId: session.orderItemId,
            selectionVersionNo: session.selectionVersionNo,
            lines: summary,
          },
        },
        tx,
      );
      return confirmed;
    });

    return { ...(await this.detail(sessionId)), version: updated.rowVersion };
  }

  /** GET /rental-selections/:id/review — 확인서(부위별 컬러·사이즈·실물·비고, 코드→표시명) */
  async review(sessionId: string) {
    const session = await this.load(sessionId);
    const [colors, sizes] = await Promise.all([
      this.prisma.rentalColor.findMany(),
      this.prisma.rentalSize.findMany(),
    ]);
    const colorName = new Map(colors.map((c) => [c.code, c.name]));
    const sizeName = new Map(sizes.map((s) => [s.code, s.name]));
    const lineByComponent = new Map(session.lines.map((l) => [l.orderItemComponentId, l]));

    return {
      sessionId: session.id,
      orderItemId: session.orderItemId,
      displayName: session.orderItem.displayName,
      customerName: session.orderItem.order.contract.customer.name,
      orderNo: session.orderItem.order.orderNo,
      status: session.status,
      confirmedAt: session.confirmedAt,
      components: session.orderItem.components.map((c) => {
        const line = lineByComponent.get(c.id);
        return {
          orderItemComponentId: c.id,
          componentType: c.componentType,
          colorCode: line?.colorCode ?? null,
          colorName: line?.colorCode ? (colorName.get(line.colorCode) ?? line.colorCode) : null,
          sizeCode: line?.sizeCode ?? null,
          sizeName: line?.sizeCode ? (sizeName.get(line.sizeCode) ?? line.sizeCode) : null,
          notes: line?.notes ?? null,
          selectedItem: line?.selectedInventoryItem
            ? {
                id: line.selectedInventoryItem.id,
                managementCode: line.selectedInventoryItem.managementCode,
                design: line.selectedInventoryItem.rentalSku.design,
              }
            : null,
        };
      }),
      version: session.rowVersion,
    };
  }

  // ---------------------------------------------------------------------------

  private async load(sessionId: string): Promise<SessionWithDetail> {
    const session = await this.prisma.rentalSelectionSession.findUnique({
      where: { id: sessionId },
      include: SESSION_INCLUDE,
    });
    if (!session) throw new NotFoundException('렌탈 선택 세션이 없습니다.');
    return session;
  }

  private requireComponent(session: SessionWithDetail, componentId: string) {
    const component = session.orderItem.components.find((c) => c.id === componentId);
    if (!component)
      throw new BusinessException(
        'VALIDATION_ERROR',
        '이 품목의 구성품이 아닙니다.',
        [{ field: 'componentId', reason: 'COMPONENT_NOT_IN_ITEM' }],
      );
    return component;
  }

  private async assertActiveColor(code: string): Promise<void> {
    const color = await this.prisma.rentalColor.findUnique({ where: { code } });
    if (!color || !color.active)
      throw new BusinessException('VALIDATION_ERROR', '유효한 렌탈 컬러 코드가 아닙니다.', [
        { field: 'colorCode', reason: 'INVALID_COLOR_CODE' },
      ]);
  }

  private async assertActiveSize(code: string): Promise<void> {
    const size = await this.prisma.rentalSize.findUnique({ where: { code } });
    if (!size || !size.active)
      throw new BusinessException('VALIDATION_ERROR', '유효한 렌탈 사이즈 코드가 아닙니다.', [
        { field: 'sizeCode', reason: 'INVALID_SIZE_CODE' },
      ]);
  }

  private ensureEditable(session: SessionWithDetail): void {
    if (session.status === 'CONFIRMED')
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '확정된 렌탈 선택은 수정할 수 없습니다.',
      );
  }

  private ensureVersion(session: SessionWithDetail, version: number): void {
    if (session.rowVersion !== version)
      throw new BusinessException(
        'VERSION_CONFLICT',
        '다른 화면에서 세션이 먼저 수정되었습니다. 다시 조회해 주세요.',
        undefined,
        { currentVersion: session.rowVersion, requestedVersion: version },
      );
  }
}
