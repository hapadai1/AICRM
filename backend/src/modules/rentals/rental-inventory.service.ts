import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException, FieldError } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  ACTIVE_ALLOCATION_STATUSES,
  ASSIGNABLE_ITEM_STATUSES,
  DATE_ONLY_REGEX,
  HOLD_ITEM_STATUSES,
  RENTAL_COMPONENT_TYPES,
  RENTAL_ITEM_STATUSES,
  parseDateOnly,
  toDateOnlyString,
} from './rentals.constants';
import {
  CreateInventoryDto,
  CreateStatusEventDto,
  ImportInventoryDto,
  RetireInventoryDto,
  RetireQuantityDto,
  StatusQuantityDto,
  UpdateInventoryDto,
} from './rentals.dto';

/**
 * 렌탈 재고 등록·수정·상태·폐기 (2026-08-05 분리).
 * 조회(SKU 집계·목록·상세·가용 검색)는 RentalInventoryQueryService가 진다.
 */

const ITEM_WITH_SKU = { rentalSku: true } as const;

/**
 * 감사로그용 실물 식별 정보.
 * 상태만 남기면 "렌탈 재고의 상태를 바꿨습니다"가 되어 어느 옷인지 알 수 없다 —
 * 전/후 양쪽에 같은 값으로 넣어 변경 항목은 늘리지 않으면서 대상만 드러낸다.
 */
function itemIdentity(item: {
  managementCode: string;
  rentalSku: { componentType: string; color: string; size: string };
}) {
  return {
    managementCode: item.managementCode,
    componentType: item.rentalSku.componentType,
    color: item.rentalSku.color,
    size: item.rentalSku.size,
  };
}

/**
 * 코드가 활성 목록에 있는지 + 그 코드가 이 품목에서 쓰이는지 확인한다.
 * componentTypes가 빈 배열이면 품목을 가리지 않는 공통 코드로 본다.
 */
function codeErrors(
  field: 'color' | 'size',
  registry: Map<string, string[]>,
  componentType: string | undefined,
  raw: string,
): FieldError[] {
  const code = raw.trim();
  const allowed = registry.get(code);
  if (allowed === undefined)
    return [{ field, reason: field === 'color' ? 'INVALID_COLOR_CODE' : 'INVALID_SIZE_CODE' }];
  if (componentType && allowed.length > 0 && !allowed.includes(componentType))
    return [{ field, reason: field === 'color' ? 'COLOR_NOT_FOR_COMPONENT' : 'SIZE_NOT_FOR_COMPONENT' }];
  return [];
}

interface ImportRowInput {
  componentType: string;
  color: string;
  size: string;
  managementCode: string;
  skuDescription?: string;
  status?: string;
  availableFrom?: string;
  acquiredAt?: string;
  notes?: string;
}

interface ImportRowError {
  row: number;
  managementCode: string | null;
  errors: string[];
}


