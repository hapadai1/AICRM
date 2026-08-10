import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BusinessException } from '../../common/business.exception';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ACTIVE_ALLOCATION_STATUSES,
  ASSIGNABLE_ITEM_STATUSES,
  HOLD_ITEM_STATUSES,
  RENTAL_COMPONENT_TYPES,
  parseDateOnly,
  toDateOnlyString,
} from './rentals.constants';
import {
  AvailabilityCalendarQueryDto,
  AvailabilityQueryDto,
  InventoryListQueryDto,
} from './rentals.dto';

/**
 * 렌탈 재고 조회 (2026-08-05 rental-inventory.service에서 분리).
 * SKU 집계·목록·상세·가용 검색·달력 — 재고를 "읽어서 보여주는" 축이다. 쓰기는 하지 않는다.
 */

/**
 * 대기 한 묶음 — "왜 못 쓰는지(상태) + 언제 풀리는지(예정일) + 몇 벌".
 * 상태만으로는 언제 나오는지 모르고, 날짜만으로는 저절로 풀리는지 사람이 풀어야 하는지 모른다.
 */
interface SkuHold {
  status: string;
  /** 예정일이 없는 대기(기한 미정)는 null */
  availableFrom: string | null;
  count: number;
}

/** SKU 수량 집계 한 줄 — total = available + reserved + checkedOut + hold */
interface SkuSummaryRow {
  componentType: string;
  color: string;
  size: string;
  /** 폐기·비활성을 뺀 보유 수 */
  total: number;
  /** 오늘 바로 빌려줄 수 있는 수 */
  available: number;
  reserved: number;
  checkedOut: number;
  /** 세탁·수선 등으로 오늘 못 쓰는 수 */
  hold: number;
  /**
   * 그 대기 수량의 내역. 화면 '비고' 칸이 이걸 그대로 줄줄이 쓴다 —
   * 수량만 보면 다른 색을 권하게 되는데 실은 모레면 나오는 경우가 있다.
   * 이른 예정일부터, 기한 미정은 맨 뒤.
   */
  holds: SkuHold[];
}

/** 목록 where에 쓰이는 필터 필드만 추린 것 (페이지 파라미터 제외) */
type InventoryFilterFields = Pick<
  InventoryListQueryDto,
  'status' | 'retired' | 'active' | 'managementCode' | 'availableOn' | 'componentType' | 'color' | 'skuSize'
>;

@Injectable()
export class RentalInventoryQueryService {
  constructor(private readonly prisma: PrismaService) {}

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
   * SKU(품목·컬러·사이즈)별 수량 집계 — 렌탈 재고 화면의 기본 뷰.
   *
   * 현장에서 실물과 시스템 개체를 1:1로 맞추는 게 불가능해, 사용자는 개체가 아니라
   * "블랙 46호 몇 벌이 지금 빌려줄 수 있나"만 다룬다 (현업 확정 2026-07-31).
   * 개체 행은 그대로 두되 화면에서는 세는 단위로만 쓴다 — 이중예약 방지는 계속
   * rental_allocation_no_overlap EXCLUDE 제약(개체×기간)이 최종 보장한다.
   *
   * 한 개체는 아래 네 통 중 정확히 하나에만 들어간다(합 = 보유). 겹칠 수 있는
   * 조건들은 "지금 못 쓰는 이유"의 우선순위로 가른다: 출고 > 예약 > 대기 > 가용.
   */
  async skuSummary(query: InventoryListQueryDto) {
    const today = parseDateOnly(toDateOnlyString(new Date()));
    const items = await this.prisma.rentalInventoryItem.findMany({
      // 폐기·비활성은 보유 수량이 아니다. 그 외 상태는 통을 가르는 데만 쓴다
      // (그래서 status·retired 필터는 무시한다 — 상태로 좁히면 합이 보유와 어긋난다).
      where: {
        ...this.buildListWhere({ ...query, status: undefined, retired: undefined }),
        active: true,
      },
      select: {
        status: true,
        availableFrom: true,
        rentalSku: { select: { componentType: true, color: true, size: true } },
        allocations: {
          where: {
            status: { in: ACTIVE_ALLOCATION_STATUSES },
            pickupDate: { lte: today },
            availabilityEndDate: { gte: today },
          },
          select: { status: true },
        },
      },
    });

    const rows = new Map<string, SkuSummaryRow>();
    for (const item of items) {
      const { componentType, color, size } = item.rentalSku;
      const key = `${componentType}|${color}|${size}`;
      const row =
        rows.get(key) ??
        {
          componentType,
          color,
          size,
          total: 0,
          available: 0,
          reserved: 0,
          checkedOut: 0,
          hold: 0,
          holds: [],
        };
      row.total += 1;
      const occupying = item.allocations;
      const waitingUntil = item.availableFrom && item.availableFrom > today ? item.availableFrom : null;
      if (occupying.some((a) => a.status === 'CHECKED_OUT')) row.checkedOut += 1;
      else if (occupying.length > 0) row.reserved += 1;
      // 세탁·수선·사용중지, 그리고 "이 날짜부터 다시 가용"이 아직 안 온 것은 지금 못 쓴다.
      else if (HOLD_ITEM_STATUSES.includes(item.status) || waitingUntil) {
        row.hold += 1;
        // 같은 사유·같은 날짜끼리 묶는다 — 세 벌이 같은 날 수선에서 나오면 세 줄이 아니라 한 줄이다.
        const availableFrom = waitingUntil ? toDateOnlyString(waitingUntil) : null;
        const same = row.holds.find((h) => h.status === item.status && h.availableFrom === availableFrom);
        if (same) same.count += 1;
        else row.holds.push({ status: item.status, availableFrom, count: 1 });
      } else row.available += 1;
      rows.set(key, row);
    }

    // 이른 예정일부터. 기한이 안 잡힌 대기(언제 풀릴지 모르는 것)는 맨 뒤로 민다.
    for (const row of rows.values())
      row.holds.sort((a, b) =>
        a.availableFrom === b.availableFrom
          ? a.status.localeCompare(b.status)
          : !a.availableFrom
            ? 1
            : !b.availableFrom
              ? -1
              : a.availableFrom.localeCompare(b.availableFrom),
      );

    return [...rows.values()].sort(
      (a, b) =>
        RENTAL_COMPONENT_TYPES.indexOf(a.componentType) - RENTAL_COMPONENT_TYPES.indexOf(b.componentType) ||
        a.color.localeCompare(b.color) ||
        a.size.localeCompare(b.size),
    );
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
      include: { rentalSku: true },
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
}
