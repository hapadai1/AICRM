import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ASSIGNABLE_ITEM_STATUSES } from './rentals.constants';
import {
  ConfirmRentalSelectionDto,
  SaveRentalLineDto,
  SaveRentalPeriodDto,
  SelectRentalItemDto,
} from './rentals.dto';

/** `YYYY-MM-DD` → Date(UTC 자정). @db.Date 컬럼과 같은 기준으로 맞춘다. */
function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

const SESSION_INCLUDE = {
  contractItem: {
    select: {
      id: true,
      displayName: true,
      productCategory: true,
      transactionType: true,
      // 품목은 계약 소유다 → 계약번호·고객을 바로 되짚는다.
      contract: {
        select: {
          id: true,
          contractNo: true,
          // 컨설팅(렌탈 선택 포함) 수정은 계약 작성중에서만 (현업 확정 2026-07-31).
          status: true,
          customer: { select: { id: true, name: true } },
        },
      },
      orderItems: { select: { status: true } },
      components: {
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

  /** POST /contract-items/:id/rental-selection — 렌탈 선택 세션 시작/현재본 반환 (RENTAL 품목만) */
  async startSession(contractItemId: string) {
    const item = await this.prisma.contractItem.findUnique({
      where: { id: contractItemId },
      select: {
        transactionType: true,
        contract: { select: { status: true } },
        orderItems: { select: { status: true } },
      },
    });
    if (!item) throw new NotFoundException('계약 품목이 없습니다.');
    this.ensureContractDraft(item.contract);
    this.ensureItemNotInProduction(item.orderItems);
    if (item.transactionType !== 'RENTAL')
      throw new BusinessException(
        'VALIDATION_ERROR',
        '렌탈 계약 품목만 렌탈 스타일 선택을 시작할 수 있습니다.',
        [{ field: 'contractItemId', reason: 'NOT_RENTAL_ITEM' }],
      );

    const current = await this.prisma.rentalSelectionSession.findFirst({
      where: { contractItemId, isCurrent: true },
      select: { id: true },
    });
    if (current) return this.detail(current.id);

    const last = await this.prisma.rentalSelectionSession.aggregate({
      where: { contractItemId },
      _max: { selectionVersionNo: true },
    });
    const created = await this.prisma.rentalSelectionSession.create({
      data: {
        id: randomUUID(),
        contractItemId,
        selectionVersionNo: (last._max.selectionVersionNo ?? 0) + 1,
        status: 'IN_PROGRESS',
        isCurrent: true,
      },
    });
    return this.detail(created.id);
  }

  /**
   * GET /rental-selections/progress?contractId= — 렌탈 품목별 부위 선택 현황.
   * 맞춤 옵션 진행 목록(option-progress)과 같은 형태로 내려, 스타일 컨설팅 화면이
   * 맞춤·렌탈을 한 목록에 부위 단위 행으로 펼칠 수 있게 한다.
   * 세션이 아직 없는 품목도 구성품 슬롯만 채워 행으로 나온다.
   */
  async progress(contractId?: string) {
    const [items, colors, sizes] = await Promise.all([
      this.prisma.contractItem.findMany({
        where: {
          status: { not: 'CANCELLED' },
          transactionType: 'RENTAL',
          ...(contractId ? { contractId } : {}),
        },
        include: {
          contract: {
            select: {
              id: true,
              contractNo: true,
              customer: { select: { id: true, name: true, phone: true } },
              currentVersion: { select: { completionDueDate: true } },
            },
          },
          components: {
            orderBy: [{ componentType: 'asc' }, { sequenceNo: 'asc' }],
          },
          rentalSelectionSessions: {
            where: { isCurrent: true },
            include: { lines: { include: { selectedInventoryItem: true } } },
          },
        },
        orderBy: [{ createdAt: 'asc' }, { sequenceNo: 'asc' }],
      }),
      this.prisma.rentalColor.findMany(),
      this.prisma.rentalSize.findMany(),
    ]);
    const colorName = new Map(colors.map((c) => [c.code, c.name]));
    const sizeName = new Map(sizes.map((s) => [s.code, s.name]));

    return items.map((item) => {
      const session = item.rentalSelectionSessions[0];
      const contract = item.contract;
      const lineByComponent = new Map(
        (session?.lines ?? []).map((l) => [l.contractItemComponentId, l]),
      );
      return {
        contractItemId: item.id,
        displayName: item.displayName,
        productCategory: item.productCategory,
        contractId: contract?.id ?? null,
        contractNo: contract?.contractNo ?? null,
        customerId: contract?.customer.id ?? null,
        customerName: contract?.customer.name ?? null,
        customerPhone: contract?.customer.phone ?? null,
        completionDueDate: contract?.currentVersion?.completionDueDate?.toISOString() ?? null,
        sessionId: session?.id ?? null,
        status: session?.status ?? 'NOT_STARTED',
        version: session?.rowVersion ?? 0,
        components: item.components.map((c) => {
          const line = lineByComponent.get(c.id);
          return {
            contractItemComponentId: c.id,
            componentType: c.componentType,
            sequenceNo: c.sequenceNo,
            colorCode: line?.colorCode ?? null,
            colorName: line?.colorCode ? (colorName.get(line.colorCode) ?? line.colorCode) : null,
            sizeCode: line?.sizeCode ?? null,
            sizeName: line?.sizeCode ? (sizeName.get(line.sizeCode) ?? line.sizeCode) : null,
            notes: line?.notes ?? null,
            selectedInventoryItemId: line?.selectedInventoryItemId ?? null,
            selectedItemCode: line?.selectedInventoryItem?.managementCode ?? null,
          };
        }),
      };
    });
  }

  /**
   * GET /rental-selections/codes — 렌탈 컬러·사이즈 활성 코드 (읽기 전용).
   * 같은 데이터의 CRUD는 /admin/master/rental-{colors,sizes}(ADMIN_MASTER_EDIT)에 있지만,
   * 스타일 컨설팅·재고 화면의 드롭다운은 조회 권한(RENTAL_VIEW)만 있는 직원도 써야 한다.
   */
  async codes(componentType?: string) {
    // 품목을 주면 그 품목에서 쓰는 코드만 돌려준다. componentTypes가 빈 코드는
    // 품목을 가리지 않는 공통 코드라 항상 포함한다.
    const scope = componentType
      ? { OR: [{ componentTypes: { has: componentType } }, { componentTypes: { isEmpty: true } }] }
      : {};
    const [colors, sizes] = await Promise.all([
      this.prisma.rentalColor.findMany({
        where: { active: true, ...scope },
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.rentalSize.findMany({
        where: { active: true, ...scope },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);
    const toRow = (r: { code: string; name: string; sortOrder: number; componentTypes: string[] }) => ({
      code: r.code,
      name: r.name,
      componentTypes: r.componentTypes,
      sortOrder: r.sortOrder,
      active: true,
    });
    return { colors: colors.map(toRow), sizes: sizes.map(toRow) };
  }

  /** GET /contract-items/:id/rental-selection — 현재 세션 상세 (없으면 { session: null }) */
  async currentSession(contractItemId: string) {
    const item = await this.prisma.contractItem.findUnique({ where: { id: contractItemId } });
    if (!item) throw new NotFoundException('계약 품목이 없습니다.');
    const current = await this.prisma.rentalSelectionSession.findFirst({
      where: { contractItemId, isCurrent: true },
      select: { id: true },
    });
    if (!current) return { session: null };
    return { session: await this.detail(current.id) };
  }

  /** GET /rental-selections/:id — 부위 슬롯(구성품) + 저장값 */
  async detail(sessionId: string) {
    const session = await this.load(sessionId);
    const contract = session.contractItem.contract ?? null;
    const lineByComponent = new Map(session.lines.map((l) => [l.contractItemComponentId, l]));
    return {
      sessionId: session.id,
      contractItemId: session.contractItemId,
      displayName: session.contractItem.displayName,
      productCategory: session.contractItem.productCategory,
      customerId: contract?.customer.id ?? null,
      customerName: contract?.customer.name ?? null,
      status: session.status,
      isCurrent: session.isCurrent,
      confirmedAt: session.confirmedAt,
      version: session.rowVersion,
      // 대여 기간 (필수값). 이게 없으면 후보 검색·확정을 할 수 없다.
      pickupDate: session.pickupDate,
      returnDueDate: session.returnDueDate,
      components: session.contractItem.components.map((c) => {
        const line = lineByComponent.get(c.id);
        return {
          contractItemComponentId: c.id,
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
                color: line.selectedInventoryItem.rentalSku.color,
                size: line.selectedInventoryItem.rentalSku.size,
                status: line.selectedInventoryItem.status,
              }
            : null,
        };
      }),
    };
  }

  /**
   * PUT /rental-selections/:id/period — 대여 기간 지정 (현업 확정 2026-07-28).
   * 기간이 바뀌면 이미 고른 실물이 그 기간에 비어 있다는 보장이 사라지므로 선택을 비운다.
   */
  async savePeriod(sessionId: string, dto: SaveRentalPeriodDto, actor: AuthUser) {
    const session = await this.load(sessionId);
    this.ensureContractDraft(session.contractItem.contract);
    this.ensureItemNotInProduction(session.contractItem.orderItems);
    this.ensureEditable(session);
    if (dto.version !== undefined) this.ensureVersion(session, dto.version);

    const pickup = parseDateOnly(dto.pickupDate);
    const returnDue = parseDateOnly(dto.returnDueDate);
    if (returnDue < pickup)
      throw new BusinessException('VALIDATION_ERROR', '반납일은 대여일 이후여야 합니다.', [
        { field: 'returnDueDate', reason: 'BEFORE_PICKUP_DATE' },
      ]);

    const changed =
      session.pickupDate?.getTime() !== pickup.getTime() ||
      session.returnDueDate?.getTime() !== returnDue.getTime();

    await this.prisma.$transaction(async (tx) => {
      await tx.rentalSelectionSession.update({
        where: { id: sessionId },
        data: { pickupDate: pickup, returnDueDate: returnDue, rowVersion: { increment: 1 } },
      });
      // 기간이 바뀌면 그 기간 기준으로 다시 골라야 한다(컬러·사이즈·비고는 남긴다).
      if (changed) {
        await tx.rentalSelectionLine.updateMany({
          where: { sessionId, selectedInventoryItemId: { not: null } },
          data: { selectedInventoryItemId: null },
        });
      }
      await this.audit.log(
        {
          userId: actor.id,
          action: 'UPDATE',
          entityType: 'RENTAL_SELECTION_SESSION',
          entityId: sessionId,
          before: { pickupDate: session.pickupDate, returnDueDate: session.returnDueDate },
          after: { pickupDate: pickup, returnDueDate: returnDue, clearedSelections: changed },
        },
        tx,
      );
    });

    return this.detail(sessionId);
  }

  /** 대여 기간은 필수다 — 없으면 후보 검색·확정을 진행하지 않는다. */
  private requirePeriod(session: SessionWithDetail): { pickup: Date; end: Date } {
    if (!session.pickupDate || !session.returnDueDate)
      throw new BusinessException(
        'RENTAL_PERIOD_REQUIRED',
        '대여 기간(대여일·반납일)을 먼저 지정해 주세요.',
        [{ field: 'pickupDate', reason: 'REQUIRED' }],
      );
    return { pickup: session.pickupDate, end: session.returnDueDate };
  }

  /** PUT /rental-selections/:id/lines/:componentId — 부위별 컬러·사이즈·비고 upsert */
  async saveLine(sessionId: string, componentId: string, dto: SaveRentalLineDto) {
    const session = await this.load(sessionId);
    this.ensureContractDraft(session.contractItem.contract);
    this.ensureItemNotInProduction(session.contractItem.orderItems);
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
          sessionId_contractItemComponentId: { sessionId, contractItemComponentId: componentId },
        },
        create: {
          id: randomUUID(),
          sessionId,
          contractItemComponentId: componentId,
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
   *
   * 대여 기간(필수, 현업 확정 2026-07-28)과 겹치는 배정이 없는 실물만 후보로 낸다.
   * 판정 규칙은 렌탈 가용검색(`rental-inventory.service.availability`)과 같다 —
   * 두 화면이 다른 답을 내면 배정 단계에서 EXCLUDE 제약에 걸려 되돌아온다.
   */
  async candidates(sessionId: string, componentId: string) {
    const session = await this.load(sessionId);
    const component = this.requireComponent(session, componentId);
    const line = session.lines.find((l) => l.contractItemComponentId === componentId);
    const { pickup, end } = this.requirePeriod(session);

    const items = await this.prisma.rentalInventoryItem.findMany({
      where: {
        active: true,
        status: { in: ASSIGNABLE_ITEM_STATUSES },
        OR: [{ availableFrom: null }, { availableFrom: { lte: pickup } }],
        rentalSku: {
          componentType: component.componentType,
          ...(line?.colorCode ? { color: line.colorCode } : {}),
          ...(line?.sizeCode ? { size: line.sizeCode } : {}),
        },
        // 기존 배정(취소 제외)과 기간이 겹치는 실물 제외
        allocations: {
          none: {
            status: { not: 'CANCELLED' },
            pickupDate: { lte: end },
            availabilityEndDate: { gte: pickup },
          },
        },
      },
      include: { rentalSku: true },
      orderBy: { managementCode: 'asc' },
    });

    return {
      sessionId,
      contractItemComponentId: componentId,
      componentType: component.componentType,
      pickupDate: session.pickupDate,
      returnDueDate: session.returnDueDate,
      colorCode: line?.colorCode ?? null,
      sizeCode: line?.sizeCode ?? null,
      candidates: items.map((i) => ({
        id: i.id,
        managementCode: i.managementCode,
        color: i.rentalSku.color,
        size: i.rentalSku.size,
        status: i.status,
      })),
    };
  }

  /** PUT /rental-selections/:id/lines/:componentId/item — 후보 실물 선택(또는 해제) */
  async selectItem(sessionId: string, componentId: string, dto: SelectRentalItemDto) {
    const session = await this.load(sessionId);
    this.ensureContractDraft(session.contractItem.contract);
    this.ensureItemNotInProduction(session.contractItem.orderItems);
    this.ensureEditable(session);
    if (dto.version !== undefined) this.ensureVersion(session, dto.version);
    const component = this.requireComponent(session, componentId);

    let inventoryItemId: string | null = null;
    if (dto.inventoryItemId) {
      inventoryItemId = dto.inventoryItemId;
    } else if (dto.itemCode) {
      // 폐기된 실물은 고를 수 없다. 같은 코드가 이력으로 남아 있어도 살아 있는 것만 찾는다.
      const found = await this.prisma.rentalInventoryItem.findFirst({
        where: { managementCode: dto.itemCode, status: { not: 'RETIRED' } },
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
          sessionId_contractItemComponentId: { sessionId, contractItemComponentId: componentId },
        },
        create: {
          id: randomUUID(),
          sessionId,
          contractItemComponentId: componentId,
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
    this.ensureContractDraft(session.contractItem.contract);
    this.ensureItemNotInProduction(session.contractItem.orderItems);
    if (session.status === 'CONFIRMED')
      throw new BusinessException('INVALID_STATUS_TRANSITION', '이미 확정된 렌탈 선택입니다.');
    // 대여 기간 없이 확정하면 어느 기간의 실물을 잡은 것인지 알 수 없다(현업 확정 2026-07-28).
    this.requirePeriod(session);
    if (dto.version !== undefined) this.ensureVersion(session, dto.version);

    const now = new Date();
    const summary = session.lines.map((l) => ({
      contractItemComponentId: l.contractItemComponentId,
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
            contractItemId: session.contractItemId,
            selectionVersionNo: session.selectionVersionNo,
            pickupDate: session.pickupDate,
            returnDueDate: session.returnDueDate,
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
    const contract = session.contractItem.contract ?? null;
    const lineByComponent = new Map(session.lines.map((l) => [l.contractItemComponentId, l]));

    return {
      sessionId: session.id,
      contractItemId: session.contractItemId,
      displayName: session.contractItem.displayName,
      customerName: contract?.customer.name ?? null,
      status: session.status,
      confirmedAt: session.confirmedAt,
      components: session.contractItem.components.map((c) => {
        const line = lineByComponent.get(c.id);
        return {
          contractItemComponentId: c.id,
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
    const component = session.contractItem.components.find((c) => c.id === componentId);
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

  /** 컨설팅(렌탈 선택 포함) 수정은 계약 작성중(DRAFT)에서만 (현업 확정 2026-07-31). */
  private ensureContractDraft(contract: { status: string } | null | undefined): void {
    if (contract && contract.status !== 'DRAFT')
      throw new BusinessException(
        'CONTRACT_NOT_DRAFT',
        '작성중인 계약에서만 렌탈 선택을 수정할 수 있습니다. 계약서 [수정하기]로 되돌린 뒤 진행해 주세요.',
        undefined,
        { contractStatus: contract.status },
      );
  }

  /** 진행 중(제작요청·수선요청 이후) 품목의 렌탈 선택 편집을 막는다 (현업 확정 2026-07-31). */
  private ensureItemNotInProduction(orderItems: Array<{ status: string }>): void {
    const inProduction = orderItems.some((o) => o.status !== 'CREATED' && o.status !== 'CANCELLED');
    if (inProduction)
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '진행 중인 품목은 렌탈 선택을 변경할 수 없습니다. 제작·입출고 화면에서 상태를 되돌린 뒤 진행해 주세요.',
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
