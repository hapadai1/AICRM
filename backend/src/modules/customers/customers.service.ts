import { Injectable } from '@nestjs/common';
import { Customer, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { toAppointmentView, toConsultationView } from '../appointments/appointment-view';
import {
  CreateCustomerDto,
  CustomerListQueryDto,
  RegisterCustomerDto,
  UpdateCustomerDto,
} from './customers.dto';
import { normalizePhone } from './phone.util';

const CUSTOMER_SELECT = {
  id: true,
  name: true,
  phone: true,
  phoneNormalized: true,
  email: true,
  customerStatus: true,
  registeredAt: true,
  firstReservedAt: true,
  contractedAt: true,
  notes: true,
  heightCm: true,
  weightKg: true,
  age: true,
  rowVersion: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** 화면 표기용 YYYY-MM-DD 문자열 (null 유지) */
function toDateOnly(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/** 중복 안내 시 노출하는 기존 고객 요약 */
function duplicateSummary(customer: Customer) {
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    customerStatus: customer.customerStatus,
  };
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 고객 목록. 기본은 CONTRACTED만 조회하고 PROSPECT는 필터로만 노출한다 (설계서 5.3). */
  async list(query: CustomerListQueryDto): Promise<Paginated<unknown>> {
    // 예약으로 자동 생성된 미등록 고객은 고객 메뉴에 노출하지 않는다.
    // 이들은 [예약 고객 등록]에서만 다루며, 등록되어야 이 목록에 들어온다.
    const where: Prisma.CustomerWhereInput = { registeredAt: { not: null } };
    if (query.status !== 'ALL') {
      const statuses = [...new Set([query.status, ...(query.includeProspect ? ['PROSPECT'] : [])])];
      where.customerStatus = statuses.length > 1 ? { in: statuses } : query.status;
    }
    if (query.transactionType) {
      // 최근 거래 유형(가장 최근 주문의 거래방식)이 일치하는 고객만 — 목록 컬럼 표시값과 동일 기준.
      // 고객별 "최신 주문 1건"은 Prisma where로 표현 불가하여 raw SQL로 고객 ID를 선별한다.
      const latest = await this.prisma.$queryRaw<{ customer_id: string }[]>`
        SELECT customer_id FROM (
          SELECT DISTINCT ON (c.customer_id) c.customer_id, o.transaction_type AS tx
          FROM orders o
          JOIN contracts c ON c.id = o.contract_id
          ORDER BY c.customer_id, o.created_at DESC, o.id DESC
        ) latest
        WHERE latest.tx = ${query.transactionType}
      `;
      where.id = { in: latest.map((r) => r.customer_id) };
    }

    // 진행상태 검색 (설계서 06 §2 / 02): journey status 기준으로 진행중/완료 필터.
    // 기존 where.OR(q)·where.id(transactionType)와 충돌하지 않도록 AND 절에 얹는다.
    if (query.progress === 'ACTIVE') {
      where.AND = [{ journeys: { some: { status: 'ACTIVE' } } }];
    } else if (query.progress === 'DONE') {
      // 완료 = 계약 완료(CONTRACTED) 이거나, 진행중 journey 없이 완료 journey를 보유
      where.AND = [
        {
          OR: [
            { customerStatus: 'CONTRACTED' },
            {
              AND: [
                { journeys: { some: { status: 'COMPLETED' } } },
                { journeys: { none: { status: 'ACTIVE' } } },
              ],
            },
          ],
        },
      ];
    }

    const q = query.q?.trim();
    if (q) {
      const digits = q.replace(/\D/g, '');
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        ...(digits.length >= 3 ? [{ phoneNormalized: { contains: digits } }] : []),
        {
          contracts: {
            some: { orders: { some: { orderNo: { contains: q, mode: 'insensitive' } } } },
          },
        },
        { contracts: { some: { contractNo: { contains: q, mode: 'insensitive' } } } },
      ];
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        where,
        select: CUSTOMER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.customer.count({ where }),
    ]);

    // 목록 화면 요약 필드: 계약 건수·미수 잔금·최근 방문일 (CUST-001)
    const ids = items.map((c) => (c as { id: string }).id);
    const [contracts, visits, orders, journeys, stages] = ids.length
      ? await this.prisma.$transaction([
          this.prisma.contract.findMany({
            where: { customerId: { in: ids }, status: { not: 'CANCELLED' } },
            select: {
              customerId: true,
              currentVersion: { select: { balanceAmount: true } },
            },
          }),
          this.prisma.appointment.findMany({
            where: { customerId: { in: ids }, status: 'VISITED' },
            select: { customerId: true, scheduledStart: true },
          }),
          // 최근 거래 유형(CUST-001): 고객 계약의 주문 중 가장 최근 것의 거래 유형
          this.prisma.order.findMany({
            where: { contract: { customerId: { in: ids } } },
            select: { transactionType: true, createdAt: true, contract: { select: { customerId: true } } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          }),
          // 세부 진행상태 열(설계서 06 §2 / 02): 고객별 진행 journey 단계. active 우선, 최근순.
          this.prisma.customerJourney.findMany({
            where: { customerId: { in: ids } },
            select: { customerId: true, currentStageCode: true, trackType: true, status: true },
            orderBy: [{ startedAt: 'desc' }],
          }),
          // 단계 코드→표시명 매핑 (journey_stages는 소규모 시드 테이블)
          this.prisma.journeyStage.findMany({ select: { trackType: true, code: true, name: true } }),
        ])
      : [[], [], [], [], []];

    const summaryByCustomer = new Map<string, { contractCount: number; balanceAmount: number }>();
    for (const c of contracts as { customerId: string; currentVersion: { balanceAmount: unknown } | null }[]) {
      const cur = summaryByCustomer.get(c.customerId) ?? { contractCount: 0, balanceAmount: 0 };
      cur.contractCount += 1;
      cur.balanceAmount += Number(c.currentVersion?.balanceAmount ?? 0);
      summaryByCustomer.set(c.customerId, cur);
    }
    const visitByCustomer = new Map<string, string>();
    for (const v of visits as { customerId: string; scheduledStart: Date }[]) {
      const dateStr = v.scheduledStart.toISOString().slice(0, 10);
      const prev = visitByCustomer.get(v.customerId);
      if (!prev || dateStr > prev) visitByCustomer.set(v.customerId, dateStr);
    }
    // orders는 createdAt desc 정렬 → 고객별 첫 항목이 최근 거래 유형
    const lastTxByCustomer = new Map<string, string>();
    for (const o of orders as { transactionType: string; contract: { customerId: string } }[]) {
      if (!lastTxByCustomer.has(o.contract.customerId))
        lastTxByCustomer.set(o.contract.customerId, o.transactionType);
    }

    // 단계 코드→표시명 (trackType별 code 고유, 설계서 02 §2 매핑)
    const stageNameByKey = new Map<string, string>();
    for (const s of stages as { trackType: string; code: string; name: string }[]) {
      stageNameByKey.set(`${s.trackType}:${s.code}`, s.name);
    }
    // journeys는 startedAt desc 정렬 → 고객별 진행 journey 선택(ACTIVE 우선, 없으면 최근순)
    type JourneyRow = { customerId: string; currentStageCode: string; trackType: string; status: string };
    const journeyByCustomer = new Map<string, JourneyRow>();
    for (const j of journeys as JourneyRow[]) {
      const prev = journeyByCustomer.get(j.customerId);
      if (!prev) journeyByCustomer.set(j.customerId, j);
      else if (prev.status !== 'ACTIVE' && j.status === 'ACTIVE') journeyByCustomer.set(j.customerId, j);
    }

    const enriched = items.map((c) => {
      const row = c as { id: string };
      const summary = summaryByCustomer.get(row.id);
      const journey = journeyByCustomer.get(row.id);
      return {
        ...c,
        contractCount: summary?.contractCount ?? 0,
        balanceAmount: summary?.balanceAmount ?? 0,
        lastVisitDate: visitByCustomer.get(row.id) ?? null,
        lastTransactionType: lastTxByCustomer.get(row.id) ?? null,
        // 세부 진행상태: 진행 journey의 현재 단계(코드/표시명/트랙/상태). 없으면 null
        currentStage: journey
          ? {
              code: journey.currentStageCode,
              name: stageNameByKey.get(`${journey.trackType}:${journey.currentStageCode}`) ?? journey.currentStageCode,
              trackType: journey.trackType,
              status: journey.status,
            }
          : null,
      };
    });
    return new Paginated(enriched, query.page, query.size, total);
  }

  async create(dto: CreateCustomerDto, actor: AuthUser) {
    const phoneNormalized = normalizePhone(dto.phone);
    await this.assertPhoneNotDuplicated(phoneNormalized);

    const customerStatus = dto.customerStatus ?? 'PROSPECT';
    const customer = await this.prisma.customer.create({
      data: {
        id: randomUUID(),
        name: dto.name.trim(),
        phone: dto.phone.trim(),
        phoneNormalized,
        email: dto.email,
        notes: dto.notes,
        heightCm: dto.heightCm ?? null,
        weightKg: dto.weightKg ?? null,
        age: dto.age ?? null,
        customerStatus,
        // 고객 메뉴에서 직접 등록한 고객은 즉시 등록 완료 상태다
        registeredAt: new Date(),
        ...(customerStatus === 'CONTRACTED' ? { contractedAt: new Date() } : {}),
        ...(dto.firstReservedAt ? { firstReservedAt: new Date(dto.firstReservedAt) } : {}),
      },
      select: CUSTOMER_SELECT,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'CUSTOMER',
      entityId: customer.id,
      after: customer,
    });
    return customer;
  }

  /**
   * 고객 상세 (연동정합화 계약 §2):
   * { customer, summary, appointments, consultations, contracts(뷰), orders,
   *   measurements, components, rentals, repairs } 구조로 반환한다.
   */
  async detail(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      select: CUSTOMER_SELECT,
    });
    if (!customer) throw new BusinessException('CUSTOMER_NOT_FOUND', '고객이 없습니다.');

    const [contracts, orders, appointments, consultations, measurements, components, rentals, repairs] =
      await Promise.all([
        this.prisma.contract.findMany({
          where: { customerId: id },
          orderBy: { createdAt: 'desc' },
          include: {
            contractType: { select: { code: true, name: true } },
            currentVersion: {
              select: {
                versionNo: true,
                totalAmount: true,
                depositAmount: true,
                balanceAmount: true,
                completionDueDate: true,
              },
            },
          },
        }),
        this.prisma.order.findMany({
          where: { contract: { customerId: id } },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            orderNo: true,
            contractId: true,
            transactionType: true,
            status: true,
            completionDueDate: true,
            photoDate: true,
            weddingDate: true,
            items: {
              orderBy: { sequenceNo: 'asc' },
              select: {
                id: true,
                displayName: true,
                status: true,
                optionSelectionSessions: {
                  where: { isCurrent: true },
                  orderBy: { selectionVersionNo: 'desc' },
                  select: { status: true },
                },
                measurementLinks: { where: { isCurrent: true }, select: { id: true } },
                workOrder: { select: { versions: { select: { id: true } } } },
              },
            },
          },
        }),
        this.prisma.appointment.findMany({
          where: { customerId: id },
          orderBy: { scheduledStart: 'desc' },
          include: {
            customer: { select: { id: true, name: true, phone: true, customerStatus: true } },
            purpose: { select: { code: true, name: true } },
          },
        }),
        this.prisma.consultation.findMany({
          where: { customerId: id },
          orderBy: { consultedAt: 'desc' },
          include: { staff: { select: { id: true, displayName: true } } },
        }),
        this.prisma.measurementSession.findMany({
          where: { customerId: id },
          orderBy: { versionNo: 'desc' },
          select: {
            id: true,
            versionNo: true,
            measurementDate: true,
            measurementType: true,
            fitPreference: true,
            relatedOrderId: true,
            completedAt: true,
            createdAt: true,
            createdByUser: { select: { displayName: true } },
            orderItemLinks: {
              where: { isCurrent: true },
              select: { orderItem: { select: { displayName: true } } },
            },
          },
        }),
        this.prisma.orderItemComponent.findMany({
          where: { orderItem: { order: { contract: { customerId: id } } } },
          orderBy: { createdAt: 'asc' },
          include: {
            orderItem: {
              select: {
                id: true,
                displayName: true,
                status: true,
                orderId: true,
                order: { select: { orderNo: true, transactionType: true } },
              },
            },
          },
        }),
        this.prisma.rentalAllocation.findMany({
          where: { orderItemComponent: { orderItem: { order: { contract: { customerId: id } } } } },
          orderBy: { pickupDate: 'desc' },
          include: {
            rentalInventoryItem: { select: { id: true, managementCode: true } },
            orderItemComponent: {
              select: {
                id: true,
                componentType: true,
                orderItem: {
                  select: { id: true, displayName: true, order: { select: { orderNo: true } } },
                },
              },
            },
          },
        }),
        this.prisma.repairRequest.findMany({
          where: { customerId: id },
          orderBy: { requestDate: 'desc' },
          include: {
            orderItem: { select: { displayName: true } },
            component: { select: { componentType: true } },
            rentalInventoryItem: { select: { managementCode: true } },
          },
        }),
      ]);

    // 요약: 취소 계약 제외 계약 금액 합계
    const activeContractIds = new Set(contracts.filter((c) => c.status !== 'CANCELLED').map((c) => c.id));
    const totalAmount = contracts
      .filter((c) => activeContractIds.has(c.id))
      .reduce((sum, c) => sum + Number(c.currentVersion?.totalAmount ?? 0), 0);

    const contractNoById = new Map(contracts.map((c) => [c.id, c.contractNo]));

    return {
      customer: { ...customer, version: customer.rowVersion },
      summary: {
        contractCount: contracts.length,
        totalAmount,
      },
      appointments: appointments.map(toAppointmentView),
      consultations: consultations.map(toConsultationView),
      contracts: contracts.map((c) => ({
        id: c.id,
        contractNo: c.contractNo,
        contractTypeName: c.contractType?.name ?? null,
        status: c.status,
        currentVersionNo: c.currentVersion?.versionNo ?? null,
        totalAmount: Number(c.currentVersion?.totalAmount ?? 0),
        depositAmount: Number(c.currentVersion?.depositAmount ?? 0),
        balanceAmount: Number(c.currentVersion?.balanceAmount ?? 0),
        contractedAt: toDateOnly(c.contractedAt),
        completionDueDate: toDateOnly(c.currentVersion?.completionDueDate),
      })),
      orders: orders.map((o) => ({
        id: o.id,
        orderNo: o.orderNo,
        contractId: o.contractId,
        contractNo: contractNoById.get(o.contractId) ?? null,
        transactionType: o.transactionType,
        status: o.status,
        completionDueDate: toDateOnly(o.completionDueDate),
        photoDate: toDateOnly(o.photoDate),
        weddingDate: toDateOnly(o.weddingDate),
        items: o.items.map((i) => ({
          id: i.id,
          displayName: i.displayName,
          status: i.status,
          optionStatus: i.optionSelectionSessions[0]?.status ?? 'NOT_STARTED',
          measurementLinked: i.measurementLinks.length > 0,
          workOrderVersionCount: i.workOrder?.versions.length ?? 0,
        })),
      })),
      measurements: measurements.map((m) => ({
        id: m.id,
        versionNo: m.versionNo,
        date: toDateOnly(m.measurementDate),
        type: m.measurementType,
        staffName: m.createdByUser.displayName,
        usedByItems: m.orderItemLinks.map((l) => l.orderItem.displayName),
        fitPreference: m.fitPreference,
        relatedOrderId: m.relatedOrderId,
        completed: m.completedAt !== null,
      })),
      components: components.map((c) => ({
        id: c.id,
        orderItemId: c.orderItemId,
        itemName: c.orderItem.displayName,
        orderItemName: c.orderItem.displayName,
        orderId: c.orderItem.orderId,
        orderNo: c.orderItem.order.orderNo,
        transactionType: c.orderItem.order.transactionType,
        componentType: c.componentType,
        sequenceNo: c.sequenceNo,
        status: c.status,
        expectedInboundDate: toDateOnly(c.expectedInboundDate),
        actualInboundAt: toDateOnly(c.actualInboundAt),
        actualOutboundAt: toDateOnly(c.actualOutboundAt),
        notes: c.notes,
      })),
      rentals: rentals.map((r) => ({
        id: r.id,
        status: r.status,
        orderNo: r.orderItemComponent.orderItem.order.orderNo,
        itemName: r.orderItemComponent.orderItem.displayName,
        componentType: r.orderItemComponent.componentType,
        rentalItemCode: r.rentalInventoryItem.managementCode,
        pickupDate: toDateOnly(r.pickupDate),
        returnDueDate: toDateOnly(r.returnDueDate),
        actualPickupAt: toDateOnly(r.actualPickupAt),
        actualReturnAt: toDateOnly(r.actualReturnAt),
        rentalInventoryItemId: r.rentalInventoryItem.id,
        componentId: r.orderItemComponent.id,
      })),
      repairs: repairs.map((r) => ({
        id: r.id,
        receivedDate: toDateOnly(r.requestDate),
        target:
          r.orderItem?.displayName ??
          r.rentalInventoryItem?.managementCode ??
          r.component?.componentType ??
          '-',
        content: r.description,
        status: r.status,
        repairType: r.repairType,
        dueDate: toDateOnly(r.dueDate),
      })),
    };
  }

  /** 고객 수정. 전화 변경 시 중복 재검사, rowVersion 낙관적 잠금. */
  async update(id: string, dto: UpdateCustomerDto, actor: AuthUser) {
    const before = await this.prisma.customer.findUnique({ where: { id } });
    if (!before) throw new BusinessException('CUSTOMER_NOT_FOUND', '고객이 없습니다.');

    const data: Prisma.CustomerUpdateManyMutationInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.heightCm !== undefined) data.heightCm = dto.heightCm;
    if (dto.weightKg !== undefined) data.weightKg = dto.weightKg;
    if (dto.age !== undefined) data.age = dto.age;
    if (dto.phone !== undefined) {
      const phoneNormalized = normalizePhone(dto.phone);
      if (phoneNormalized !== before.phoneNormalized) {
        await this.assertPhoneNotDuplicated(phoneNormalized, id);
      }
      data.phone = dto.phone.trim();
      data.phoneNormalized = phoneNormalized;
    }

    const result = await this.prisma.customer.updateMany({
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

    const after = await this.prisma.customer.findUniqueOrThrow({
      where: { id },
      select: CUSTOMER_SELECT,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'CUSTOMER',
      entityId: id,
      before,
      after,
    });
    return after;
  }

  /** 전화번호 중복 조회 (APPT-002/CONT-002). 없으면 data:null */
  async findByPhone(phone: string) {
    const phoneNormalized = normalizePhone(phone);
    const customer = await this.prisma.customer.findUnique({
      where: { phoneNormalized },
      select: CUSTOMER_SELECT,
    });
    // 호출부(고객 등록 모달)가 낙관적 잠금에 쓰도록 detail과 동일하게 version으로 노출한다
    return customer ? { ...customer, version: customer.rowVersion } : null;
  }

  /**
   * 예약으로 생긴 미등록 고객을 정식 고객으로 등록한다.
   * 등록 시각을 찍어야 고객 목록에 나타나므로 일반 수정과 별도 액션으로 둔다.
   */
  async register(id: string, dto: RegisterCustomerDto, actor: AuthUser) {
    const before = await this.prisma.customer.findUnique({ where: { id } });
    if (!before) throw new BusinessException('CUSTOMER_NOT_FOUND', '고객이 없습니다.');
    if (before.registeredAt) {
      throw new BusinessException('CUSTOMER_ALREADY_REGISTERED', '이미 등록된 고객입니다.', undefined, {
        registeredAt: before.registeredAt,
      });
    }
    if (before.customerStatus === 'INACTIVE') {
      throw new BusinessException('INVALID_STATUS_TRANSITION', '비활성 고객은 등록할 수 없습니다.');
    }

    const result = await this.prisma.customer.updateMany({
      where: { id, rowVersion: dto.version },
      data: {
        name: dto.name.trim(),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.heightCm !== undefined ? { heightCm: dto.heightCm } : {}),
        ...(dto.weightKg !== undefined ? { weightKg: dto.weightKg } : {}),
        ...(dto.age !== undefined ? { age: dto.age } : {}),
        registeredAt: new Date(),
        rowVersion: { increment: 1 },
      },
    });
    if (result.count === 0) {
      throw new BusinessException(
        'VERSION_CONFLICT',
        '다른 사용자가 먼저 수정했습니다. 최신 정보를 다시 조회해 주세요.',
        undefined,
        { currentVersion: before.rowVersion },
      );
    }

    const after = await this.prisma.customer.findUniqueOrThrow({
      where: { id },
      select: CUSTOMER_SELECT,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'CUSTOMER',
      entityId: id,
      before,
      after,
      reason: '예약 고객을 정식 고객으로 등록',
    });
    return { ...after, version: after.rowVersion };
  }

  /** 물리 삭제 대신 비활성 처리 (설계서 19 — 계약 고객 물리 삭제 금지). */
  async deactivate(id: string, reason: string | undefined, actor: AuthUser) {
    const before = await this.prisma.customer.findUnique({ where: { id } });
    if (!before) throw new BusinessException('CUSTOMER_NOT_FOUND', '고객이 없습니다.');
    if (before.customerStatus === 'INACTIVE') {
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '이미 비활성 상태인 고객입니다.',
        undefined,
        { currentStatus: before.customerStatus },
      );
    }

    const after = await this.prisma.customer.update({
      where: { id },
      data: { customerStatus: 'INACTIVE', rowVersion: { increment: 1 } },
      select: CUSTOMER_SELECT,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'STATUS_CHANGE',
      entityType: 'CUSTOMER',
      entityId: id,
      before,
      after,
      reason,
    });
    return after;
  }

  /**
   * 예약 등록 흐름에서 전화번호로 기존 고객을 연결하거나 PROSPECT 신규 생성한다
   * (데이터모델설계서 15.1). AppointmentsModule에서 사용.
   */
  async linkOrCreateProspectByPhone(
    input: { name?: string; phone: string; email?: string },
    reservedAt: Date,
    actorId?: string,
  ): Promise<{ customer: Customer; created: boolean }> {
    const phoneNormalized = normalizePhone(input.phone);
    const existing = await this.prisma.customer.findUnique({ where: { phoneNormalized } });
    if (existing) {
      if (!existing.firstReservedAt) {
        const updated = await this.prisma.customer.update({
          where: { id: existing.id },
          data: { firstReservedAt: reservedAt },
        });
        return { customer: updated, created: false };
      }
      return { customer: existing, created: false };
    }

    if (!input.name?.trim()) {
      throw new BusinessException('VALIDATION_ERROR', '신규 고객 등록에는 고객명이 필요합니다.', [
        { field: 'customerName', reason: 'REQUIRED' },
      ]);
    }
    const customer = await this.prisma.customer.create({
      data: {
        id: randomUUID(),
        name: input.name.trim(),
        phone: input.phone.trim(),
        phoneNormalized,
        email: input.email,
        customerStatus: 'PROSPECT',
        firstReservedAt: reservedAt,
      },
    });
    await this.audit.log({
      userId: actorId ?? null,
      action: 'CREATE',
      entityType: 'CUSTOMER',
      entityId: customer.id,
      after: customer,
      reason: '예약 등록 시 PROSPECT 자동 생성',
    });
    return { customer, created: true };
  }

  private async assertPhoneNotDuplicated(phoneNormalized: string, exceptId?: string) {
    const existing = await this.prisma.customer.findUnique({ where: { phoneNormalized } });
    if (existing && existing.id !== exceptId) {
      throw new BusinessException(
        'CUSTOMER_PHONE_DUPLICATE',
        '동일한 전화번호의 고객이 이미 존재합니다.',
        undefined,
        { existingCustomer: duplicateSummary(existing) },
      );
    }
  }
}
