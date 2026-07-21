import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MEASUREMENT_ITEM_MAP } from './measurement-catalog';
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

const SESSION_INCLUDE = {
  createdByUser: { select: { id: true, displayName: true } },
  customer: { select: { id: true, name: true, phone: true } },
  values: { orderBy: [{ sortOrder: 'asc' }, { measurementCode: 'asc' }] },
  orderItemLinks: {
    where: { isCurrent: true },
    select: { orderItem: { select: { id: true, displayName: true, productCategory: true } } },
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
    if (query.status) where.completedAt = query.status === 'COMPLETED' ? { not: null } : null;

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
            select: { orderItem: { select: { id: true, displayName: true, productCategory: true } } },
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
      completed: s.completedAt !== null,
      completedAt: s.completedAt,
      staffName: s.createdByUser.displayName,
      createdBy: s.createdByUser,
      valueCount: s._count.values,
      linkedOrderItems: s.orderItemLinks.map((l) => l.orderItem),
      linkedOrderItemCount: s.orderItemLinks.length,
      workOrderVersionCount: s._count.workOrderVersions,
      locked: s._count.workOrderVersions > 0,
      fitPreference: s.fitPreference,
      previousSessionId: s.previousSessionId,
      createdAt: s.createdAt,
    }));
    return new Paginated(items, query.page, query.size, total);
  }

  /** MEAS-001 채촌 이력: 버전 목록(최신 순) + 현재 연결 품목 */
  async listByCustomer(customerId: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new BusinessException('CUSTOMER_NOT_FOUND', '고객이 없습니다.');

    const sessions = await this.prisma.measurementSession.findMany({
      where: { customerId },
      orderBy: { versionNo: 'desc' },
      include: {
        createdByUser: { select: { id: true, displayName: true } },
        _count: { select: { values: true } },
        orderItemLinks: {
          where: { isCurrent: true },
          select: { orderItem: { select: { id: true, displayName: true, productCategory: true } } },
        },
      },
    });
    return sessions.map((s) => ({
      id: s.id,
      versionNo: s.versionNo,
      measurementDate: toDateString(s.measurementDate),
      measurementType: s.measurementType,
      previousSessionId: s.previousSessionId,
      fitPreference: s.fitPreference,
      completed: s.completedAt !== null,
      completedAt: s.completedAt,
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
   * 완료 여부는 편집을 막지 않는다. 작업지시서 출력 근거로 쓰인 세션만 잠근다.
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

    const detail = this.toDetail(session);
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'MEASUREMENT_SESSION',
      entityId: id,
      before: this.toDetail(before),
      after: detail,
      ...(before.completedAt !== null ? { reason: '완료 후 수정' } : {}),
    });
    return detail;
  }

  /** 완료 해제: 완료 → 수정 → 재완료 흐름용 (설계서 09 §3.5) */
  async reopen(id: string, actor: AuthUser) {
    const session = await this.prisma.measurementSession.findUnique({
      where: { id },
      include: SESSION_INCLUDE,
    });
    if (!session) throw new NotFoundException('채촌 세션이 없습니다.');
    if (session.completedAt === null)
      throw new BusinessException('INVALID_STATUS_TRANSITION', '완료 상태가 아닌 채촌 세션입니다.');
    this.assertNotLocked(session, '완료 해제');

    const reopened = await this.prisma.measurementSession.update({
      where: { id },
      data: { completedAt: null },
      include: SESSION_INCLUDE,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'MEASUREMENT_SESSION',
      entityId: id,
      before: { completedAt: session.completedAt },
      after: { completedAt: null },
      reason: '채촌 완료 해제',
    });
    return this.toDetail(reopened);
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

  /**
   * 완료 처리: completed_at 컬럼에 완료 시각을 기록한다 (연동정합화 계약 §9).
   * 완료 판정·편집 차단·품목 연결 선행조건은 모두 이 컬럼 기준이며,
   * 감사로그(action=COMPLETE)는 이력 기록 용도로만 남긴다.
   */
  async complete(id: string, actor: AuthUser) {
    const session = await this.prisma.measurementSession.findUnique({
      where: { id },
      include: SESSION_INCLUDE,
    });
    if (!session) throw new NotFoundException('채촌 세션이 없습니다.');
    if (session.completedAt !== null)
      throw new BusinessException('INVALID_STATUS_TRANSITION', '이미 완료된 채촌 세션입니다.');
    if (session.values.length === 0)
      throw new BusinessException('MEASUREMENT_NOT_COMPLETE', '채촌값이 1개 이상 입력되어야 완료할 수 있습니다.');

    const completed = await this.prisma.measurementSession.update({
      where: { id },
      data: { completedAt: new Date() },
      include: SESSION_INCLUDE,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'COMPLETE',
      entityType: 'MEASUREMENT_SESSION',
      entityId: id,
      after: {
        versionNo: completed.versionNo,
        valueCount: completed.values.length,
        completedAt: completed.completedAt,
      },
    });
    return this.toDetail(completed);
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
    if (session.completedAt === null)
      throw new BusinessException('MEASUREMENT_NOT_COMPLETE', '완료된 채촌 세션만 품목에 연결할 수 있습니다.');

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
   * 편집 잠금 판정 (설계서 09 §2.1): 작업지시서가 이 채촌을 근거로 출력된 뒤에는
   * 수정·삭제·완료해제를 막는다. 완료 여부 자체는 편집을 막지 않는다.
   */
  private assertNotLocked(session: { _count: { workOrderVersions: number } }, action: string): void {
    if (session._count.workOrderVersions > 0)
      throw new BusinessException(
        'MEASUREMENT_LOCKED',
        `작업지시서 출력에 사용된 채촌은 ${action}할 수 없습니다. 복사(POST /measurements/{id}/clone)로 새 버전을 만들어 주세요.`,
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
    return {
      id: session.id,
      customerId: session.customerId,
      customerName: session.customer.name,
      customerPhone: session.customer.phone,
      staffName: session.createdByUser.displayName,
      linkedOrderItems: session.orderItemLinks.map((l) => l.orderItem),
      workOrderVersionCount: session._count.workOrderVersions,
      locked: session._count.workOrderVersions > 0,
      relatedOrderId: session.relatedOrderId,
      versionNo: session.versionNo,
      measurementDate: toDateString(session.measurementDate),
      measurementType: session.measurementType,
      previousSessionId: session.previousSessionId,
      fitPreference: session.fitPreference,
      bodyNotes: session.bodyNotes,
      notes: session.notes,
      completed: session.completedAt !== null,
      completedAt: session.completedAt,
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
