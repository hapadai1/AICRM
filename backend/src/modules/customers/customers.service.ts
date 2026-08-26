import { Injectable } from '@nestjs/common';
import { Customer, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { toDateOnlyStringOrNull as toDateOnly } from '../../common/date';
import { AuthUser } from '../../common/decorators';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { toAppointmentView, toConsultationView } from '../appointments/appointment-view';
import { repairItemsLabel } from '../repairs/repair-item-label';
import {
  CreateCustomerDto,
  CustomerListQueryDto,
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

// toDateOnly는 common/date.ts의 toDateOnlyStringOrNull을 쓴다 (화면 표기용, null 유지).

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

  /**
   * 고객 목록 (설계서 07 §2).
   * 가망/계약 고객을 나눠 저장하던 방식은 폐기됐다 — 접점이 생긴 사람은 모두 고객이며,
   * 화면이 필요한 범위(scope)만 골라 본다. 고객 메뉴 기본은 계약 보유 고객이다.
   */
  async list(query: CustomerListQueryDto): Promise<Paginated<unknown>> {
    // 비활성 고객은 어떤 범위에서도 노출하지 않는다 (D8 — INACTIVE만 남은 상태 필터).
    const conditions: Prisma.CustomerWhereInput[] = [{ customerStatus: { not: 'INACTIVE' } }];
    // 계약 상태는 가리지 않는다. 작성중(DRAFT)·취소(CANCELLED)도 "계약서를 연 고객"이다.
    if ((query.scope ?? 'CONTRACT') === 'CONTRACT') conditions.push({ contracts: { some: {} } });
    // status는 명시 지정할 때만 얹는다. INACTIVE 제외 조건과 AND로 함께 살아 있어야 한다.
    if (query.status && query.status !== 'ALL') conditions.push({ customerStatus: query.status });
    const where: Prisma.CustomerWhereInput = { AND: conditions };
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
    // conditions에 push한다 — where.AND에 재배정하면 scope·INACTIVE 조건이 통째로 날아간다.
    if (query.progress === 'ACTIVE') {
      conditions.push({ journeys: { some: { status: 'ACTIVE' } } });
    } else if (query.progress === 'DONE') {
      // 완료 = 진행중 journey 없이 완료 journey를 보유.
      // 계약 확정(customerStatus='CONTRACTED')은 진행의 시작이지 완료가 아니다 — 설계서 07 §2에서
      // OR 절을 제거했다. 예전에는 확정 고객 전원이 "완료"로 분류되는 오류가 있었다.
      conditions.push({ journeys: { some: { status: 'COMPLETED' } } });
      conditions.push({ journeys: { none: { status: 'ACTIVE' } } });
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

    // 정렬 기준: 최근 방문일(VISITED 예약의 최신일) desc, 미방문 고객은 하단(설계서 07 §2).
    // 최근 방문일은 예약에서 파생돼 DB orderBy 한 컬럼으로 표현할 수 없다 → 조건에 맞는 전체
    // 고객 id에 방문일을 붙여 정렬한 뒤 페이지를 잘라, 페이지 행만 상세 조회한다.
    const matched = await this.prisma.customer.findMany({
      where,
      select: { id: true, createdAt: true },
    });
    const total = matched.length;

    const matchedIds = matched.map((m) => m.id);
    const visitMax = matchedIds.length
      ? await this.prisma.appointment.groupBy({
          by: ['customerId'],
          where: { customerId: { in: matchedIds }, status: 'VISITED' },
          _max: { scheduledStart: true },
        })
      : [];
    const visitAtByCustomer = new Map<string, Date>();
    for (const v of visitMax) {
      if (v._max.scheduledStart) visitAtByCustomer.set(v.customerId, v._max.scheduledStart);
    }

    // 최근 방문일 desc(미방문 하단), 동률이면 등록일 desc로 안정 정렬.
    matched.sort((a, b) => {
      const va = visitAtByCustomer.get(a.id)?.getTime();
      const vb = visitAtByCustomer.get(b.id)?.getTime();
      if (va !== vb) {
        if (va === undefined) return 1;
        if (vb === undefined) return -1;
        return vb - va;
      }
      return b.createdAt.getTime() - a.createdAt.getTime();
    });

    const ids = matched.slice(query.skip, query.skip + query.size).map((m) => m.id);
    const pageRows = ids.length
      ? await this.prisma.customer.findMany({ where: { id: { in: ids } }, select: CUSTOMER_SELECT })
      : [];
    const rowById = new Map(pageRows.map((r) => [(r as { id: string }).id, r]));
    // ids 순서(정렬 결과)를 그대로 유지한다 — in 조회는 순서를 보장하지 않는다.
    const items = ids.map((id) => rowById.get(id)!);

    // 목록 화면 요약 필드: 계약 건수·최근 거래 유형·진행상태 (CUST-001)
    const [contracts, orders, journeys, stages] = ids.length
      ? await this.prisma.$transaction([
          this.prisma.contract.findMany({
            where: { customerId: { in: ids }, status: { not: 'CANCELLED' } },
            select: { customerId: true },
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
      : [[], [], [], []];

    const contractCountByCustomer = new Map<string, number>();
    for (const c of contracts as { customerId: string }[]) {
      contractCountByCustomer.set(c.customerId, (contractCountByCustomer.get(c.customerId) ?? 0) + 1);
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
      const journey = journeyByCustomer.get(row.id);
      return {
        ...c,
        contractCount: contractCountByCustomer.get(row.id) ?? 0,
        lastVisitDate: visitAtByCustomer.get(row.id)?.toISOString().slice(0, 10) ?? null,
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
                productCategory: true,
                status: true,
                // 옵션 세션은 ContractItem에 붙는다 → sourceContractItem 경유(REACH-BACK).
                sourceContractItem: {
                  select: {
                    optionSelectionSessions: {
                      where: { isCurrent: true },
                      orderBy: { selectionVersionNo: 'desc' },
                      select: { status: true, confirmedAt: true },
                    },
                    // 렌탈 품목의 스타일 컨설팅(렌탈 파트) 확정 여부.
                    rentalSelectionSessions: {
                      where: { isCurrent: true },
                      orderBy: { selectionVersionNo: 'desc' },
                      select: { status: true, confirmedAt: true },
                    },
                  },
                },
                measurementLinks: { where: { isCurrent: true }, select: { id: true } },
                workOrder: { select: { outputFileId: true } },
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
              select: { orderItem: { select: { id: true, displayName: true } } },
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
            items: { select: { targetProduct: true, quantity: true }, orderBy: { sequenceNo: 'asc' } },
            orderItem: { select: { displayName: true } },
            component: { select: { componentType: true } },
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
        createdAt: toDateOnly(c.createdAt),
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
          productCategory: i.productCategory,
          status: i.status,
          optionStatus: i.sourceContractItem.optionSelectionSessions[0]?.status ?? 'NOT_STARTED',
          // 스타일 컨설팅 확정일 — 진행 요약에서 완료 상태에 완료일을 찍기 위함
          optionConfirmedAt: toDateOnly(i.sourceContractItem.optionSelectionSessions[0]?.confirmedAt),
          // 렌탈 품목의 스타일 컨설팅(렌탈 파트) 확정 여부
          rentalConsultingConfirmed:
            i.sourceContractItem.rentalSelectionSessions[0]?.status === 'CONFIRMED',
          measurementLinked: i.measurementLinks.length > 0,
          workOrderIssued: !!i.workOrder?.outputFileId,
        })),
      })),
      measurements: measurements.map((m) => ({
        id: m.id,
        versionNo: m.versionNo,
        date: toDateOnly(m.measurementDate),
        type: m.measurementType,
        staffName: m.createdByUser.displayName,
        // 표시용(이름 Tag)과 매칭용(주문품목 id)을 분리한다 — 진행 요약은 id로 계약 품목에 붙이고,
        // 채촌 표는 이름을 그대로 보여 준다.
        usedByItems: m.orderItemLinks.map((l) => l.orderItem.displayName),
        usedByItemIds: m.orderItemLinks.map((l) => l.orderItem.id),
        fitPreference: m.fitPreference,
        relatedOrderId: m.relatedOrderId,
        completed: m.completedAt !== null,
        completedAt: toDateOnly(m.completedAt),
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
        // 대상 품목 우선, 없으면 예전 방식(주문 품목·구성품 연결)으로 접수된 건의 라벨.
        target:
          repairItemsLabel(r.items) ??
          r.orderItem?.displayName ??
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
   * 예약 등록 흐름에서 전화번호로 기존 고객을 연결하거나 신규 생성한다
   * (데이터모델설계서 15.1). AppointmentsModule에서 사용.
   *
   * 예약 등록이 곧 고객 등록이다 — 별도 승격 절차 없이 registeredAt을 즉시 찍는다
   * (설계서 07 D2). customerStatus는 계약 확정 전까지 PROSPECT로 남지만 조회 조건에
   * 쓰이지 않는 이력값이다(D8).
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
        registeredAt: new Date(),
      },
    });
    await this.audit.log({
      userId: actorId ?? null,
      action: 'CREATE',
      entityType: 'CUSTOMER',
      entityId: customer.id,
      after: customer,
      reason: '예약 등록 시 고객 자동 생성',
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
