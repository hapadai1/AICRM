import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { toAppointmentView } from '../appointments/appointment-view';
import {
  AcknowledgeTaskDto,
  DASHBOARD_TASK_TYPES,
  DashboardTaskRow,
  DashboardTaskType,
} from './dashboard.dto';

/** 판정 유형 → dashboard_task_actions.entity_type 매핑 */
const TASK_ENTITY_TYPE: Record<DashboardTaskType, string> = {
  LATE_RETURN: 'RENTAL_ALLOCATION',
  INBOUND_DELAY: 'ORDER_ITEM_COMPONENT',
  PAYMENT_DELAY: 'CONTRACT',
  UNORDERED: 'ORDER_ITEM',
  REPRINT_NEEDED: 'ORDER_ITEM',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 로컬 달력 기준 오늘 날짜를 UTC 자정 Date로 반환 (@db.Date 비교용). */
function todayAsDbDate(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function toDateString(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/** 로컬 달력 기준 YYYY-MM-DD 문자열 */
function localDateKey(d: Date): string {
  return [
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

/** 'YYYY-MM-DD' → 로컬 자정 Date. 형식 불일치·미지정 시 null. */
function parseLocalDate(value?: string): Date | null {
  const m = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 대시보드 요약 (연동정합화 계약 §10):
   * { date, appointments(기준일 예약 평면 뷰), week(기준일±3일 [{date,count}]), taskCounts }
   * date 파라미터로 기준일을 지정할 수 있으며 미지정 시 오늘. 예약·주간 캘린더가 기준일에 맞춰진다.
   * (taskCounts 확인사항은 날짜와 무관한 현재 미처리 항목이므로 기준일 영향을 받지 않는다.)
   */
  async summary(date?: string) {
    const now = new Date();
    const dayStart =
      parseLocalDate(date) ?? new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayEnd = addDays(dayStart, 1);
    const weekStart = addDays(dayStart, -3);
    const weekEnd = addDays(dayStart, 4);

    const [appointments, weekRows, ...taskLists] = await Promise.all([
      this.prisma.appointment.findMany({
        where: { scheduledStart: { gte: dayStart, lt: dayEnd }, status: { not: 'CANCELLED' } },
        include: {
          customer: { select: { id: true, name: true, phone: true, customerStatus: true } },
          purpose: { select: { code: true, name: true } },
        },
        orderBy: { scheduledStart: 'asc' },
      }),
      this.prisma.appointment.findMany({
        where: { scheduledStart: { gte: weekStart, lt: weekEnd }, status: { not: 'CANCELLED' } },
        select: { scheduledStart: true },
      }),
      ...DASHBOARD_TASK_TYPES.map((type) => this.findTasks(type)),
    ]);

    const countByDate = new Map<string, number>();
    for (const row of weekRows) {
      const key = localDateKey(row.scheduledStart);
      countByDate.set(key, (countByDate.get(key) ?? 0) + 1);
    }
    const week = [-3, -2, -1, 0, 1, 2, 3].map((offset) => {
      const date = localDateKey(addDays(dayStart, offset));
      return { date, count: countByDate.get(date) ?? 0 };
    });

    const taskCounts = Object.fromEntries(
      DASHBOARD_TASK_TYPES.map((type, i) => [type, (taskLists[i] as DashboardTaskRow[]).length]),
    );
    return {
      date: localDateKey(dayStart),
      appointments: appointments.map(toAppointmentView),
      week,
      taskCounts,
    };
  }

  /** 확인사항 목록. type 미지정 시 5종 전체를 합쳐 반환한다. */
  async listTasks(type?: DashboardTaskType): Promise<DashboardTaskRow[]> {
    const types = type ? [type] : [...DASHBOARD_TASK_TYPES];
    const lists = await Promise.all(types.map((t) => this.findTasks(t)));
    return lists.flat();
  }

  /**
   * 업무 확인·보류·완료 처리. taskId는 "type:entityId" 형식(예: unordered:uuid).
   * 판정은 조회 시점 계산이므로 처리 이력만 저장한다 (데이터모델 12.6).
   */
  async acknowledge(taskId: string, dto: AcknowledgeTaskDto, actor: AuthUser) {
    const sep = taskId.indexOf(':');
    const rawType = sep > 0 ? taskId.slice(0, sep).toUpperCase() : '';
    const entityId = sep > 0 ? taskId.slice(sep + 1) : '';
    if (!DASHBOARD_TASK_TYPES.includes(rawType as DashboardTaskType) || !UUID_RE.test(entityId))
      throw new BusinessException('VALIDATION_ERROR', 'taskId 형식이 올바르지 않습니다. (type:entityId)', [
        { field: 'taskId', reason: 'INVALID_FORMAT' },
      ]);
    const taskType = rawType as DashboardTaskType;

    const action = await this.prisma.dashboardTaskAction.create({
      data: {
        id: randomUUID(),
        taskType,
        entityType: TASK_ENTITY_TYPE[taskType],
        entityId,
        status: dto.status ?? 'ACKNOWLEDGED',
        memo: dto.memo ?? null,
        actionBy: actor.id,
        actionAt: new Date(),
      },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'STATUS_CHANGE',
      entityType: 'DASHBOARD_TASK',
      entityId,
      after: action,
      reason: dto.memo,
    });
    return action;
  }

  // ---------------------------------------------------------------------------
  // 판정 쿼리 (설계서 01 §13.2, 데이터모델 §10.5)
  // ---------------------------------------------------------------------------

  private findTasks(type: DashboardTaskType): Promise<DashboardTaskRow[]> {
    switch (type) {
      case 'LATE_RETURN':
        return this.findLateReturns();
      case 'INBOUND_DELAY':
        return this.findInboundDelays();
      case 'PAYMENT_DELAY':
        return this.findPaymentDelays();
      case 'UNORDERED':
        return this.findUnordered();
      case 'REPRINT_NEEDED':
        return this.findReprintNeeded();
    }
  }

  /** 반납 지연: 반납 예정일 < 오늘 AND 실제 반납 없음 (취소 배정 제외). */
  private async findLateReturns(): Promise<DashboardTaskRow[]> {
    const allocations = await this.prisma.rentalAllocation.findMany({
      where: {
        returnDueDate: { lt: todayAsDbDate() },
        actualReturnAt: null,
        status: { notIn: ['CANCELLED', 'RETURNED'] },
      },
      include: {
        rentalInventoryItem: { select: { managementCode: true } },
        orderItemComponent: {
          include: {
            orderItem: {
              include: { order: { include: { contract: { include: { customer: true } } } } },
            },
          },
        },
      },
      orderBy: { returnDueDate: 'asc' },
    });
    return this.withAcknowledged(
      'LATE_RETURN',
      allocations.map((a) => {
        const item = a.orderItemComponent.orderItem;
        return this.row('LATE_RETURN', a.id, item.order.contract.customer, {
          orderId: item.orderId,
          orderNo: item.order.orderNo,
          orderItemId: item.id,
          itemLabel: `${item.displayName} / ${a.rentalInventoryItem.managementCode}`,
          reason: `반납 예정일(${toDateString(a.returnDueDate)}) 경과, 미반납`,
          dueDate: toDateString(a.returnDueDate),
        });
      }),
    );
  }

  /** 입고 지연: 입고 예정일 < 오늘 AND 실제 입고 없음 (활성 구성품). */
  private async findInboundDelays(): Promise<DashboardTaskRow[]> {
    const components = await this.prisma.orderItemComponent.findMany({
      where: {
        active: true,
        expectedInboundDate: { lt: todayAsDbDate() },
        actualInboundAt: null,
        orderItem: { status: { not: 'CANCELLED' } },
      },
      include: {
        orderItem: { include: { order: { include: { contract: { include: { customer: true } } } } } },
      },
      orderBy: { expectedInboundDate: 'asc' },
    });
    return this.withAcknowledged(
      'INBOUND_DELAY',
      components.map((c) =>
        this.row('INBOUND_DELAY', c.id, c.orderItem.order.contract.customer, {
          orderId: c.orderItem.orderId,
          orderNo: c.orderItem.order.orderNo,
          orderItemId: c.orderItemId,
          itemLabel: `${c.orderItem.displayName} / ${c.componentType}`,
          reason: `입고 예정일(${toDateString(c.expectedInboundDate)}) 경과, 미입고`,
          dueDate: toDateString(c.expectedInboundDate),
        }),
      ),
    );
  }

  /**
   * 결제 지연 (연동정합화 계약 §4·§10):
   * contracts.balance_due_date < 오늘 AND 미수 잔액 > 0. 예정일이 없으면 판정에서 제외한다.
   */
  private async findPaymentDelays(): Promise<DashboardTaskRow[]> {
    const contracts = await this.prisma.contract.findMany({
      where: {
        status: { notIn: ['CANCELLED'] },
        balanceDueDate: { lt: todayAsDbDate() },
      },
      include: { customer: true, currentVersion: { select: { totalAmount: true } } },
    });
    if (contracts.length === 0) return [];

    const sums = await this.prisma.payment.groupBy({
      by: ['contractId'],
      where: { contractId: { in: contracts.map((c) => c.id) }, status: 'COMPLETED' },
      _sum: { amount: true },
    });
    const collectedBy = new Map(sums.map((s) => [s.contractId, Number(s._sum.amount ?? 0)]));

    const rows = contracts
      .map((c) => ({
        contract: c,
        contractAmount: Number(c.currentVersion?.totalAmount ?? 0),
        collected: collectedBy.get(c.id) ?? 0,
      }))
      .filter((x) => x.contractAmount - x.collected > 0)
      .map((x) =>
        this.row('PAYMENT_DELAY', x.contract.id, x.contract.customer, {
          contractId: x.contract.id,
          itemLabel: x.contract.contractNo,
          reason: `잔금 결제 예정일(${toDateString(x.contract.balanceDueDate)}) 경과, 미수 잔액 ${
            x.contractAmount - x.collected
          }원`,
          dueDate: toDateString(x.contract.balanceDueDate),
        }),
      );
    return this.withAcknowledged('PAYMENT_DELAY', rows);
  }

  /** 미주문: 옵션 세션 CONFIRMED + 현재 채촌 연결 + 작업지시서 버전 0건. */
  private async findUnordered(): Promise<DashboardTaskRow[]> {
    const items = await this.prisma.orderItem.findMany({
      where: {
        status: { not: 'CANCELLED' },
        optionSelectionSessions: { some: { isCurrent: true, status: 'CONFIRMED' } },
        measurementLinks: { some: { isCurrent: true } },
        OR: [{ workOrder: null }, { workOrder: { versions: { none: {} } } }],
      },
      include: { order: { include: { contract: { include: { customer: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
    return this.withAcknowledged(
      'UNORDERED',
      items.map((item) =>
        this.row('UNORDERED', item.id, item.order.contract.customer, {
          orderId: item.orderId,
          orderNo: item.order.orderNo,
          orderItemId: item.id,
          itemLabel: item.displayName,
          reason: '옵션 확정 및 채촌 완료 후 작업지시서 미출력',
          dueDate: toDateString(todayAsDbDate()),
        }),
      ),
    );
  }

  /** 재출력 필요: 최신 옵션 확정/채촌 연결 시각 > 마지막 작업지시서 출력 시각. */
  private async findReprintNeeded(): Promise<DashboardTaskRow[]> {
    const items = await this.prisma.orderItem.findMany({
      where: {
        status: { not: 'CANCELLED' },
        workOrder: { versions: { some: {} } },
        optionSelectionSessions: { some: { isCurrent: true, status: 'CONFIRMED' } },
        measurementLinks: { some: { isCurrent: true } },
      },
      include: {
        order: { include: { contract: { include: { customer: true } } } },
        optionSelectionSessions: {
          where: { isCurrent: true, status: 'CONFIRMED' },
          select: { confirmedAt: true },
        },
        measurementLinks: { where: { isCurrent: true }, select: { linkedAt: true } },
        workOrder: {
          include: { versions: { orderBy: { issuedAt: 'desc' }, take: 1, select: { issuedAt: true } } },
        },
      },
    });

    const rows: DashboardTaskRow[] = [];
    for (const item of items) {
      const lastIssuedAt = item.workOrder?.versions[0]?.issuedAt;
      if (!lastIssuedAt) continue;
      const sourceTimes = [
        ...item.optionSelectionSessions.map((s) => s.confirmedAt?.getTime() ?? 0),
        ...item.measurementLinks.map((l) => l.linkedAt.getTime()),
      ];
      const latestSourceAt = Math.max(0, ...sourceTimes);
      if (latestSourceAt <= lastIssuedAt.getTime()) continue;
      rows.push(
        this.row('REPRINT_NEEDED', item.id, item.order.contract.customer, {
          orderId: item.orderId,
          orderNo: item.order.orderNo,
          orderItemId: item.id,
          itemLabel: item.displayName,
          reason: '마지막 출력 이후 옵션·채촌 원본이 변경됨',
          dueDate: toDateString(todayAsDbDate()),
        }),
      );
    }
    return this.withAcknowledged('REPRINT_NEEDED', rows);
  }

  // ---------------------------------------------------------------------------
  // 공통
  // ---------------------------------------------------------------------------

  private row(
    taskType: DashboardTaskType,
    entityId: string,
    customer: { id: string; name: string } | null,
    extra: Partial<DashboardTaskRow> & { reason: string },
  ): DashboardTaskRow {
    return {
      taskId: `${taskType.toLowerCase()}:${entityId}`,
      taskType,
      entityType: TASK_ENTITY_TYPE[taskType],
      entityId,
      customerId: customer?.id ?? null,
      customerName: customer?.name ?? null,
      acknowledged: false,
      ...extra,
    };
  }

  /** dashboard_task_actions 이력이 있으면 acknowledged=true 로 표시한다. */
  private async withAcknowledged(
    taskType: DashboardTaskType,
    rows: DashboardTaskRow[],
  ): Promise<DashboardTaskRow[]> {
    if (rows.length === 0) return rows;
    const actions = await this.prisma.dashboardTaskAction.findMany({
      where: { taskType, entityId: { in: rows.map((r) => r.entityId) } },
      orderBy: { actionAt: 'desc' },
      select: { entityId: true, actionAt: true, actionByUser: { select: { displayName: true } } },
    });
    // 엔티티별 최근 처리(정렬상 첫 항목)만 남긴다.
    const latest = new Map<string, { by: string; at: string }>();
    for (const a of actions) {
      if (!latest.has(a.entityId))
        latest.set(a.entityId, { by: a.actionByUser.displayName, at: a.actionAt.toISOString() });
    }
    return rows.map((r) => {
      const ack = latest.get(r.entityId);
      return {
        ...r,
        acknowledged: !!ack,
        acknowledgedBy: ack?.by ?? null,
        acknowledgedAt: ack?.at ?? null,
      };
    });
  }
}
