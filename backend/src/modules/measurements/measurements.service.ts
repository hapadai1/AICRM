import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { FilesService, UploadedMulterFile } from '../files/files.service';
import { syncPrepStatuses } from '../production/prep-status';
import { isBeforeProductionRequest } from '../production/production-status';
import { canChangeWorkOrderMeasurement } from '../work-orders/work-order-status';
import { MEASUREMENT_ITEM_MAP } from './measurement-catalog';
import { autoLinkMeasurements } from './measurement-link';
import {
  CloneMeasurementSessionDto,
  CreateMeasurementSessionDto,
  LinkOrderItemMeasurementDto,
  MeasurementListQueryDto,
  MeasurementValueInputDto,
  UpdateMeasurementSessionDto,
} from './measurements.dto';

/** 정규화된 채촌값 (DB 저장 형태) */
interface NormalizedValue {
  bodySection: string;
  measurementCode: string;
  numericValue: number | null;
  textValue: string | null;
  unit: string;
  sortOrder: number;
}

/** 채촌 이미지 첨부는 범용 EntityFile을 재사용한다 (스키마 무변경, 설계서 05 §4.1). */
const IMAGE_ENTITY_TYPE = 'MEASUREMENT_SESSION';
const IMAGE_PURPOSE = 'PHOTO';
/** 세션당 첨부 사진 최대 장수 (설계서 05 §4.2, plan_v2). */
const MAX_IMAGES = 50;

/** 잠금 판정에 필요한 최소 모양 — 목록·상세 쿼리가 모두 이 모양을 만족한다. */
interface LockSource {
  _count: { workOrderVersions: number };
  orderItemLinks: { orderItem: { status: string; order: { contract: { status: string } } } }[];
}

/**
 * 채촌 편집 잠금 판정 (현업 확정 2026-08-05).
 *
 * 채촌은 독립 축이라 언제든 고친다 — 다만 **그 치수로 일이 시작된 뒤**에는 못 고친다.
 * 두 시점이 그것을 가른다:
 *  - **계약완료**: 치수가 주문으로 넘어갔다. 계약서를 [수정하기]로 되돌리면 다시 열린다.
 *  - **발주 이후**: 공장이 이미 그 치수로 만들고 있다.
 * 작업지시서 출력본이 있는 세션도 잠근다 — 출력물의 근거를 보존한다.
 *
 * 예전에는 '완료' 표시가 편집을 막았는데, 완료는 상태 관리에서 걷어냈다.
 */
function isMeasurementLocked(session: LockSource): boolean {
  if (session._count.workOrderVersions > 0) return true;
  return session.orderItemLinks.some(
    (l) =>
      l.orderItem.order.contract.status === 'COMPLETED' ||
      !isBeforeProductionRequest(l.orderItem.status),
  );
}

const SESSION_INCLUDE = {
  createdByUser: { select: { id: true, displayName: true } },
  customer: { select: { id: true, name: true, phone: true } },
  values: { orderBy: [{ sortOrder: 'asc' }, { measurementCode: 'asc' }] },
  // 화면 머리말에 계약번호를 보여 주기 위해 주문·계약까지 함께 읽는다.
  relatedOrder: {
    select: { id: true, orderNo: true, contractId: true, contract: { select: { contractNo: true } } },
  },
  orderItemLinks: {
    where: { isCurrent: true },
    select: {
      orderItem: {
        select: {
          id: true,
          displayName: true,
          productCategory: true,
          // 잠금 판정 근거 — 계약완료 또는 발주 이후면 이 채촌은 못 고친다 (2026-08-05).
          status: true,
          order: {
            select: {
              contractId: true,
              contract: { select: { contractNo: true, status: true } },
            },
          },
        },
      },
    },
  },
  _count: { select: { workOrderVersions: true } },
} satisfies Prisma.MeasurementSessionInclude;

type SessionWithValues = Prisma.MeasurementSessionGetPayload<{ include: typeof SESSION_INCLUDE }>;

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toNumberOrNull(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value);
}

