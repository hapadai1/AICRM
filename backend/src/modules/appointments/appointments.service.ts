import { Inject, Injectable, Logger } from '@nestjs/common';
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
  NaverFetchOptions,
  NaverFetchWindow,
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
  customer: {
    select: { id: true, name: true, phone: true, customerStatus: true },
  },
  purpose: { select: { id: true, code: true, name: true } },
} as const;

const CONSULTATION_INCLUDE = {
  staff: { select: { id: true, displayName: true } },
} as const;

/** 네이버 예약이 하나도 없을 때(첫 적재) 조회 창 — 최근 이력과 이미 잡힌 다음 달 예약까지 채운다. */
const NAVER_FIRST_LOAD_WINDOW: NaverFetchWindow = { lookbackDays: 30, lookaheadDays: 30 };

type NaverApplyOutcome = 'created' | 'updated' | 'cancelled' | 'conflicts' | 'unchanged';
@Injectable()
export class AppointmentsService {
  private readonly logger = new Logger(AppointmentsService.name);

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
    if (query.naverMenuId) where.naverBizItemId = query.naverMenuId;
    if (query.customerId) where.customerId = query.customerId;

    // 통합 검색 (설계서 07 D4): 한 필드로 고객명·전화번호·예약 목적명을 함께 찾는다.
    // 목적명은 customer가 아닌 purpose 관계라 고객 하위 OR에 넣을 수 없다 —
    // where.OR 최상위에 두어야 기간·상태·customerId 조건과 AND로 결합된다.
    // 네이버 메뉴명(naverBizItemName)도 함께 찾는다 — 화면이 "예약 목적"으로 보여 주는 값이
    // 바로 이것이라, 빠뜨리면 "PICKUP"으로 검색했을 때 아무것도 나오지 않는다
    // (내부 매핑값은 "완성복 출고"다).
    const keyword = query.q?.trim();
    if (keyword) {
      // 자릿수 검증 없이 숫자만 뽑아 비교한다
      // (검색어는 "010-12"처럼 불완전할 수 있어 normalizePhone을 쓰지 않는다).
      const digits = keyword.replace(/\D/g, '');
      const or: Prisma.AppointmentWhereInput[] = [
        { customer: { name: { contains: keyword, mode: 'insensitive' } } },
        { purpose: { name: { contains: keyword, mode: 'insensitive' } } },
        { naverBizItemName: { contains: keyword, mode: 'insensitive' } },
      ];
      if (digits) or.push({ customer: { phoneNormalized: { contains: digits } } });
      where.OR = or;
    }

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
   * 예약 화면의 "네이버 메뉴별 보기" 선택지와 건수.
   *
   * 기준은 **파트너센터에 등록된 상품 목록**이다 — 적재된 예약에서만 뽑으면 예약이 0건인 상품이
   * 화면에서 사라진다 (렌탈처럼 예약이 드문 메뉴가 실제로 그렇게 빠졌다). 상품 마스터를 기준으로
   * 두면 예약이 없어도 선택지에 남고, 순서도 파트너센터 설정을 그대로 따른다.
   *
   * `count` 는 적재된 전체 누적 건수다 — 기간·상태를 가리지 않으므로 화면에는 띄우지 않는다
   * (화면의 기간과 무관한 고정 숫자여서 오해를 준다). 필터 정확성 검증에 쓰려고 응답에는 남긴다.
   *
   * 상품 마스터에 없는 메뉴(파트너센터에서 삭제됐지만 과거 예약은 남은 경우)도 잃지 않도록
   * 적재분에서 뽑아 뒤에 이름순으로 붙인다. 이름은 마스터가 더 최신이라 마스터 쪽을 우선한다.
   * 상품 마스터를 아직 수집하지 못한 환경(연동 스텁·저장본 없음)에서는 예전처럼 적재분만 쓴다.
   */
  async listNaverMenus() {
    const rows = await this.prisma.appointment.groupBy({
      by: ['naverBizItemId', 'naverBizItemName'],
      where: { source: 'NAVER', naverBizItemId: { not: null } },
      _count: { _all: true },
      _max: { syncedAt: true },
    });
    const byId = new Map<string, { id: string; name: string; count: number; seenAt: number }>();
    for (const r of rows) {
      const id = r.naverBizItemId as string;
      const seenAt = r._max.syncedAt?.getTime() ?? 0;
      const cur = byId.get(id);
      if (!cur) {
        byId.set(id, { id, name: r.naverBizItemName ?? id, count: r._count._all, seenAt });
        continue;
      }
      cur.count += r._count._all;
      if (seenAt > cur.seenAt) Object.assign(cur, { name: r.naverBizItemName ?? id, seenAt });
    }
    // 상품 마스터를 못 읽어도(저장본 없음·파일 손상) 메뉴 목록 자체는 내려간다
    const master = await this.naverAdapter.fetchBizItems().catch((e) => {
      this.logger.warn(`네이버 상품 목록을 읽지 못해 적재분만으로 메뉴를 구성한다: ${e instanceof Error ? e.message : e}`);
      return [];
    });

    const menus = master.map(({ id, name }) => ({ id, name, count: byId.get(id)?.count ?? 0 }));
    const inMaster = new Set(master.map((m) => m.id));
    const orphans = [...byId.values()]
      .filter((v) => !inMaster.has(v.id))
      .map(({ id, name, count }) => ({ id, name, count }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    return [...menus, ...orphans];
  }

  /**
   * 파트너센터에서 메뉴 이름을 바꾸면, 이번 조회 창 밖의 예전 예약에도 새 이름을 입힌다.
   * 같은 메뉴가 옛 이름·새 이름으로 갈라져 보이지 않게 하기 위함이다.
   * 표시용 이름만 맞추는 것이라 행 버전·감사 로그는 건드리지 않는다.
   */
  private async propagateNaverMenuRenames(records: NaverReservationRecord[]): Promise<void> {
    const latest = new Map<string, string>();
    for (const r of records) if (r.bizItemId && r.bizItemName) latest.set(r.bizItemId, r.bizItemName);
    for (const [id, name] of latest) {
      await this.prisma.appointment.updateMany({
        where: { source: 'NAVER', naverBizItemId: id, NOT: { naverBizItemName: name } },
        data: { naverBizItemName: name },
      });
    }
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
      // 버튼을 누를 때마다 네이버에 접속하지 않는다 — 가장 최근 수집본에서 원본을 찾는다
      const { records } = await this.naverAdapter.fetchReservations(undefined, { cacheOnly: true });
      const record = records.find((r) => r.externalId === before.externalId);
      // 원본을 못 찾아도 보호만 풀면 다음 주기 수집이 네이버 값으로 맞춘다
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
              naverBizItemId: record.bizItemId ?? before.naverBizItemId,
              naverBizItemName: record.bizItemName ?? before.naverBizItemName,
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
   * 네이버 예약 동기화 (단방향 수집, 설계서 16.1).
   *
   * - source+externalId 기준 upsert. 취소는 삭제하지 않고 CANCELLED 로 남긴다.
   * - 상태는 허용 전이(ALLOWED_TRANSITIONS)대로만 앞으로 간다. 네이버에는 여전히 "확정"으로 남아 있어도,
   *   직원이 CRM 에서 방문·노쇼·취소 처리한 예약을 되돌리지 않는다.
   * - CRM 수정본(localOverride)은 덮어쓰지 않는다 (데이터모델 5.3). 네이버 쪽 변경 시각만 받아 두어
   *   화면에 충돌로 뜨게 한다 — syncedAt 은 "CRM 이 네이버 값을 반영한 시각"이라 여기서 올리면 충돌이 지워진다.
   * - 바뀐 게 없으면 쓰지 않는다. 주기 수집마다 행 버전을 올리면 직원이 편집 중인 예약이
   *   저장 때 버전 충돌로 튕기고, 감사 로그도 수집 건수만큼 매번 쌓인다.
   * - 한 건의 오류(이상한 전화번호 등)가 나머지 적재를 막지 않도록 건별로 격리하고 결과에 남긴다.
   * - 일정이 변경된 예약은 네이버 목록에서 사라지고 새 예약번호로만 다시 나타난다 — 새 예약이 가리키는
   *   이전 예약번호를 따라가 옛 예약을 취소 처리한다. 그러지 않으면 바뀌기 전 시각에 유령 예약이 남는다.
   * - 네이버 예약이 아직 하나도 없는 첫 적재는 과거·미래 30일을 넓게 가져온다.
   * - 요청마다 네이버에 접속하지 않는다. 최근 수집본이 있으면 그것으로 반영한다 (options 참고).
   */
  async syncNaverReservations(actor: AuthUser, window?: NaverFetchWindow, options?: NaverFetchOptions) {
    // 실수집기가 넣은 예약은 항상 네이버 메뉴가 있다 — 출처만 NAVER 인 데모·수기 데이터가 있어도
    // 아직 실제로 가져온 적이 없으면 첫 적재로 본다.
    const firstLoad =
      !window &&
      (await this.prisma.appointment.count({ where: { source: 'NAVER', naverBizItemName: { not: null } } })) === 0;
    const fetched = await this.naverAdapter.fetchReservations(
      window ?? (firstLoad ? NAVER_FIRST_LOAD_WINDOW : undefined),
      options,
    );
    const reservations = fetched.records;
    const now = new Date();
    await this.propagateNaverMenuRenames(reservations);
    const counts: Record<NaverApplyOutcome, number> = {
      created: 0,
      updated: 0,
      cancelled: 0,
      conflicts: 0,
      unchanged: 0,
    };
    const failures: Array<{ externalId: string; reason: string }> = [];

    for (const record of reservations) {
      try {
        counts[await this.applyNaverRecord(record, now, actor)] += 1;
      } catch (e) {
        failures.push({ externalId: record.externalId, reason: e instanceof Error ? e.message : String(e) });
      }
    }

    // 새 예약을 모두 반영한 뒤에 처리한다 — 취소 메모가 가리킬 새 예약이 이미 있어야 한다
    let superseded = 0;
    for (const record of reservations) {
      try {
        if (await this.supersedePreviousBooking(record, now, actor)) superseded += 1;
      } catch (e) {
        failures.push({ externalId: record.externalId, reason: e instanceof Error ? e.message : String(e) });
      }
    }

    return {
      fetched: reservations.length,
      ...counts,
      /** 일정 변경으로 대체되어 취소 처리한 옛 예약 건수 */
      superseded,
      failed: failures.length,
      failures,
      firstLoad,
      /** 반영한 데이터를 네이버에서 받아 온 시각 */
      fetchedAt: fetched.fetchedAt ?? null,
      /** true 면 이번 요청은 네이버에 접속하지 않고 저장된 수집본을 썼다 */
      fromCache: fetched.fromCache,
    };
  }

  /** 네이버 예약 1건을 CRM 에 반영하고 무엇을 했는지 돌려준다. */
  private async applyNaverRecord(
    record: NaverReservationRecord,
    now: Date,
    actor: AuthUser,
  ): Promise<NaverApplyOutcome> {
    const existing = await this.prisma.appointment.findFirst({
      where: { source: 'NAVER', externalId: record.externalId },
    });
    if (!existing) {
      await this.createFromNaver(record, now, actor);
      return 'created';
    }

    const naverUpdatedAt = record.naverUpdatedAt ? new Date(record.naverUpdatedAt) : existing.naverUpdatedAt;
    const naverTimeMoved = naverUpdatedAt?.getTime() !== existing.naverUpdatedAt?.getTime();

    if (existing.localOverride) {
      if (naverTimeMoved) {
        await this.prisma.appointment.update({ where: { id: existing.id }, data: { naverUpdatedAt } });
      }
      const naverChanged = !!naverUpdatedAt && (!existing.syncedAt || naverUpdatedAt > existing.syncedAt);
      return naverChanged ? 'conflicts' : 'unchanged';
    }

    const status =
      record.status === existing.status || (ALLOWED_TRANSITIONS[existing.status] ?? []).includes(record.status)
        ? record.status
        : existing.status;
    const purpose = await this.resolvePurpose(record.purposeCode);
    const next = {
      scheduledStart: new Date(record.scheduledStart),
      scheduledEnd: record.scheduledEnd ? new Date(record.scheduledEnd) : null,
      status,
      notes: record.notes ?? existing.notes,
      purposeId: purpose.id,
      naverBizItemId: record.bizItemId ?? existing.naverBizItemId,
      naverBizItemName: record.bizItemName ?? existing.naverBizItemName,
    };

    const changed =
      next.scheduledStart.getTime() !== existing.scheduledStart.getTime() ||
      (next.scheduledEnd?.getTime() ?? null) !== (existing.scheduledEnd?.getTime() ?? null) ||
      next.status !== existing.status ||
      next.notes !== existing.notes ||
      next.purposeId !== existing.purposeId ||
      next.naverBizItemId !== existing.naverBizItemId ||
      next.naverBizItemName !== existing.naverBizItemName;

    if (!changed) {
      // 네이버 변경 시각만 움직였다면 맞춰 본 시각을 함께 올려 "네이버 변경" 표시가 남지 않게 한다
      if (naverTimeMoved) {
        await this.prisma.appointment.update({
          where: { id: existing.id },
          data: { naverUpdatedAt, syncedAt: now },
        });
      }
      return 'unchanged';
    }

    const after = await this.prisma.appointment.update({
      where: { id: existing.id },
      data: { ...next, naverUpdatedAt: naverUpdatedAt ?? now, syncedAt: now, rowVersion: { increment: 1 } },
    });
    const becameCancelled = status === 'CANCELLED' && existing.status !== 'CANCELLED';
    await this.audit.log({
      userId: actor.id,
      action: becameCancelled ? 'CANCEL' : 'UPDATE',
      entityType: 'APPOINTMENT',
      entityId: existing.id,
      before: existing,
      after,
      reason: becameCancelled ? '네이버 예약 취소 동기화' : '네이버 예약 변경 동기화',
    });
    return becameCancelled ? 'cancelled' : 'updated';
  }

  /**
   * 일정 변경으로 대체된 옛 예약을 취소 처리한다 (설계서 19 — 삭제하지 않고 CANCELLED 로 보존).
   *
   * 이미 끝난 예약(방문·노쇼·취소)은 건드리지 않는다. 네이버 목록에서 사라져도 그날 실제로 일어난 일이
   * 더 정확하기 때문이다. CRM 수정본(localOverride)이어도 취소는 한다 — 값이 엇갈린 게 아니라
   * 그 예약 자체가 네이버에서 없어진 것이라 화면에 남겨 둘 이유가 없다.
   *
   * @returns 이번에 취소 처리했으면 true (이미 취소된 건·대상 없음은 false)
   */
  private async supersedePreviousBooking(
    record: NaverReservationRecord,
    now: Date,
    actor: AuthUser,
  ): Promise<boolean> {
    if (!record.previousExternalId) return false;
    const previous = await this.prisma.appointment.findFirst({
      where: { source: 'NAVER', externalId: record.previousExternalId },
    });
    if (!previous) return false;
    if (!(ALLOWED_TRANSITIONS[previous.status] ?? []).includes('CANCELLED')) return false;

    const reason = `일정 변경으로 예약번호 ${record.externalId} 로 대체됨`;
    const after = await this.prisma.appointment.update({
      where: { id: previous.id },
      data: {
        status: 'CANCELLED',
        notes: previous.notes ? `${previous.notes}\n[일정변경] ${reason}` : `[일정변경] ${reason}`,
        syncedAt: now,
        rowVersion: { increment: 1 },
      },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'CANCEL',
      entityType: 'APPOINTMENT',
      entityId: previous.id,
      before: previous,
      after,
      reason,
    });
    return true;
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
        naverBizItemId: record.bizItemId,
        naverBizItemName: record.bizItemName,
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
