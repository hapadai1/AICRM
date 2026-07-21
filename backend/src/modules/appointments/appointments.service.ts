import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CustomersService } from '../customers/customers.service';
import {
  NAVER_RESERVATION_ADAPTER,
  NaverReservationAdapter,
  NaverReservationRecord,
} from './adapters/naver-reservation.adapter';
import {
  toAppointmentView,
  toConsultationView,
} from './appointment-view';
import {
  APPOINTMENT_STATUSES,
  AppointmentListQueryDto,
  CreateAppointmentDto,
  CreateConsultationDto,
  UpdateConsultationDto,
  UpdateAppointmentDto,
} from './appointments.dto';

/** 허용 상태 전이 (설계서 19 — 허용 전이 외 변경 차단) */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  RESERVED: ['CONFIRMED', 'VISITED', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['VISITED', 'CANCELLED', 'NO_SHOW'],
  VISITED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

const APPOINTMENT_INCLUDE = {
  customer: { select: { id: true, name: true, phone: true, customerStatus: true } },
  purpose: { select: { id: true, code: true, name: true } },
} as const;

const CONSULTATION_INCLUDE = {
  staff: { select: { id: true, displayName: true } },
} as const;

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly customersService: CustomersService,
    @Inject(NAVER_RESERVATION_ADAPTER) private readonly naverAdapter: NaverReservationAdapter,
  ) {}

  async list(query: AppointmentListQueryDto): Promise<Paginated<unknown>> {
    const where: Prisma.AppointmentWhereInput = {};
    if (query.from || query.to) {
      const range: Prisma.DateTimeFilter = {};
      if (query.from) range.gte = new Date(query.from);
      if (query.to) {
        // 날짜만 주어지면 해당 일 전체를 포함한다
        const to = new Date(query.to);
        if (query.to.length === 10) to.setDate(to.getDate() + 1);
        range.lt = to;
      }
      if (range.gte && range.lt && range.gte > range.lt) {
        throw new BusinessException('VALIDATION_ERROR', '조회 기간이 올바르지 않습니다.', [
          { field: 'from', reason: 'INVALID_DATE_RANGE' },
        ]);
      }
      where.scheduledStart = range;
    }
    const purposeCodes = splitCsv(query.purposeCodes);
    if (purposeCodes.length > 0) where.purpose = { code: { in: purposeCodes } };
    else if (query.purpose) where.purpose = { code: query.purpose };

    const statuses = splitCsv(query.statuses);
    if (statuses.length > 0) {
      const unknown = statuses.filter((s) => !(APPOINTMENT_STATUSES as readonly string[]).includes(s));
      if (unknown.length > 0) {
        throw new BusinessException('VALIDATION_ERROR', '유효하지 않은 예약 상태입니다.', [
          { field: 'statuses', reason: 'UNKNOWN_STATUS' },
        ]);
      }
      where.status = { in: statuses };
    } else if (query.status) where.status = query.status;

    if (query.source) where.source = query.source;
    if (query.customerId) where.customerId = query.customerId;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.appointment.findMany({
        where,
        include: APPOINTMENT_INCLUDE,
        orderBy: { scheduledStart: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.appointment.count({ where }),
    ]);
    return new Paginated(items.map(toAppointmentView), query.page, query.size, total);
  }

  /** 예약 목적 목록 (active만, 정렬 순서대로) — 연동정합화 계약 §1 */
  listPurposes() {
    return this.prisma.appointmentPurpose.findMany({
      where: { active: true },
      select: { id: true, code: true, name: true, sortOrder: true },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
  }

  /**
   * CRM 직접 등록. 전화번호로 기존 고객을 연결하거나 PROSPECT를 신규 생성한다
   * (데이터모델설계서 15.1).
   */
  async create(dto: CreateAppointmentDto, actor: AuthUser) {
    const purpose = await this.resolvePurpose(dto.purposeCode);
    const scheduledStart = new Date(dto.scheduledStart);

    let customerId: string;
    if (dto.customerId) {
      const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
      if (!customer) throw new BusinessException('CUSTOMER_NOT_FOUND', '고객이 없습니다.');
      if (!customer.firstReservedAt) {
        await this.prisma.customer.update({
          where: { id: customer.id },
          data: { firstReservedAt: scheduledStart },
        });
      }
      customerId = customer.id;
    } else {
      if (!dto.phone) {
        throw new BusinessException('VALIDATION_ERROR', 'customerId 또는 전화번호가 필요합니다.', [
          { field: 'phone', reason: 'REQUIRED' },
        ]);
      }
      const { customer } = await this.customersService.linkOrCreateProspectByPhone(
        { name: dto.customerName, phone: dto.phone, email: dto.email },
        scheduledStart,
        actor.id,
      );
      customerId = customer.id;
    }

    const appointment = await this.prisma.appointment.create({
      data: {
        id: randomUUID(),
        customerId,
        source: 'CRM',
        purposeId: purpose.id,
        scheduledStart,
        scheduledEnd: dto.scheduledEnd ? new Date(dto.scheduledEnd) : null,
        status: 'RESERVED',
        notes: dto.notes,
      },
      include: APPOINTMENT_INCLUDE,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'APPOINTMENT',
      entityId: appointment.id,
      after: appointment,
    });
    return toAppointmentView(appointment);
  }

  async detail(id: string) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id },
      include: {
        ...APPOINTMENT_INCLUDE,
        consultations: { orderBy: { consultedAt: 'desc' }, include: CONSULTATION_INCLUDE },
      },
    });
    if (!appointment) throw new BusinessException('NOT_FOUND', '예약이 없습니다.');
    return {
      ...toAppointmentView(appointment),
      consultations: appointment.consultations.map(toConsultationView),
    };
  }

  /** 예약 수정. 네이버 수집 예약을 CRM에서 수정하면 localOverride=true (설계서 5.1 변경 이력). */
  async update(id: string, dto: UpdateAppointmentDto, actor: AuthUser) {
    const before = await this.prisma.appointment.findUnique({ where: { id } });
    if (!before) throw new BusinessException('NOT_FOUND', '예약이 없습니다.');

    const data: Prisma.AppointmentUpdateManyMutationInput & { purposeId?: string; customerId?: string } = {};
    if (dto.purposeCode !== undefined) {
      data.purposeId = (await this.resolvePurpose(dto.purposeCode)).id;
    }
    if (dto.scheduledStart !== undefined) data.scheduledStart = new Date(dto.scheduledStart);
    if (dto.scheduledEnd !== undefined) data.scheduledEnd = new Date(dto.scheduledEnd);
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.customerId !== undefined) {
      const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
      if (!customer) throw new BusinessException('CUSTOMER_NOT_FOUND', '연결할 고객이 없습니다.');
      data.customerId = dto.customerId;
    }
    if (before.source === 'NAVER') data.localOverride = true;

    const result = await this.prisma.appointment.updateMany({
      where: { id, rowVersion: dto.version },
      data: { ...data, rowVersion: { increment: 1 } },
    });
    if (result.count === 0) {
      throw new BusinessException(
        'VERSION_CONFLICT',
        '다른 사용자가 먼저 수정했습니다. 최신 정보를 다시 조회해 주세요.',
        undefined,
        { currentVersion: before.rowVersion },
      );
    }

    const after = await this.prisma.appointment.findUniqueOrThrow({
      where: { id },
      include: APPOINTMENT_INCLUDE,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'APPOINTMENT',
      entityId: id,
      before,
      after,
    });
    return toAppointmentView(after);
  }

  /** 예약 확정 처리 (RESERVED → CONFIRMED) */
  async confirm(id: string, actor: AuthUser) {
    return this.transition(id, 'CONFIRMED', actor, undefined, 'STATUS_CHANGE');
  }

  /** 방문 완료 처리 (RESERVED/CONFIRMED → VISITED) */
  async markVisited(id: string, actor: AuthUser) {
    return this.transition(id, 'VISITED', actor, undefined, 'STATUS_CHANGE');
  }

  /** 노쇼 처리 (RESERVED/CONFIRMED → NO_SHOW) */
  async markNoShow(id: string, actor: AuthUser) {
    return this.transition(id, 'NO_SHOW', actor, undefined, 'STATUS_CHANGE');
  }

  /** 예약 취소. 레코드를 삭제하지 않고 CANCELLED로 보존한다 (설계서 19). */
  async cancel(id: string, reason: string, actor: AuthUser) {
    return this.transition(id, 'CANCELLED', actor, reason, 'CANCEL');
  }

  /**
   * 네이버 충돌 해소 (연동정합화 계약 §1).
   * - NAVER: 네이버 원본 채택 — 어댑터에 최신 레코드가 있으면 반영하고 localOverride 해제 → NORMAL
   * - CRM: CRM 수정본 유지 — 네이버 변경분을 확인 처리(syncedAt 갱신) → LOCAL_EDITED/NORMAL
   */
  async resolveConflict(id: string, resolution: 'NAVER' | 'CRM', actor: AuthUser) {
    const before = await this.prisma.appointment.findUnique({ where: { id } });
    if (!before) throw new BusinessException('NOT_FOUND', '예약이 없습니다.');
    if (before.source !== 'NAVER') {
      throw new BusinessException('VALIDATION_ERROR', '네이버 수집 예약만 충돌 해소 대상입니다.', [
        { field: 'resolution', reason: 'NOT_NAVER_APPOINTMENT' },
      ]);
    }

    const now = new Date();
    let data: Prisma.AppointmentUpdateInput;
    if (resolution === 'NAVER') {
      const records = await this.naverAdapter.fetchReservations();
      const record = records.find((r) => r.externalId === before.externalId);
      data = {
        localOverride: false,
        syncedAt: now,
        ...(record
          ? {
              scheduledStart: new Date(record.scheduledStart),
              scheduledEnd: record.scheduledEnd ? new Date(record.scheduledEnd) : null,
              status: record.status,
              notes: record.notes ?? before.notes,
              naverUpdatedAt: record.naverUpdatedAt ? new Date(record.naverUpdatedAt) : now,
            }
          : {}),
      };
    } else {
      data = { syncedAt: now };
    }

    const after = await this.prisma.appointment.update({
      where: { id },
      data: { ...data, rowVersion: { increment: 1 } },
      include: APPOINTMENT_INCLUDE,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'APPOINTMENT',
      entityId: id,
      before,
      after,
      reason: `동기화 충돌 해소: ${resolution}`,
    });
    return toAppointmentView(after);
  }

  /** 상담 저장 (APPT-002). interests[]는 consultation_category에 콤마로 저장한다. */
  async addConsultation(appointmentId: string, dto: CreateConsultationDto, actor: AuthUser) {
    const appointment = await this.prisma.appointment.findUnique({ where: { id: appointmentId } });
    if (!appointment) throw new BusinessException('NOT_FOUND', '예약이 없습니다.');

    let consultationCategory = dto.consultationCategory ?? null;
    if (dto.interests !== undefined) {
      const joined = dto.interests.map((s) => s.trim()).filter(Boolean).join(',');
      if (joined.length > 30) {
        // consultation_category varchar(30) 제약 (스키마 변경 금지 범위)
        throw new BusinessException('VALIDATION_ERROR', '관심 품목 목록이 너무 깁니다. (최대 30자)', [
          { field: 'interests', reason: 'TOO_LONG' },
        ]);
      }
      consultationCategory = joined || null;
    }

    const consultation = await this.prisma.consultation.create({
      data: {
        id: randomUUID(),
        customerId: appointment.customerId,
        appointmentId,
        consultedAt: dto.consultedAt ? new Date(dto.consultedAt) : new Date(),
        consultationCategory,
        content: dto.content,
        staffId: actor.id,
        ...this.intakeData(dto),
      },
      include: CONSULTATION_INCLUDE,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'CONSULTATION',
      entityId: consultation.id,
      after: consultation,
    });
    return toConsultationView(consultation);
  }

  /**
   * 초도 상담 항목을 저장 형태로 정규화한다 (개발설계서 05 G-01).
   * 예산은 한쪽만 들어오면 같은 값으로 채워 범위를 온전히 남긴다.
   */
  private intakeData(dto: {
    usageType?: string;
    budgetMin?: number;
    budgetMax?: number;
    preferredStyle?: string;
    desiredDueDate?: string;
  }) {
    const min = dto.budgetMin ?? dto.budgetMax;
    const max = dto.budgetMax ?? dto.budgetMin;
    if (min !== undefined && max !== undefined && min > max)
      throw new BusinessException('VALIDATION_ERROR', '예산 하한이 상한보다 클 수 없습니다.', [
        { field: 'budgetMin', reason: 'GREATER_THAN_MAX' },
      ]);
    return {
      ...(dto.usageType !== undefined ? { usageType: dto.usageType } : {}),
      ...(min !== undefined ? { budgetMin: min, budgetMax: max } : {}),
      ...(dto.preferredStyle !== undefined ? { preferredStyle: dto.preferredStyle } : {}),
      ...(dto.desiredDueDate !== undefined
        ? { desiredDueDate: new Date(dto.desiredDueDate) }
        : {}),
    };
  }

  /** 상담 내용 정정 (개발설계서 05 G-01) */
  async updateConsultation(id: string, dto: UpdateConsultationDto, actor: AuthUser) {
    const before = await this.prisma.consultation.findUnique({ where: { id } });
    if (!before) throw new BusinessException('NOT_FOUND', '상담 기록이 없습니다.');

    let consultationCategory: string | null | undefined;
    if (dto.interests !== undefined) {
      const joined = dto.interests.map((s) => s.trim()).filter(Boolean).join(',');
      if (joined.length > 30)
        throw new BusinessException('VALIDATION_ERROR', '관심 품목 목록이 너무 깁니다. (최대 30자)', [
          { field: 'interests', reason: 'TOO_LONG' },
        ]);
      consultationCategory = joined || null;
    }

    const consultation = await this.prisma.consultation.update({
      where: { id },
      data: {
        ...(dto.content !== undefined ? { content: dto.content } : {}),
        ...(dto.consultedAt !== undefined ? { consultedAt: new Date(dto.consultedAt) } : {}),
        ...(consultationCategory !== undefined ? { consultationCategory } : {}),
        ...this.intakeData(dto),
      },
      include: CONSULTATION_INCLUDE,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'CONSULTATION',
      entityId: id,
      before,
      after: consultation,
    });
    return toConsultationView(consultation);
  }

  async listConsultationsByAppointment(appointmentId: string) {
    const rows = await this.prisma.consultation.findMany({
      where: { appointmentId },
      include: CONSULTATION_INCLUDE,
      orderBy: { consultedAt: 'desc' },
    });
    return rows.map(toConsultationView);
  }

  /** 고객 상담 이력. 미계약 고객의 상담 이력도 보존·조회한다 (데이터모델 5.4). */
  async listConsultationsByCustomer(customerId: string) {
    const rows = await this.prisma.consultation.findMany({
      where: { customerId },
      include: {
        ...CONSULTATION_INCLUDE,
        appointment: {
          select: { id: true, scheduledStart: true, purpose: { select: { code: true, name: true } } },
        },
      },
      orderBy: { consultedAt: 'desc' },
    });
    return rows.map((row) => ({
      ...toConsultationView(row),
      appointment: row.appointment
        ? {
            id: row.appointment.id,
            startAt: row.appointment.scheduledStart,
            purposeCode: row.appointment.purpose.code,
            purposeName: row.appointment.purpose.name,
          }
        : null,
    }));
  }

  /**
   * 네이버 예약 수동 동기화 (단방향 수집).
   * source+externalId 기준 upsert, 취소는 삭제 없이 CANCELLED 반영.
   * CRM 수정본(localOverride)은 자동 덮어쓰지 않는다 (데이터모델 5.3 규칙).
   */
  async syncNaverReservations(actor: AuthUser) {
    const reservations = await this.naverAdapter.fetchReservations();
    const now = new Date();
    let created = 0;
    let updated = 0;
    let cancelled = 0;

    for (const record of reservations) {
      const existing = await this.prisma.appointment.findFirst({
        where: { source: 'NAVER', externalId: record.externalId },
      });
      if (!existing) {
        await this.createFromNaver(record, now, actor);
        created += 1;
        if (record.status === 'CANCELLED') cancelled += 1;
        continue;
      }

      if (record.status === 'CANCELLED') {
        if (existing.status !== 'CANCELLED') {
          const after = await this.prisma.appointment.update({
            where: { id: existing.id },
            data: {
              status: 'CANCELLED',
              naverUpdatedAt: record.naverUpdatedAt ? new Date(record.naverUpdatedAt) : now,
              syncedAt: now,
              rowVersion: { increment: 1 },
            },
          });
          await this.audit.log({
            userId: actor.id,
            action: 'CANCEL',
            entityType: 'APPOINTMENT',
            entityId: existing.id,
            before: existing,
            after,
            reason: '네이버 예약 취소 동기화',
          });
          cancelled += 1;
        }
        continue;
      }

      if (existing.localOverride) {
        // CRM 로컬 수정과 충돌: 자동 덮어쓰기 대신 동기화 시각만 기록 (확인 대상)
        await this.prisma.appointment.update({
          where: { id: existing.id },
          data: {
            syncedAt: now,
            naverUpdatedAt: record.naverUpdatedAt ? new Date(record.naverUpdatedAt) : existing.naverUpdatedAt,
          },
        });
        continue;
      }

      const after = await this.prisma.appointment.update({
        where: { id: existing.id },
        data: {
          scheduledStart: new Date(record.scheduledStart),
          scheduledEnd: record.scheduledEnd ? new Date(record.scheduledEnd) : null,
          status: record.status,
          notes: record.notes ?? existing.notes,
          naverUpdatedAt: record.naverUpdatedAt ? new Date(record.naverUpdatedAt) : now,
          syncedAt: now,
          rowVersion: { increment: 1 },
        },
      });
      await this.audit.log({
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'APPOINTMENT',
        entityId: existing.id,
        before: existing,
        after,
        reason: '네이버 예약 변경 동기화',
      });
      updated += 1;
    }

    return { fetched: reservations.length, created, updated, cancelled };
  }

  private async createFromNaver(record: NaverReservationRecord, now: Date, actor: AuthUser) {
    const purpose = await this.resolvePurpose(record.purposeCode);
    const scheduledStart = new Date(record.scheduledStart);
    const { customer } = await this.customersService.linkOrCreateProspectByPhone(
      { name: record.customerName, phone: record.phone },
      scheduledStart,
      actor.id,
    );
    const appointment = await this.prisma.appointment.create({
      data: {
        id: randomUUID(),
        customerId: customer.id,
        source: 'NAVER',
        externalId: record.externalId,
        purposeId: purpose.id,
        scheduledStart,
        scheduledEnd: record.scheduledEnd ? new Date(record.scheduledEnd) : null,
        status: record.status,
        notes: record.notes,
        naverUpdatedAt: record.naverUpdatedAt ? new Date(record.naverUpdatedAt) : now,
        syncedAt: now,
      },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'APPOINTMENT',
      entityId: appointment.id,
      after: appointment,
      reason: '네이버 예약 동기화',
    });
    return appointment;
  }

  private async transition(id: string, next: string, actor: AuthUser, reason?: string, action = 'STATUS_CHANGE') {
    const before = await this.prisma.appointment.findUnique({ where: { id } });
    if (!before) throw new BusinessException('NOT_FOUND', '예약이 없습니다.');

    const allowed = ALLOWED_TRANSITIONS[before.status] ?? [];
    if (!allowed.includes(next)) {
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        `현재 상태(${before.status})에서 ${next}(으)로 변경할 수 없습니다.`,
        undefined,
        { currentStatus: before.status, allowedNext: allowed },
      );
    }

    const after = await this.prisma.appointment.update({
      where: { id },
      data: { status: next, rowVersion: { increment: 1 } },
      include: APPOINTMENT_INCLUDE,
    });
    await this.audit.log({
      userId: actor.id,
      action,
      entityType: 'APPOINTMENT',
      entityId: id,
      before,
      after,
      reason,
    });
    return toAppointmentView(after);
  }

  private async resolvePurpose(code: string) {
    const purpose = await this.prisma.appointmentPurpose.findUnique({ where: { code } });
    if (!purpose || !purpose.active) {
      throw new BusinessException('VALIDATION_ERROR', '유효하지 않은 예약 목적입니다.', [
        { field: 'purposeCode', reason: 'UNKNOWN_PURPOSE' },
      ]);
    }
    return purpose;
  }
}

/** 콤마 목록 쿼리 파라미터 → 값 배열 */
function splitCsv(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