@Injectable()
export class MeasurementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {}

  // ---------------------------------------------------------------------------
  // 조회
  // ---------------------------------------------------------------------------

  /**
   * MEAS-001 전역 채촌 검색 (설계서 09 §3.1).
   * 고객을 고르지 않아도 전체 채촌을 최신 채촌일 순으로 보여 준다.
   */
  async search(query: MeasurementListQueryDto): Promise<Paginated<unknown>> {
    const where: Prisma.MeasurementSessionWhereInput = {};
    if (query.customerId) where.customerId = query.customerId;
    if (query.type) where.measurementType = query.type;

    // @db.Date 컬럼이라 종료일은 그날 00:00(UTC)까지 포함하면 하루 전체가 들어온다.
    if (query.dateFrom || query.dateTo) {
      where.measurementDate = {
        ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
        ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
      };
    }

    const q = query.q?.trim();
    if (q) {
      const digits = q.replace(/\D/g, '');
      where.customer = {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          ...(digits.length >= 3 ? [{ phoneNormalized: { contains: digits } }] : []),
        ],
      };
    }

    const [sessions, total] = await this.prisma.$transaction([
      this.prisma.measurementSession.findMany({
        where,
        orderBy: [{ measurementDate: 'desc' }, { versionNo: 'desc' }],
        skip: query.skip,
        take: query.size,
        include: {
          createdByUser: { select: { id: true, displayName: true } },
          customer: { select: { id: true, name: true, phone: true } },
          _count: { select: { values: true, workOrderVersions: true } },
          orderItemLinks: {
            where: { isCurrent: true },
            select: {
              orderItem: {
                select: {
                  id: true,
                  displayName: true,
                  productCategory: true,
                  // 잠금 판정 근거 — 계약완료 또는 발주 이후면 못 고친다 (2026-08-05).
                  status: true,
                  order: { select: { contract: { select: { status: true } } } },
                },
              },
            },
          },
        },
      }),
      this.prisma.measurementSession.count({ where }),
    ]);

    const items = sessions.map((s) => ({
      id: s.id,
      customerId: s.customerId,
      customerName: s.customer.name,
      customerPhone: s.customer.phone,
      versionNo: s.versionNo,
      measurementDate: toDateString(s.measurementDate),
      measurementType: s.measurementType,
      staffName: s.createdByUser.displayName,
      createdBy: s.createdByUser,
      valueCount: s._count.values,
      linkedOrderItems: s.orderItemLinks.map((l) => l.orderItem),
      linkedOrderItemCount: s.orderItemLinks.length,
      workOrderVersionCount: s._count.workOrderVersions,
      locked: isMeasurementLocked(s),
      fitPreference: s.fitPreference,
      previousSessionId: s.previousSessionId,
      createdAt: s.createdAt,
    }));
    return new Paginated(items, query.page, query.size, total);
  }

  /**
   * MEAS-001 채촌 대상 목록 — 계약 단위.
   * 기준은 "채촌 기록"이 아니라 "스타일 컨설팅 대상(맞춤 계약의 미취소 품목)"이라,
   * 아직 채촌하지 않은 계약도 모두 나온다.
   *
   * - 스타일 컨설팅 상태: 계약 품목의 옵션 세션이 전부 CONFIRMED면 전체 완료.
   * - 채촌 상태: 고객의 과거 이력이 아니라 **이 계약에 연결된** 채촌만 본다.
   *   연결 판단은 세션의 relatedOrder(계약의 주문) 또는 현재 사용 품목(orderItemLinks) 기준이다.
   */
  async targets() {
    const items = await this.prisma.orderItem.findMany({
      where: { status: { not: 'CANCELLED' }, order: { transactionType: 'CUSTOM' } },
      select: {
        productCategory: true,
        order: {
          select: {
            id: true,
            contractId: true,
            contract: {
              select: {
                contractNo: true,
                contractedAt: true,
                createdAt: true,
                status: true,
                contractType: { select: { name: true } },
                // 완료 예정일은 주문 사본이 아니라 계약서 현재 버전에서 읽는다 —
                // 수정하기로 날짜만 바꾸고 아직 계약완료를 다시 누르지 않은 사이에도
                // 계약 목록과 같은 값이 보여야 한다.
                currentVersion: { select: { completionDueDate: true } },
                customer: { select: { id: true, name: true, phone: true } },
              },
            },
          },
        },
        // 옵션 세션은 ContractItem에 붙는다 → sourceContractItem 경유(REACH-BACK).
        sourceContractItem: {
          select: {
            optionSelectionSessions: { where: { isCurrent: true }, select: { status: true } },
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { sequenceNo: 'asc' }],
    });

    interface Row {
      contractId: string;
      contractNo: string;
      /** 계약 구분명. 구분을 지정하지 않은 계약은 null */
      contractTypeName: string | null;
      /** 계약 상태 (DRAFT·SIGNED·COMPLETED). 취소 계약은 주문이 없어 여기 오지 않는다. */
      contractStatus: string;
      /** 계약일 (YYYY-MM-DD) — 목록 기간 필터의 기준. 없는 초안은 등록일로 갈음한다. */
      contractDate: string;
      /** 신규 채촌을 이 계약에 연결하기 위한 대표 주문 */
      orderId: string;
      customerId: string;
      customerName: string;
      customerPhone: string;
      /** 카테고리별 품목 수 (품목 구성 요약용) */
      categoryCounts: Record<string, number>;
      itemCount: number;
      /** 옵션 세션이 CONFIRMED인 품목 수 */
      consultingConfirmedCount: number;
      /** 스타일 컨설팅 전체 완료 여부 */
      consultingComplete: boolean;
      /** 계약서 현재 버전의 완료 예정일 (YYYY-MM-DD). 없으면 null */
      dueDate: string | null;
      /** 이 계약에 연결된 채촌 건수 */
      measurementCount: number;
      lastSessionId: string | null;
      lastMeasurementDate: string | null;
      lastVersionNo: number | null;
      lastMeasurementType: string | null;
    }

    const rows = new Map<string, Row>();
    for (const item of items) {
      const order = item.order;
      const customer = order.contract.customer;
      const row = rows.get(order.contractId) ?? {
        contractId: order.contractId,
        contractNo: order.contract.contractNo,
        contractTypeName: order.contract.contractType?.name ?? null,
        contractStatus: order.contract.status,
        // 계약일이 없는 초안(임시저장)은 등록일로 갈음한다 — 계약 목록의 기간 필터와 같은 규칙.
        contractDate: toDateString(order.contract.contractedAt ?? order.contract.createdAt),
        orderId: order.id,
        customerId: customer.id,
        customerName: customer.name,
        customerPhone: customer.phone,
        categoryCounts: {},
        itemCount: 0,
        consultingConfirmedCount: 0,
        consultingComplete: false,
        dueDate: order.contract.currentVersion?.completionDueDate
          ? toDateString(order.contract.currentVersion.completionDueDate)
          : null,
        measurementCount: 0,
        lastSessionId: null,
        lastMeasurementDate: null,
        lastVersionNo: null,
        lastMeasurementType: null,
      };
      row.itemCount += 1;
      row.categoryCounts[item.productCategory] = (row.categoryCounts[item.productCategory] ?? 0) + 1;
      if (item.sourceContractItem.optionSelectionSessions[0]?.status === 'CONFIRMED')
        row.consultingConfirmedCount += 1;
      rows.set(order.contractId, row);
    }
    for (const row of rows.values()) {
      row.consultingComplete = row.itemCount > 0 && row.consultingConfirmedCount === row.itemCount;
    }

    const customerIds = [...new Set([...rows.values()].map((r) => r.customerId))];
    if (customerIds.length > 0) {
      const sessions = await this.prisma.measurementSession.findMany({
        where: { customerId: { in: customerIds } },
        orderBy: [{ measurementDate: 'desc' }, { versionNo: 'desc' }],
        select: {
          id: true,
          measurementDate: true,
          versionNo: true,
          measurementType: true,
          relatedOrder: { select: { contractId: true } },
          orderItemLinks: {
            where: { isCurrent: true },
            select: { orderItem: { select: { order: { select: { contractId: true } } } } },
          },
        },
      });
      // 정렬이 최신 순이라 계약별로 처음 만나는 세션이 최근 채촌이다.
      for (const s of sessions) {
        const contractIds = new Set<string>();
        if (s.relatedOrder) contractIds.add(s.relatedOrder.contractId);
        for (const link of s.orderItemLinks) contractIds.add(link.orderItem.order.contractId);
        for (const contractId of contractIds) {
          const row = rows.get(contractId);
          if (!row) continue;
          row.measurementCount += 1;
          if (row.lastSessionId === null) {
            row.lastSessionId = s.id;
            row.lastMeasurementDate = toDateString(s.measurementDate);
            row.lastVersionNo = s.versionNo;
            row.lastMeasurementType = s.measurementType;
          }
        }
      }
    }

    // 채촌이 아직 없는 계약을 위로, 그 다음은 최근 채촌일 오름차순(오래된 것부터).
    return [...rows.values()].sort((a, b) => {
      if (!a.lastMeasurementDate && !b.lastMeasurementDate)
        return b.contractNo.localeCompare(a.contractNo);
      if (!a.lastMeasurementDate) return -1;
      if (!b.lastMeasurementDate) return 1;
      return a.lastMeasurementDate.localeCompare(b.lastMeasurementDate);
    });
  }

  /**
   * MEAS-001 채촌 이력: 이 고객이 저장한 채촌 기록(최근 순) + 현재 연결 품목.
   * 채촌은 버전 관리를 하지 않으므로(현업 확정 2026-08-01) 채촌일 기준으로 정렬한다.
   */
  async listByCustomer(customerId: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new BusinessException('CUSTOMER_NOT_FOUND', '고객이 없습니다.');

    const sessions = await this.prisma.measurementSession.findMany({
      where: { customerId },
      orderBy: [{ measurementDate: 'desc' }, { versionNo: 'desc' }],
      include: {
        createdByUser: { select: { id: true, displayName: true } },
        _count: { select: { values: true, workOrderVersions: true } },
        orderItemLinks: {
          where: { isCurrent: true },
          select: {
            orderItem: {
              select: {
                id: true,
                displayName: true,
                productCategory: true,
                // 잠금 판정 근거 (2026-08-05)
                status: true,
                order: { select: { contract: { select: { status: true } } } },
              },
            },
          },
        },
      },
    });
    return sessions.map((s) => ({
      id: s.id,
      // 고객 화면에서 넘어와도 이름을 보여줄 수 있게 함께 내려 준다.
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: customer.phone,
      versionNo: s.versionNo,
      measurementDate: toDateString(s.measurementDate),
      measurementType: s.measurementType,
      previousSessionId: s.previousSessionId,
      fitPreference: s.fitPreference,
      // 작업지시서 출력 근거로 쓰여 수정·삭제가 막힌 기록 (목록에서 바로 구분해야 한다)
      locked: isMeasurementLocked(s),
      createdBy: s.createdByUser,
      createdAt: s.createdAt,
      valueCount: s._count.values,
      linkedOrderItemCount: s.orderItemLinks.length,
      linkedOrderItems: s.orderItemLinks.map((l) => l.orderItem),
    }));
  }

  /** MEAS-002 채촌 상세(값 포함) */
  async getDetail(id: string) {
    const session = await this.prisma.measurementSession.findUnique({
      where: { id },
      include: SESSION_INCLUDE,
    });
    if (!session) throw new NotFoundException('채촌 세션이 없습니다.');
    return this.toDetail(session);
  }

  /** MEAS-003 두 버전 비교: 항목별 이전(left)/현재(right)/차이 */
  async compare(leftId: string, rightId: string) {
    if (leftId === rightId)
      throw new BusinessException('VALIDATION_ERROR', '서로 다른 두 버전을 선택해 주세요.');

    const [left, right] = await Promise.all([
      this.prisma.measurementSession.findUnique({ where: { id: leftId }, include: SESSION_INCLUDE }),
      this.prisma.measurementSession.findUnique({ where: { id: rightId }, include: SESSION_INCLUDE }),
    ]);
    if (!left || !right) throw new NotFoundException('비교할 채촌 세션이 없습니다.');
    if (left.customerId !== right.customerId)
      throw new BusinessException('VALIDATION_ERROR', '같은 고객의 채촌 버전끼리만 비교할 수 있습니다.');

    const codes = new Map<string, { sortOrder: number; bodySection: string; unit: string }>();
    for (const v of [...left.values, ...right.values]) {
      if (!codes.has(v.measurementCode))
        codes.set(v.measurementCode, { sortOrder: v.sortOrder, bodySection: v.bodySection, unit: v.unit });
    }
    const leftMap = new Map(left.values.map((v) => [v.measurementCode, v]));
    const rightMap = new Map(right.values.map((v) => [v.measurementCode, v]));

    const items = [...codes.entries()]
      .sort((a, b) => a[1].sortOrder - b[1].sortOrder || a[0].localeCompare(b[0]))
      .map(([code, meta]) => {
        const lv = leftMap.get(code);
        const rv = rightMap.get(code);
        const prevNumeric = lv ? toNumberOrNull(lv.numericValue) : null;
        const currNumeric = rv ? toNumberOrNull(rv.numericValue) : null;
        const prevText = lv?.textValue ?? null;
        const currText = rv?.textValue ?? null;
        // 숫자값이 양쪽에 있을 때만 차이를 계산한다. 문자값은 변경 여부만 표시한다.
        const diff =
          prevNumeric !== null && currNumeric !== null
            ? Number((currNumeric - prevNumeric).toFixed(2))
            : null;
        return {
          measurementCode: code,
          label: MEASUREMENT_ITEM_MAP.get(code)?.label ?? code,
          bodySection: meta.bodySection,
          unit: meta.unit,
          previous: { numericValue: prevNumeric, textValue: prevText },
          current: { numericValue: currNumeric, textValue: currText },
          diff,
          changed: prevNumeric !== currNumeric || prevText !== currText,
        };
      });

    return {
      left: this.toCompareSide(left),
      right: this.toCompareSide(right),
      items,
    };
  }

  // ---------------------------------------------------------------------------
  // 생성·임시 저장·완료·복사
  // ---------------------------------------------------------------------------

  /** 신규 채촌 세션: version_no = 고객별 max+1, 값 배열 동시 저장 가능 */
  async create(customerId: string, dto: CreateMeasurementSessionDto, actor: AuthUser) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new BusinessException('CUSTOMER_NOT_FOUND', '고객이 없습니다.');
    await this.assertOrderOfCustomer(dto.relatedOrderId, customerId);
    if (dto.previousSessionId) {
      const prev = await this.prisma.measurementSession.findUnique({ where: { id: dto.previousSessionId } });
      if (!prev || prev.customerId !== customerId)
        throw new BusinessException('VALIDATION_ERROR', '이전 버전 세션이 올바르지 않습니다.', [
          { field: 'previousSessionId', reason: 'INVALID' },
        ]);
    }
    const { upserts: values } = this.normalizeValues(dto.values ?? [], { emptyMeansDelete: false });

    const session = await this.prisma.$transaction(async (tx) => {
      const versionNo = await this.nextVersionNo(tx, customerId);
      return tx.measurementSession.create({
        data: {
          id: randomUUID(),
          customerId,
          relatedOrderId: dto.relatedOrderId ?? null,
          versionNo,
          measurementDate: new Date(dto.measurementDate),
          measurementType: dto.measurementType ?? 'INITIAL',
          previousSessionId: dto.previousSessionId ?? null,
          fitPreference: dto.fitPreference ?? null,
          bodyNotes: dto.bodyNotes ?? null,
          notes: dto.notes ?? null,
          createdBy: actor.id,
          values: { create: values.map((v) => ({ id: randomUUID(), ...v })) },
        },
        include: SESSION_INCLUDE,
      });
    });

    await this.autoLink(session, actor);
    const detail = this.toDetail(session);
    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'MEASUREMENT_SESSION',
      entityId: session.id,
      after: detail,
    });
    return detail;
  }

  /**
   * 저장: 메타 수정 + 값 UPSERT/삭제 (설계서 09 §3.3).
   * 채촌은 '완료' 상태를 두지 않는다 — 계약완료·발주로 잠기기 전까지는 언제든 고친다.
   */
  async update(id: string, dto: UpdateMeasurementSessionDto, actor: AuthUser) {
    const before = await this.prisma.measurementSession.findUnique({
      where: { id },
      include: SESSION_INCLUDE,
    });
    if (!before) throw new NotFoundException('채촌 세션이 없습니다.');
    this.assertNotLocked(before, '수정');
    await this.assertOrderOfCustomer(dto.relatedOrderId, before.customerId);
    const { upserts: values, deleteCodes } = this.normalizeValues(dto.values ?? [], {
      emptyMeansDelete: true,
    });

    const session = await this.prisma.$transaction(async (tx) => {
      if (deleteCodes.length)
        await tx.measurementValue.deleteMany({
          where: { measurementSessionId: id, measurementCode: { in: deleteCodes } },
        });
      for (const v of values) {
        await tx.measurementValue.upsert({
          where: {
            measurementSessionId_measurementCode: {
              measurementSessionId: id,
              measurementCode: v.measurementCode,
            },
          },
          create: { id: randomUUID(), measurementSessionId: id, ...v },
          update: {
            bodySection: v.bodySection,
            numericValue: v.numericValue,
            textValue: v.textValue,
            unit: v.unit,
            sortOrder: v.sortOrder,
          },
        });
      }
      return tx.measurementSession.update({
        where: { id },
        data: {
          ...(dto.measurementDate ? { measurementDate: new Date(dto.measurementDate) } : {}),
          ...(dto.measurementType ? { measurementType: dto.measurementType } : {}),
          ...(dto.relatedOrderId ? { relatedOrderId: dto.relatedOrderId } : {}),
          ...(dto.fitPreference !== undefined ? { fitPreference: dto.fitPreference } : {}),
          ...(dto.bodyNotes !== undefined ? { bodyNotes: dto.bodyNotes } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        },
        include: SESSION_INCLUDE,
      });
    });

    await this.autoLink(session, actor);
    const detail = this.toDetail(session);
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'MEASUREMENT_SESSION',
      entityId: id,
      before: this.toDetail(before),
      after: detail,
    });
    return detail;
  }

  /**
   * 삭제 (설계서 09 §3.4). 작업지시서 근거로 쓰인 세션은 거부한다.
   * 값·품목 연결을 함께 정리하고, 이 세션을 이전 버전으로 참조하던 세션은 참조만 끊는다.
   */
  async remove(id: string, actor: AuthUser) {
    const session = await this.prisma.measurementSession.findUnique({
      where: { id },
      include: SESSION_INCLUDE,
    });
    if (!session) throw new NotFoundException('채촌 세션이 없습니다.');
    this.assertNotLocked(session, '삭제');

    const before = this.toDetail(session);
    await this.prisma.$transaction(async (tx) => {
      await tx.measurementValue.deleteMany({ where: { measurementSessionId: id } });
      await tx.orderItemMeasurement.deleteMany({ where: { measurementSessionId: id } });
      await tx.measurementSession.updateMany({
        where: { previousSessionId: id },
        data: { previousSessionId: null },
      });
      await tx.measurementSession.delete({ where: { id } });
    });

    await this.audit.log({
      userId: actor.id,
      action: 'DELETE',
      entityType: 'MEASUREMENT_SESSION',
      entityId: id,
      before,
    });
    return { id, deleted: true };
  }

  /** 기존 버전 복사: 새 날짜·구분으로 값 전체 복사, previous_session_id 연결 */
  async clone(id: string, dto: CloneMeasurementSessionDto, actor: AuthUser) {
    const source = await this.prisma.measurementSession.findUnique({
      where: { id },
      include: SESSION_INCLUDE,
    });
    if (!source) throw new NotFoundException('복사할 채촌 세션이 없습니다.');
    await this.assertOrderOfCustomer(dto.relatedOrderId, source.customerId);

    const session = await this.prisma.$transaction(async (tx) => {
      const versionNo = await this.nextVersionNo(tx, source.customerId);
      return tx.measurementSession.create({
        data: {
          id: randomUUID(),
          customerId: source.customerId,
          relatedOrderId: dto.relatedOrderId ?? source.relatedOrderId,
          versionNo,
          measurementDate: dto.measurementDate ? new Date(dto.measurementDate) : new Date(),
          measurementType: dto.measurementType ?? source.measurementType,
          previousSessionId: source.id,
          fitPreference: source.fitPreference,
          bodyNotes: source.bodyNotes,
          notes: dto.notes ?? null,
          createdBy: actor.id,
          values: {
            create: source.values.map((v) => ({
              id: randomUUID(),
              bodySection: v.bodySection,
              measurementCode: v.measurementCode,
              numericValue: v.numericValue,
              textValue: v.textValue,
              unit: v.unit,
              sortOrder: v.sortOrder,
            })),
          },
        },
        include: SESSION_INCLUDE,
      });
    });

    const detail = this.toDetail(session);
    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'MEASUREMENT_SESSION',
      entityId: session.id,
      after: detail,
      reason: `채촌 세션 복사 (원본 v${source.versionNo}, ${source.id})`,
    });
    return detail;
  }

  // ---------------------------------------------------------------------------
  // 품목-채촌 연결
  // ---------------------------------------------------------------------------

  /**
   * 채촌을 저장하면 아직 채촌이 없던 품목에 붙인다 (현업 확정 2026-08-05).
   * 규칙은 measurement-link 에 한 벌로 있다 — 계약완료 경로와 같은 규칙을 쓴다.
   */
  private async autoLink(session: { id: string; customerId: string; relatedOrderId: string | null }, actor: AuthUser) {
    const linked = await this.prisma.$transaction((tx) =>
      autoLinkMeasurements(tx, session.customerId, actor.id, {
        sessionId: session.id,
        ...(session.relatedOrderId ? { orderId: session.relatedOrderId } : {}),
      }),
    );
    if (!linked) return;
    await this.audit.log({
      userId: actor.id,
      action: 'LINK',
      entityType: 'MEASUREMENT_SESSION',
      entityId: session.id,
      after: { orderItemIds: linked.orderItemIds },
      reason: '채촌 저장 시 미연결 품목 자동 연결',
    });
  }

  /** 품목 사용 채촌 버전 지정: 품목당 is_current=true 1개 보장 (단일 트랜잭션 upsert) */
  async linkOrderItem(orderItemId: string, dto: LinkOrderItemMeasurementDto, actor: AuthUser) {
    const orderItem = await this.prisma.orderItem.findUnique({
      where: { id: orderItemId },
      include: { order: { select: { contract: { select: { customerId: true } } } } },
    });
    if (!orderItem) throw new NotFoundException('주문 품목이 없습니다.');
    if (dto.version !== undefined && dto.version !== orderItem.rowVersion)
      throw new BusinessException('VERSION_CONFLICT', '품목 정보가 변경되었습니다. 다시 조회해 주세요.');

    const session = await this.prisma.measurementSession.findUnique({
      where: { id: dto.measurementSessionId },
    });
    if (!session) throw new NotFoundException('채촌 세션이 없습니다.');
    if (session.customerId !== orderItem.order.contract.customerId)
      throw new BusinessException('VALIDATION_ERROR', '다른 고객의 채촌 세션은 연결할 수 없습니다.');
    // 완료 표시를 걷어냈으므로(2026-08-05) 붙일 수 있는 채촌은 **값이 든 채촌**이다.
    const valueCount = await this.prisma.measurementValue.count({
      where: { measurementSessionId: dto.measurementSessionId },
    });
    if (valueCount === 0)
      throw new BusinessException('MEASUREMENT_NOT_COMPLETE', '채촌값이 입력된 채촌만 품목에 연결할 수 있습니다.');

    const previousCurrent = await this.prisma.orderItemMeasurement.findFirst({
      where: { orderItemId, isCurrent: true },
    });

    const link = await this.prisma.$transaction(async (tx) => {
      await tx.orderItemMeasurement.updateMany({
        where: { orderItemId, isCurrent: true, NOT: { measurementSessionId: dto.measurementSessionId } },
        data: { isCurrent: false },
      });
      const existing = await tx.orderItemMeasurement.findFirst({
        where: { orderItemId, measurementSessionId: dto.measurementSessionId },
      });
      const result = existing
        ? await tx.orderItemMeasurement.update({
            where: { id: existing.id },
            data: { isCurrent: true, linkedBy: actor.id, linkedAt: new Date() },
          })
        : await tx.orderItemMeasurement.create({
            data: {
              id: randomUUID(),
              orderItemId,
              measurementSessionId: dto.measurementSessionId,
              isCurrent: true,
              linkedBy: actor.id,
            },
          });
      if (dto.version !== undefined)
        await tx.orderItem.update({ where: { id: orderItemId }, data: { rowVersion: { increment: 1 } } });
      // 담당자가 직접 고른 채촌도 준비가 끝난 것이다 — 자동 연결과 같게 반영한다.
      await syncPrepStatuses(tx, [orderItemId], actor.id);
      return result;
    });

    await this.audit.log({
      userId: actor.id,
      action: 'LINK',
      entityType: 'ORDER_ITEM_MEASUREMENT',
      entityId: link.id,
      before: previousCurrent
        ? { orderItemId, measurementSessionId: previousCurrent.measurementSessionId }
        : null,
      after: { orderItemId, measurementSessionId: link.measurementSessionId, isCurrent: true },
    });
    return {
      id: link.id,
      orderItemId: link.orderItemId,
      measurementSessionId: link.measurementSessionId,
      sessionVersionNo: session.versionNo,
      isCurrent: link.isCurrent,
      linkedBy: link.linkedBy,
      linkedAt: link.linkedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // 이미지 첨부 (설계서 05 §4 — 범용 EntityFile 재사용, 스키마 무변경)
  // ---------------------------------------------------------------------------

  /** 세션 첨부 이미지 목록 (정렬: createdAt) */
  async listImages(sessionId: string) {
    await this.getSessionOrThrow(sessionId);
    const links = await this.prisma.entityFile.findMany({
      where: { entityType: IMAGE_ENTITY_TYPE, entityId: sessionId, purpose: IMAGE_PURPOSE },
      orderBy: { createdAt: 'asc' },
      include: { file: true },
    });
    return links.map((l) => this.toImageView(l));
  }

  /**
   * 이미지 추가: files 모듈로 업로드(File 생성) → 세션에 EntityFile로 연결.
   * 50장 초과면 업로드 전에 거부해 고아 파일이 남지 않게 한다.
   *
   * 잠금 세션(작업지시서 출력됨) 정책(설계서 05 미결 M4): 이미지는 치수 데이터가 아니라
   * assertNotLocked 대상에서 제외한다(출력 후에도 사진 첨부 허용). 세션 존재만 검증한다.
   */
  async addImage(sessionId: string, file: UploadedMulterFile | undefined, actor: AuthUser) {
    await this.getSessionOrThrow(sessionId);
    const count = await this.prisma.entityFile.count({
      where: { entityType: IMAGE_ENTITY_TYPE, entityId: sessionId, purpose: IMAGE_PURPOSE },
    });
    if (count >= MAX_IMAGES)
      throw new BusinessException(
        'VALIDATION_ERROR',
        `첨부 사진은 최대 ${MAX_IMAGES}장까지 등록할 수 있습니다.`,
        [{ field: 'images', reason: 'MAX_50_EXCEEDED' }],
      );

    const uploaded = await this.files.upload(file, actor);
    const link = await this.prisma.entityFile.create({
      data: {
        id: randomUUID(),
        fileId: uploaded.id,
        entityType: IMAGE_ENTITY_TYPE,
        entityId: sessionId,
        purpose: IMAGE_PURPOSE,
      },
      include: { file: true },
    });
    const view = this.toImageView(link);
    await this.audit.log({
      userId: actor.id,
      // 파일을 올린 일은 '연결'(LINK)보다 '첨부'로 읽혀야 한다 — 가봉 첨부와 같은 코드를 쓴다.
      action: 'UPLOAD',
      entityType: 'MEASUREMENT_SESSION_IMAGE',
      entityId: sessionId,
      after: { fileId: uploaded.id, entityFileId: link.id, originalName: uploaded.originalName },
    });
    return view;
  }

  /**
   * 이미지 제거: 세션-파일 연결(EntityFile)을 끊고, 다른 참조가 없으면 File 원본까지 정리한다.
   * 잠금 세션도 이미지 삭제는 허용한다(M4 기본 허용).
   */
  async removeImage(sessionId: string, fileId: string, actor: AuthUser) {
    await this.getSessionOrThrow(sessionId);
    const link = await this.prisma.entityFile.findFirst({
      where: {
        entityType: IMAGE_ENTITY_TYPE,
        entityId: sessionId,
        purpose: IMAGE_PURPOSE,
        fileId,
      },
    });
    if (!link) throw new NotFoundException('첨부 이미지가 없습니다.');

    await this.prisma.entityFile.delete({ where: { id: link.id } });
    await this.audit.log({
      userId: actor.id,
      action: 'UNLINK',
      entityType: 'MEASUREMENT_SESSION_IMAGE',
      entityId: sessionId,
      before: { fileId, entityFileId: link.id },
    });
    // 참조가 남지 않은 파일만 정리한다. FilesService.remove는 참조 시 예외를 던지므로 무시한다.
    await this.files.remove(fileId, actor).catch(() => undefined);
    return { fileId, deleted: true };
  }

  private async getSessionOrThrow(sessionId: string) {
    const session = await this.prisma.measurementSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('채촌 세션이 없습니다.');
    return session;
  }

  private toImageView(link: {
    id: string;
    fileId: string;
    createdAt: Date;
    file: { originalName: string; mimeType: string; sizeBytes: bigint };
  }) {
    return {
      id: link.id,
      fileId: link.fileId,
      originalName: link.file.originalName,
      mimeType: link.file.mimeType,
      sizeBytes: Number(link.file.sizeBytes),
      downloadUrl: `/api/v1/files/${link.fileId}`,
      createdAt: link.createdAt,
    };
  }

  // ---------------------------------------------------------------------------
  // 내부 유틸
  // ---------------------------------------------------------------------------

  private async nextVersionNo(tx: Prisma.TransactionClient, customerId: string): Promise<number> {
    const max = await tx.measurementSession.aggregate({
      where: { customerId },
      _max: { versionNo: true },
    });
    return (max._max.versionNo ?? 0) + 1;
  }

  /**
   * 값 정규화: 코드 자유 수용 + 카탈로그 보완.
   * 생성 시에는 numeric/text 중 하나가 필수지만, 수정 시에는 둘 다 비면
   * "해당 항목 지우기"로 해석한다 (설계서 09 §3.3 — 화면에서 값을 비우면 삭제).
   */
  private normalizeValues(
    inputs: MeasurementValueInputDto[],
    options: { emptyMeansDelete: boolean },
  ): { upserts: NormalizedValue[]; deleteCodes: string[] } {
    const seen = new Set<string>();
    const upserts: NormalizedValue[] = [];
    const deleteCodes: string[] = [];

    for (const input of inputs) {
      const code = input.measurementCode.trim().toUpperCase();
      if (seen.has(code))
        throw new BusinessException('VALIDATION_ERROR', '중복된 채촌 항목 코드가 있습니다.', [
          { field: `values.${code}`, reason: 'DUPLICATE_CODE' },
        ]);
      seen.add(code);

      const numericValue = input.numericValue ?? null;
      const textValue = input.textValue?.trim() ? input.textValue.trim() : null;
      if (numericValue === null && textValue === null) {
        if (options.emptyMeansDelete) {
          deleteCodes.push(code);
          continue;
        }
        throw new BusinessException('VALIDATION_ERROR', '숫자값 또는 문자값 중 하나는 입력해야 합니다.', [
          { field: `values.${code}`, reason: 'VALUE_REQUIRED' },
        ]);
      }

      const def = MEASUREMENT_ITEM_MAP.get(code);
      upserts.push({
        measurementCode: code,
        bodySection: input.bodySection?.trim().toUpperCase() ?? def?.bodySection ?? 'ETC',
        numericValue,
        textValue,
        unit: input.unit?.trim().toUpperCase() ?? 'CM',
        sortOrder: input.sortOrder ?? def?.sortOrder ?? 900,
      });
    }
    return { upserts, deleteCodes };
  }

  /**
   * 편집 잠금 판정 — 규칙은 isMeasurementLocked 에 있다.
   */
  private assertNotLocked(session: LockSource, action: string): void {
    if (isMeasurementLocked(session))
      throw new BusinessException(
        'MEASUREMENT_LOCKED',
        `계약이 완료됐거나 발주가 나간 채촌은 ${action}할 수 없습니다. 복사(POST /measurements/{id}/clone)로 새로 등록해 주세요.`,
      );
  }

  private async assertOrderOfCustomer(orderId: string | undefined, customerId: string): Promise<void> {
    if (!orderId) return;
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { contract: { select: { customerId: true } } },
    });
    if (!order || order.contract.customerId !== customerId)
      throw new BusinessException('VALIDATION_ERROR', '관련 주문이 올바르지 않습니다.', [
        { field: 'relatedOrderId', reason: 'INVALID' },
      ]);
  }

  private toCompareSide(session: SessionWithValues) {
    return {
      id: session.id,
      customerId: session.customerId,
      customerName: session.customer.name,
      versionNo: session.versionNo,
      measurementDate: toDateString(session.measurementDate),
      measurementType: session.measurementType,
      fitPreference: session.fitPreference,
      bodyNotes: session.bodyNotes,
    };
  }

  private toDetail(session: SessionWithValues) {
    // 계약은 연결 주문(relatedOrder)이 우선, 없으면 사용 품목이 속한 계약에서 가져온다.
    const linkedOrder = session.orderItemLinks[0]?.orderItem.order;
    const contractId = session.relatedOrder?.contractId ?? linkedOrder?.contractId ?? null;
    const contractNo =
      session.relatedOrder?.contract.contractNo ?? linkedOrder?.contract.contractNo ?? null;
    return {
      id: session.id,
      customerId: session.customerId,
      customerName: session.customer.name,
      customerPhone: session.customer.phone,
      staffName: session.createdByUser.displayName,
      contractId,
      contractNo,
      linkedOrderItems: session.orderItemLinks.map((l) => ({
        id: l.orderItem.id,
        displayName: l.orderItem.displayName,
        productCategory: l.orderItem.productCategory,
      })),
      workOrderVersionCount: session._count.workOrderVersions,
      locked: isMeasurementLocked(session),
      relatedOrderId: session.relatedOrderId,
      versionNo: session.versionNo,
      measurementDate: toDateString(session.measurementDate),
      measurementType: session.measurementType,
      previousSessionId: session.previousSessionId,
      fitPreference: session.fitPreference,
      bodyNotes: session.bodyNotes,
      notes: session.notes,
      createdBy: session.createdByUser,
      createdAt: session.createdAt,
      values: session.values.map((v) => ({
        id: v.id,
        bodySection: v.bodySection,
        measurementCode: v.measurementCode,
        label: MEASUREMENT_ITEM_MAP.get(v.measurementCode)?.label ?? v.measurementCode,
        numericValue: toNumberOrNull(v.numericValue),
        textValue: v.textValue,
        unit: v.unit,
        sortOrder: v.sortOrder,
      })),
    };
  }
}
