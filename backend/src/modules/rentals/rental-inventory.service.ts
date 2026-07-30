import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException, FieldError } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  ACTIVE_ALLOCATION_STATUSES,
  ASSIGNABLE_ITEM_STATUSES,
  DATE_ONLY_REGEX,
  RENTAL_COMPONENT_TYPES,
  RENTAL_ITEM_STATUSES,
  parseDateOnly,
  toDateOnlyString,
} from './rentals.constants';
import {
  AvailabilityCalendarQueryDto,
  AvailabilityQueryDto,
  CreateInventoryDto,
  CreateStatusEventDto,
  ImportInventoryDto,
  InventoryListQueryDto,
  RetireInventoryDto,
  UpdateInventoryDto,
} from './rentals.dto';

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

/** 목록 where에 쓰이는 필터 필드만 추린 것 (페이지 파라미터 제외) */
type InventoryFilterFields = Pick<
  InventoryListQueryDto,
  'status' | 'retired' | 'active' | 'managementCode' | 'availableOn' | 'componentType' | 'color' | 'skuSize'
>;

@Injectable()
export class RentalInventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // 목록·상세
  // ---------------------------------------------------------------------------

  /**
   * 목록·건수 집계가 같은 조건을 봐야 해서 where 구성을 한곳에 둔다.
   * 페이지 파라미터는 안 보므로 필터 필드만 받는다(DTO를 스프레드하면 skip 게터가 날아간다).
   */
  private buildListWhere(query: InventoryFilterFields): Prisma.RentalInventoryItemWhereInput {
    return {
      // 폐기는 현업에서 '삭제'다 — 평소 목록에서 빼고, 체크했을 때만 폐기만 보여 준다.
      ...(query.retired ? { status: 'RETIRED' } : { status: { not: 'RETIRED' } }),
      // 상태 필터는 폐기 범위 안에서 다시 좁히는 값이라 뒤에 둔다(폐기만 보기와 겹치지 않는다).
      ...(query.status && query.status !== 'RETIRED' && !query.retired ? { status: query.status } : {}),
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(query.managementCode
        ? { managementCode: { contains: query.managementCode, mode: 'insensitive' } }
        : {}),
      ...(query.availableOn
        ? {
            OR: [{ availableFrom: null }, { availableFrom: { lte: parseDateOnly(query.availableOn) } }],
          }
        : {}),
      rentalSku: {
        ...(query.componentType ? { componentType: query.componentType } : {}),
        // 컬러는 드롭다운에서 고른 코드다 — 부분일치로 두면 BLACK이 SHOE_BLACK까지 잡는다.
        ...(query.color ? { color: query.color } : {}),
        ...(query.skuSize ? { size: query.skuSize } : {}),
      },
    };
  }

  /**
   * 품목 대분류 버튼에 붙일 건수. 품목 조건만 빼고 나머지 검색 조건은 그대로 적용해,
   * 버튼을 누르면 실제로 몇 건이 나올지 미리 보여 준다.
   */
  async summary(query: InventoryListQueryDto) {
    const [total, ...byType] = await this.prisma.$transaction([
      this.prisma.rentalInventoryItem.count({
        where: this.buildListWhere({ ...query, componentType: undefined }),
      }),
      ...RENTAL_COMPONENT_TYPES.map((componentType) =>
        this.prisma.rentalInventoryItem.count({ where: this.buildListWhere({ ...query, componentType }) }),
      ),
    ]);
    return {
      total,
      byComponentType: Object.fromEntries(RENTAL_COMPONENT_TYPES.map((t, i) => [t, byType[i]])),
    };
  }

  async list(query: InventoryListQueryDto) {
    const where = this.buildListWhere(query);

    const today = parseDateOnly(toDateOnlyString(new Date()));
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.rentalInventoryItem.findMany({
        where,
        include: {
          rentalSku: true,
          // 현재·미래 배정 요약 (RENT-001 목록의 예약 기간·고객)
          allocations: {
            where: { status: { in: ACTIVE_ALLOCATION_STATUSES }, availabilityEndDate: { gte: today } },
            orderBy: { pickupDate: 'asc' },
            select: {
              id: true,
              status: true,
              pickupDate: true,
              returnDueDate: true,
              availabilityEndDate: true,
              orderItemComponent: {
                select: {
                  id: true,
                  componentType: true,
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
            },
          },
        },
        orderBy: { managementCode: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.rentalInventoryItem.count({ where }),
    ]);
    return new Paginated(rows, query.page, query.size, total);
  }

  async detail(id: string) {
    const item = await this.prisma.rentalInventoryItem.findUnique({
      where: { id },
      include: {
        rentalSku: true,
        statusEvents: {
          orderBy: { occurredAt: 'desc' },
          include: { actor: { select: { loginId: true, displayName: true } } },
        },
        allocations: {
          orderBy: { pickupDate: 'desc' },
          include: {
            events: {
              orderBy: { occurredAt: 'asc' },
              include: { actor: { select: { loginId: true, displayName: true } } },
            },
            orderItemComponent: {
              select: {
                id: true,
                componentType: true,
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
          },
        },
      },
    });
    if (!item) throw new NotFoundException('렌탈 실물이 없습니다.');
    return item;
  }

  // ---------------------------------------------------------------------------
  // 등록 (단건·연번 일괄)
  // ---------------------------------------------------------------------------

  /**
   * 실물 등록. quantity > 1이면 관리코드 연번(`CODE-001` …)으로 일괄 생성한다.
   * SKU(구분·컬러·사이즈)는 find-or-create.
   */
  async create(dto: CreateInventoryDto, actor: AuthUser) {
    const quantity = dto.quantity ?? 1;
    const startNo = dto.startNo ?? 1;
    const codes =
      quantity === 1
        ? [dto.managementCode.trim()]
        : Array.from({ length: quantity }, (_, i) => `${dto.managementCode.trim()}-${String(startNo + i).padStart(3, '0')}`);

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

  // ---------------------------------------------------------------------------
  // 가용 검색 (통합설계서 11.5)
  // ---------------------------------------------------------------------------

  /**
   * 배정 가능 = 배정 가능 상태 AND active AND 기간 미중복 AND available_from <= 픽업일.
   */
  async availability(query: AvailabilityQueryDto) {
    const pickup = parseDateOnly(query.pickupDate);
    const end = parseDateOnly(query.availabilityEndDate);
    if (end < pickup)
      throw new BusinessException('VALIDATION_ERROR', '가용 종료일은 픽업일 이후여야 합니다.', [
        { field: 'availabilityEndDate', reason: 'BEFORE_PICKUP_DATE' },
      ]);

    return this.prisma.rentalInventoryItem.findMany({
      where: {
        active: true,
        status: { in: ASSIGNABLE_ITEM_STATUSES },
        OR: [{ availableFrom: null }, { availableFrom: { lte: pickup } }],
        rentalSku: {
          componentType: query.componentType,
          ...(query.color ? { color: query.color } : {}),
          ...(query.size ? { size: query.size } : {}),
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
      include: ITEM_WITH_SKU,
      orderBy: { managementCode: 'asc' },
    });
  }

  /**
   * 렌탈예약 달력 (설계서 06 §4.4) — [from, to] 기간의 **일자별 가용 실물**을 집계한다.
   * 후보 = 배정 가능 상태 AND active AND available_from <= 해당일 (단일창 availability 필터 재사용).
   * 점유 = ACTIVE 배정(RESERVED/CHECKED_OUT)이 해당일을 포함(pickup <= D <= availabilityEnd).
   * 조회 전용 뷰이며 정합성(이중예약)은 DB EXCLUDE 제약이 최종 보장한다.
   */
  async availabilityCalendar(query: AvailabilityCalendarQueryDto) {
    const from = parseDateOnly(query.from);
    const to = parseDateOnly(query.to);
    if (to < from)
      throw new BusinessException('VALIDATION_ERROR', '종료일은 시작일 이후여야 합니다.', [
        { field: 'to', reason: 'BEFORE_FROM' },
      ]);
    const dayMs = 24 * 60 * 60 * 1000;
    const dayCount = Math.round((to.getTime() - from.getTime()) / dayMs) + 1;
    if (dayCount > 366)
      throw new BusinessException('VALIDATION_ERROR', '조회 기간은 최대 366일까지 가능합니다.', [
        { field: 'to', reason: 'RANGE_TOO_LARGE' },
      ]);

    const skuFilter: Prisma.RentalSkuWhereInput = {
      ...(query.componentType ? { componentType: query.componentType } : {}),
      ...(query.color ? { color: query.color } : {}),
      ...(query.size ? { size: query.size } : {}),
      ...(query.sku ? { description: { contains: query.sku, mode: 'insensitive' } } : {}),
    };
    const where: Prisma.RentalInventoryItemWhereInput = {
      active: true,
      status: { in: ASSIGNABLE_ITEM_STATUSES },
      ...(Object.keys(skuFilter).length ? { rentalSku: skuFilter } : {}),
      ...(query.q
        ? {
            OR: [
              { managementCode: { contains: query.q, mode: 'insensitive' } },
              { rentalSku: { color: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const items = await this.prisma.rentalInventoryItem.findMany({
      where,
      select: {
        id: true,
        managementCode: true,
        availableFrom: true,
        rentalSku: { select: { componentType: true, color: true, size: true } },
        // 기간과 겹치는 활성 배정만 로드해 일자별 점유 판정에 사용한다.
        allocations: {
          where: {
            status: { in: ACTIVE_ALLOCATION_STATUSES },
            pickupDate: { lte: to },
            availabilityEndDate: { gte: from },
          },
          select: { pickupDate: true, availabilityEndDate: true },
        },
      },
      orderBy: { managementCode: 'asc' },
    });

    const calendar: Array<{
      date: string;
      availableCount: number;
      items: Array<{
        id: string;
        managementCode: string;
        componentType: string;
        color: string;
        size: string;
      }>;
    }> = [];
    for (let t = from.getTime(); t <= to.getTime(); t += dayMs) {
      const availableItems = items.filter((item) => {
        if (item.availableFrom && item.availableFrom.getTime() > t) return false;
        const occupied = item.allocations.some(
          (a) => a.pickupDate.getTime() <= t && a.availabilityEndDate.getTime() >= t,
        );
        return !occupied;
      });
      calendar.push({
        date: toDateOnlyString(new Date(t)),
        availableCount: availableItems.length,
        items: availableItems.map((i) => ({
          id: i.id,
          managementCode: i.managementCode,
          componentType: i.rentalSku.componentType,
          color: i.rentalSku.color,
          size: i.rentalSku.size,
        })),
      });
    }
    return calendar;
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