@Injectable()
export class RentalInventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // 등록 (단건·연번 일괄)
  // ---------------------------------------------------------------------------

  /**
   * 관리코드 자동 채번 — `구분-컬러-사이즈-연번`. 그 SKU에 이미 붙어 있는 가장 큰 연번 뒤를 잇는다.
   * 폐기된 코드는 재사용 가능하지만 여기서는 건너뛴다(같은 옷이 두 번 나온 것처럼 보이지 않게).
   *
   * 동시에 두 명이 같은 SKU를 등록하면 같은 번호를 계산할 수 있다 — 그때는 부분 UNIQUE
   * 인덱스가 막고 toFriendlyDuplicateError가 안내한다. 재고 등록은 동시성이 낮아 재시도로 충분하다.
   */
  private async nextManagementCodes(
    componentType: string,
    color: string,
    size: string,
    quantity: number,
  ): Promise<string[]> {
    // 관리코드는 60자 제한이라 접두사를 넉넉히 잘라 연번 자리를 남긴다.
    const prefix = `${componentType}-${color.trim()}-${size.trim()}`.slice(0, 50);
    const existing = await this.prisma.rentalInventoryItem.findMany({
      where: { managementCode: { startsWith: `${prefix}-` } },
      select: { managementCode: true },
    });
    const maxNo = existing.reduce((max, { managementCode }) => {
      const tail = managementCode.slice(prefix.length + 1);
      const no = /^\d+$/.test(tail) ? Number(tail) : 0;
      return no > max ? no : max;
    }, 0);
    return Array.from(
      { length: quantity },
      (_, i) => `${prefix}-${String(maxNo + 1 + i).padStart(3, '0')}`,
    );
  }

  /**
   * 실물 등록. quantity > 1이면 관리코드 연번(`CODE-001` …)으로 일괄 생성한다.
   * managementCode를 생략하면 서버가 채번한다.
   * SKU(구분·컬러·사이즈)는 find-or-create.
   */
  async create(dto: CreateInventoryDto, actor: AuthUser) {
    const quantity = dto.quantity ?? 1;
    const startNo = dto.startNo ?? 1;
    const given = dto.managementCode?.trim();
    const codes = given
      ? quantity === 1
        ? [given]
        : Array.from({ length: quantity }, (_, i) => `${given}-${String(startNo + i).padStart(3, '0')}`)
      : await this.nextManagementCodes(dto.componentType, dto.color, dto.size, quantity);

    await this.assertManagementCodesFree(codes);
    await this.assertActiveColorSize(dto.componentType, dto.color, dto.size);

    const created = await this.prisma.$transaction(async (tx) => {
      const sku = await this.findOrCreateSku(tx, dto.componentType, dto.color, dto.size, dto.skuDescription);
      const items = codes.map((code) => ({
        id: randomUUID(),
        managementCode: code,
        rentalSkuId: sku.id,
        status: dto.status ?? 'AVAILABLE',
        availableFrom: dto.availableFrom ? parseDateOnly(dto.availableFrom) : null,
        acquiredAt: dto.acquiredAt ? parseDateOnly(dto.acquiredAt) : null,
        notes: dto.notes ?? null,
      }));
      try {
        await tx.rentalInventoryItem.createMany({ data: items });
      } catch (error) {
        throw this.toFriendlyDuplicateError(error, codes);
      }
      return tx.rentalInventoryItem.findMany({
        where: { id: { in: items.map((i) => i.id) } },
        include: ITEM_WITH_SKU,
        orderBy: { managementCode: 'asc' },
      });
    });

    await Promise.all(
      created.map((item) =>
        this.audit.log({
          userId: actor.id,
          action: 'CREATE',
          entityType: 'RENTAL_INVENTORY_ITEM',
          entityId: item.id,
          after: item,
        }),
      ),
    );
    return created;
  }

  /**
   * JSON 배열 일괄 등록. dryRun이면 검증 결과만 반환하고 저장하지 않는다.
   * 오류 행은 분리해 보고하고 정상 행만 저장한다 (데이터모델설계서 16.2).
   */
  async import(dto: ImportInventoryDto, actor: AuthUser) {
    const errors: ImportRowError[] = [];
    const validRows: ImportRowInput[] = [];
    const seenCodes = new Map<string, number>();

    const codesInPayload = dto.items
      .map((row) => (typeof row.managementCode === 'string' ? row.managementCode.trim() : ''))
      .filter((code) => code.length > 0);
    // 폐기된 실물의 코드는 재사용 가능하므로 중복으로 보지 않는다.
    const existing = await this.prisma.rentalInventoryItem.findMany({
      where: { managementCode: { in: codesInPayload }, status: { not: 'RETIRED' } },
      select: { managementCode: true },
    });
    const existingCodes = new Set(existing.map((e) => e.managementCode));

    // E10: 컬러·사이즈는 활성 기준정보(rental_colors/rental_sizes) 코드여야 한다.
    const { colors: activeColors, sizes: activeSizes } = await this.loadActiveCodeSets();

    dto.items.forEach((raw, index) => {
      const rowNo = index + 1;
      const rowErrors: string[] = [];
      const str = (key: string): string | undefined =>
        typeof raw[key] === 'string' && (raw[key] as string).trim().length > 0 ? (raw[key] as string).trim() : undefined;

      const componentType = str('componentType');
      const color = str('color');
      const size = str('size');
      const managementCode = str('managementCode');
      const status = str('status');
      const availableFrom = str('availableFrom');
      const acquiredAt = str('acquiredAt');

      if (!componentType) rowErrors.push('componentType 필수값이 없습니다.');
      else if (!RENTAL_COMPONENT_TYPES.includes(componentType))
        rowErrors.push(`componentType이 허용되지 않은 품목입니다: ${componentType}`);
      // 품목별로 쓰는 코드가 달라(상의 46~60, 구두 250~280) 존재 여부만으로는 부족하다.
      if (!color) rowErrors.push('color 필수값이 없습니다.');
      else if (!activeColors.has(color)) rowErrors.push(`color가 활성 기준정보 코드가 아닙니다: ${color}`);
      else if (codeErrors('color', activeColors, componentType, color).length > 0)
        rowErrors.push(`color가 ${componentType} 품목에서 쓰이는 코드가 아닙니다: ${color}`);
      if (!size) rowErrors.push('size 필수값이 없습니다.');
      else if (!activeSizes.has(size)) rowErrors.push(`size가 활성 기준정보 코드가 아닙니다: ${size}`);
      else if (codeErrors('size', activeSizes, componentType, size).length > 0)
        rowErrors.push(`size가 ${componentType} 품목에서 쓰이는 코드가 아닙니다: ${size}`);
      if (!managementCode) rowErrors.push('managementCode 필수값이 없습니다.');
      else {
        if (existingCodes.has(managementCode)) rowErrors.push(`이미 등록된 관리코드입니다: ${managementCode}`);
        const firstRow = seenCodes.get(managementCode);
        if (firstRow !== undefined) rowErrors.push(`파일 내 관리코드가 중복됩니다 (${firstRow}행): ${managementCode}`);
        else seenCodes.set(managementCode, rowNo);
      }
      if (status && !RENTAL_ITEM_STATUSES.includes(status)) rowErrors.push(`status가 올바르지 않습니다: ${status}`);
      for (const [field, value] of [
        ['availableFrom', availableFrom],
        ['acquiredAt', acquiredAt],
      ] as const) {
        if (value && !DATE_ONLY_REGEX.test(value)) rowErrors.push(`${field}는 YYYY-MM-DD 형식이어야 합니다.`);
      }

      if (rowErrors.length > 0) {
        errors.push({ row: rowNo, managementCode: managementCode ?? null, errors: rowErrors });
        return;
      }
      validRows.push({
        componentType: componentType as string,
        color: color as string,
        size: size as string,
        managementCode: managementCode as string,
        skuDescription: str('skuDescription'),
        status,
        availableFrom,
        acquiredAt,
        notes: str('notes'),
      });
    });

    if (dto.dryRun) {
      return {
        dryRun: true,
        total: dto.items.length,
        successCount: validRows.length,
        errorCount: errors.length,
        errors,
        preview: validRows.map((r) => r.managementCode),
      };
    }

    const created = validRows.length
      ? await this.prisma.$transaction(async (tx) => {
          const ids: string[] = [];
          for (const row of validRows) {
            const sku = await this.findOrCreateSku(tx, row.componentType, row.color, row.size, row.skuDescription);
            const id = randomUUID();
            ids.push(id);
            await tx.rentalInventoryItem.create({
              data: {
                id,
                managementCode: row.managementCode,
                rentalSkuId: sku.id,
                status: row.status ?? 'AVAILABLE',
                availableFrom: row.availableFrom ? parseDateOnly(row.availableFrom) : null,
                acquiredAt: row.acquiredAt ? parseDateOnly(row.acquiredAt) : null,
                notes: row.notes ?? null,
              },
            });
          }
          return tx.rentalInventoryItem.findMany({
            where: { id: { in: ids } },
            include: ITEM_WITH_SKU,
            orderBy: { managementCode: 'asc' },
          });
        })
      : [];

    await Promise.all(
      created.map((item) =>
        this.audit.log({
          userId: actor.id,
          action: 'CREATE',
          entityType: 'RENTAL_INVENTORY_ITEM',
          entityId: item.id,
          after: item,
          reason: '일괄 등록',
        }),
      ),
    );
    return {
      dryRun: false,
      total: dto.items.length,
      successCount: created.length,
      errorCount: errors.length,
      errors,
      items: created,
    };
  }

  // ---------------------------------------------------------------------------
  // 수정·상태 변경·폐기 처리
  // ---------------------------------------------------------------------------

  async update(id: string, dto: UpdateInventoryDto, actor: AuthUser) {
    const before = await this.prisma.rentalInventoryItem.findUnique({ where: { id }, include: ITEM_WITH_SKU });
    if (!before) throw new NotFoundException('렌탈 실물이 없습니다.');
    this.assertVersion(dto.version, before.rowVersion);

    if (dto.managementCode && dto.managementCode.trim() !== before.managementCode) {
      await this.assertManagementCodesFree([dto.managementCode.trim()]);
    }

    const colorChanged = !!dto.color && dto.color.trim() !== before.rentalSku.color;
    const sizeChanged = !!dto.size && dto.size.trim() !== before.rentalSku.size;
    // E10: 컬러·사이즈를 바꾸는 경우에만 활성 기준정보 코드 검증(자유문자 유입 차단).
    if (colorChanged || sizeChanged) {
      await this.assertActiveColorSize(
        dto.componentType ?? before.rentalSku.componentType,
        colorChanged ? dto.color : undefined,
        sizeChanged ? dto.size : undefined,
      );
    }

    const skuChanged =
      (dto.componentType && dto.componentType !== before.rentalSku.componentType) ||
      colorChanged ||
      sizeChanged;

    const updated = await this.prisma.$transaction(async (tx) => {
      let rentalSkuId = before.rentalSkuId;
      if (skuChanged) {
        // 공유 SKU를 직접 수정하지 않고 대상 SKU로 재연결한다 (find-or-create).
        const sku = await this.findOrCreateSku(
          tx,
          dto.componentType ?? before.rentalSku.componentType,
          dto.color ?? before.rentalSku.color,
          dto.size ?? before.rentalSku.size,
        );
        rentalSkuId = sku.id;
      }
      try {
        return await tx.rentalInventoryItem.update({
          where: { id },
          data: {
            rentalSkuId,
            ...(dto.managementCode ? { managementCode: dto.managementCode.trim() } : {}),
            ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
            ...(dto.active !== undefined ? { active: dto.active } : {}),
            ...(dto.acquiredAt !== undefined ? { acquiredAt: dto.acquiredAt ? parseDateOnly(dto.acquiredAt) : null } : {}),
            rowVersion: { increment: 1 },
          },
          include: ITEM_WITH_SKU,
        });
      } catch (error) {
        throw this.toFriendlyDuplicateError(error, dto.managementCode ? [dto.managementCode.trim()] : []);
      }
    });

    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'RENTAL_INVENTORY_ITEM',
      entityId: id,
      before,
      after: updated,
    });
    return updated;
  }

  /**
   * 수동 상태 변경 + 대여 가능 예정일 입력 (RENT-002/004).
   * 현재·미래 배정과 충돌하는 상태 변경은 차단한다.
   */
  async createStatusEvent(id: string, dto: CreateStatusEventDto, actor: AuthUser) {
    const item = await this.prisma.rentalInventoryItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('렌탈 실물이 없습니다.');
    this.assertVersion(dto.version, item.rowVersion);

    // 배정과 충돌하는 상태로의 수동 변경 차단: 실물을 배정 불가로 만드는 상태는
    // 현재·미래의 살아있는 배정(RESERVED/CHECKED_OUT)이 없어야 한다.
    if (!ASSIGNABLE_ITEM_STATUSES.includes(dto.newStatus)) {
      await this.assertNoActiveAllocations(id, `${dto.newStatus} 상태로 변경할 수 없습니다.`);
    }

    const retiring = dto.newStatus === 'RETIRED';
    const updated = await this.prisma.$transaction(async (tx) => {
      const after = await tx.rentalInventoryItem.update({
        where: { id },
        data: {
          status: dto.newStatus,
          ...(dto.availableFrom !== undefined ? { availableFrom: parseDateOnly(dto.availableFrom) } : {}),
          ...(retiring ? { active: false, retiredAt: parseDateOnly(toDateOnlyString(new Date())) } : {}),
          rowVersion: { increment: 1 },
        },
        include: ITEM_WITH_SKU,
      });
      await tx.rentalInventoryStatusEvent.create({
        data: {
          id: randomUUID(),
          rentalInventoryItemId: id,
          previousStatus: item.status,
          newStatus: dto.newStatus,
          availableFrom: after.availableFrom,
          reason: dto.reason,
          actorId: actor.id,
        },
      });
      return after;
    });

    await this.audit.log({
      userId: actor.id,
      action: 'STATUS_CHANGE',
      entityType: 'RENTAL_INVENTORY_ITEM',
      entityId: id,
      before: { ...itemIdentity(updated), status: item.status, availableFrom: item.availableFrom },
      after: { ...itemIdentity(updated), status: updated.status, availableFrom: updated.availableFrom },
      reason: dto.reason,
    });
    return updated;
  }

  /** 폐기 처리(RETIRED). 살아있는 배정이 있으면 불가. 이력 보존을 위해 삭제하지 않는다. */
  async retire(id: string, dto: RetireInventoryDto, actor: AuthUser) {
    const item = await this.prisma.rentalInventoryItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('렌탈 실물이 없습니다.');
    if (item.status === 'RETIRED')
      throw new BusinessException('INVALID_STATUS_TRANSITION', '이미 폐기 처리된 실물입니다.');
    await this.assertNoActiveAllocations(id, '폐기 처리할 수 없습니다.');

    const updated = await this.prisma.$transaction(async (tx) => {
      const after = await tx.rentalInventoryItem.update({
        where: { id },
        data: {
          status: 'RETIRED',
          active: false,
          retiredAt: parseDateOnly(toDateOnlyString(new Date())),
          rowVersion: { increment: 1 },
        },
        include: ITEM_WITH_SKU,
      });
      await tx.rentalInventoryStatusEvent.create({
        data: {
          id: randomUUID(),
          rentalInventoryItemId: id,
          previousStatus: item.status,
          newStatus: 'RETIRED',
          availableFrom: after.availableFrom,
          reason: dto.reason,
          actorId: actor.id,
        },
      });
      return after;
    });

    await this.audit.log({
      userId: actor.id,
      action: 'STATUS_CHANGE',
      entityType: 'RENTAL_INVENTORY_ITEM',
      entityId: id,
      before: { ...itemIdentity(updated), status: item.status, active: item.active },
      after: { ...itemIdentity(updated), status: 'RETIRED', active: false },
      reason: dto.reason,
    });
    return updated;
  }

  /**
   * SKU 단위로 손댈 개체 N개를 고른다 — 재고 화면이 개체를 다루지 않으므로 서버가 고른다
   * (현업 확정 2026-07-31).
   *
   * 예약·출고가 걸린 옷은 후보에서 뺀다 (단건 경로의 assertNoActiveAllocations와 같은 기준).
   * `holdFirst`면 세탁·수선처럼 이미 못 쓰는 것부터 골라 가용 수량을 최대한 남기고,
   * 아니면 그 반대로 멀쩡한 것부터 고른다(사용불가로 돌릴 때).
   * 수량을 채울 수 없으면 아무것도 건드리지 않고 몇 벌이 가능한지 알려 준다.
   */
  private async pickItemsForQuantity(
    sku: { componentType: string; color: string; size: string },
    quantity: number,
    holdFirst: boolean,
    shortfallMessage: (available: number) => string,
    /** 지금 못 쓰는 것만 대상으로 좁힐지 (사용 재개용) */
    heldOnly = false,
  ): Promise<string[]> {
    const today = parseDateOnly(toDateOnlyString(new Date()));
    const candidates = await this.prisma.rentalInventoryItem.findMany({
      where: {
        active: true,
        status: { not: 'RETIRED' },
        rentalSku: sku,
        allocations: { none: { status: { in: ACTIVE_ALLOCATION_STATUSES } } },
        // "지금 못 쓴다"의 정의는 skuSummary의 hold 통과 같아야 한다 — 상태가 대기이거나,
        // 세탁 후 재가용일(availableFrom)이 아직 안 온 것. 한쪽만 보면 재개 대상이 어긋난다.
        ...(heldOnly
          ? { OR: [{ status: { in: HOLD_ITEM_STATUSES } }, { availableFrom: { gt: today } }] }
          : {}),
      },
      select: { id: true, status: true },
    });

    if (candidates.length < quantity)
      throw new BusinessException('VALIDATION_ERROR', shortfallMessage(candidates.length), [
        { field: 'quantity', reason: 'NOT_ENOUGH_ITEMS' },
      ]);

    const weight = (status: string) => Number(HOLD_ITEM_STATUSES.includes(status));
    const ordered = [...candidates].sort((a, b) =>
      holdFirst ? weight(b.status) - weight(a.status) : weight(a.status) - weight(b.status),
    );
    return ordered.slice(0, quantity).map((i) => i.id);
  }

  /** SKU 단위 수량 폐기 — "블랙 46호 2벌 뺀다". */
  async retireQuantity(dto: RetireQuantityDto, actor: AuthUser) {
    const ids = await this.pickItemsForQuantity(
      { componentType: dto.componentType, color: dto.color, size: dto.size },
      dto.quantity,
      true,
      (n) =>
        `폐기할 수 있는 실물이 ${n}벌뿐입니다. (요청 ${dto.quantity}벌 — 예약·출고 중인 실물은 뺄 수 없습니다)`,
    );
    // 단건 폐기를 그대로 돌린다 — 상태 이벤트·감사로그가 개체마다 남아야 이력이 이어진다.
    for (const id of ids) await this.retire(id, { reason: dto.reason }, actor);
    return { retired: ids.length };
  }

  /**
   * SKU 단위 수량 상태 변경 — "블랙 46호 1벌 임시 사용불가", "1벌 사용 재개".
   * 사용불가로 돌릴 때는 멀쩡한 것부터, 되돌릴 때는 못 쓰는 것부터 고른다.
   */
  async changeStatusQuantity(dto: StatusQuantityDto, actor: AuthUser) {
    const toHold = HOLD_ITEM_STATUSES.includes(dto.newStatus);
    const ids = await this.pickItemsForQuantity(
      { componentType: dto.componentType, color: dto.color, size: dto.size },
      dto.quantity,
      !toHold,
      (n) =>
        `상태를 바꿀 수 있는 실물이 ${n}벌뿐입니다. (요청 ${dto.quantity}벌 — 예약·출고 중인 실물은 바꿀 수 없습니다)`,
      // 되돌릴 때는 지금 못 쓰는 것만 대상이다 — 멀쩡한 옷까지 건드리면 수량이 안 맞는다.
      !toHold,
    );
    // 되돌릴 때는 재가용일도 오늘로 당긴다. 세탁 반납 때 걸어 둔 availableFrom이 미래로
    // 남아 있으면 상태만 AVAILABLE이 되고 가용 수량에는 안 잡힌다.
    const availableFrom = toHold ? undefined : toDateOnlyString(new Date());
    for (const id of ids) {
      const item = await this.prisma.rentalInventoryItem.findUniqueOrThrow({
        where: { id },
        select: { rowVersion: true },
      });
      await this.createStatusEvent(
        id,
        { newStatus: dto.newStatus, reason: dto.reason, availableFrom, version: item.rowVersion },
        actor,
      );
    }
    return { changed: ids.length };
  }

  // ---------------------------------------------------------------------------
  // 내부 헬퍼
  // ---------------------------------------------------------------------------

  /** 활성 렌탈 컬러·사이즈 코드 집합 (E10 검증 소스). */
  /** 코드 → 그 코드가 쓰이는 품목 목록. 빈 배열이면 전 품목 공통. */
  private async loadActiveCodeSets(): Promise<{ colors: Map<string, string[]>; sizes: Map<string, string[]> }> {
    const [colors, sizes] = await Promise.all([
      this.prisma.rentalColor.findMany({ where: { active: true }, select: { code: true, componentTypes: true } }),
      this.prisma.rentalSize.findMany({ where: { active: true }, select: { code: true, componentTypes: true } }),
    ]);
    return {
      colors: new Map(colors.map((c) => [c.code, c.componentTypes])),
      sizes: new Map(sizes.map((s) => [s.code, s.componentTypes])),
    };
  }

  /**
   * E10: 컬러·사이즈가 활성 코드인지, 그리고 그 코드가 해당 품목에서 쓰이는지 검증한다.
   * 인자가 주어진 항목만 검사한다(수정 시 부분 변경 대응).
   * 사이즈 체계가 품목마다 달라(상의 46~60, 구두 250~280) 코드 존재만 봐서는
   * 상의에 구두 사이즈를 붙이는 등록이 그대로 통과한다.
   */
  private async assertActiveColorSize(componentType?: string, color?: string, size?: string): Promise<void> {
    if (color === undefined && size === undefined) return;
    const { colors, sizes } = await this.loadActiveCodeSets();
    const fieldErrors: FieldError[] = [];
    if (color !== undefined) fieldErrors.push(...codeErrors('color', colors, componentType, color));
    if (size !== undefined) fieldErrors.push(...codeErrors('size', sizes, componentType, size));
    if (fieldErrors.length > 0)
      throw new BusinessException(
        'VALIDATION_ERROR',
        '컬러·사이즈는 해당 품목에서 쓰이는 활성 렌탈 기준정보 코드여야 합니다.',
        fieldErrors,
      );
  }

  private async findOrCreateSku(
    tx: Prisma.TransactionClient,
    componentType: string,
    color: string,
    size: string,
    description?: string,
  ) {
    const found = await tx.rentalSku.findFirst({
      where: { componentType, color: color.trim(), size: size.trim() },
    });
    if (found) return found;
    return tx.rentalSku.create({
      data: {
        id: randomUUID(),
        componentType,
        color: color.trim(),
        size: size.trim(),
        description: description ?? null,
      },
    });
  }

  /**
   * 관리코드 중복 사전 검증 — UNIQUE 위반을 친절한 오류로 반환한다.
   * 폐기된 실물의 코드는 비어 있는 것으로 본다(코드표를 새 옷에 다시 붙여 쓴다).
   */
  private async assertManagementCodesFree(codes: string[]): Promise<void> {
    const dup = await this.prisma.rentalInventoryItem.findMany({
      where: { managementCode: { in: codes }, status: { not: 'RETIRED' } },
      select: { managementCode: true },
    });
    if (dup.length > 0) {
      const duplicated = dup.map((d) => d.managementCode);
      throw new BusinessException(
        'VALIDATION_ERROR',
        `이미 등록된 관리코드입니다: ${duplicated.join(', ')}`,
        duplicated.map((code): FieldError => ({ field: 'managementCode', reason: `DUPLICATE:${code}` })),
        { duplicatedCodes: duplicated },
      );
    }
  }

  /** createMany 등에서 발생한 P2002(UNIQUE)를 친절한 오류로 변환한다 (동시 등록 경합 대비). */
  private toFriendlyDuplicateError(error: unknown, codes: string[]): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return new BusinessException(
        'VALIDATION_ERROR',
        `이미 등록된 관리코드가 포함되어 있습니다${codes.length ? `: ${codes.join(', ')}` : '.'}`,
        [{ field: 'managementCode', reason: 'DUPLICATE' }],
      );
    }
    return error;
  }

  private async assertNoActiveAllocations(itemId: string, message: string): Promise<void> {
    const active = await this.prisma.rentalAllocation.findFirst({
      where: { rentalInventoryItemId: itemId, status: { in: ACTIVE_ALLOCATION_STATUSES } },
      select: { id: true, status: true, pickupDate: true, availabilityEndDate: true },
    });
    if (active) {
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        `진행 중인 배정이 있어 ${message}`,
        undefined,
        {
          allocationId: active.id,
          allocationStatus: active.status,
          pickupDate: toDateOnlyString(active.pickupDate),
          availabilityEndDate: toDateOnlyString(active.availabilityEndDate),
        },
      );
    }
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
