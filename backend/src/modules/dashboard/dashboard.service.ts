import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { toDateOnlyStringOrNull as toDateString, todayAsDbDate } from '../../common/date';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { toAppointmentView } from '../appointments/appointment-view';
import { buildWorkOrderView, workOrderStatusSelect } from '../work-orders/work-order-status';
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
  UNORDERED: 'ORDER_ITEM',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      case 'UNORDERED':
        return this.findUnordered();
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
          rentalItemId: a.rentalInventoryItemId,
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
   * 미주문: 준비(컨설팅 확정+채촌 연결)는 끝났는데 작업지시서를 안 낸 품목.
   *
   * 판정은 work-orders의 단일 출처(buildWorkOrderView)를 그대로 쓴다 — 전에는 여기서
   * 옵션 세션·채촌 연결을 따로 조회해 제작 목록과 판정 사본이 두 벌이었고, 렌탈 선택
   * 세션 반영(2026-08-04) 같은 규칙 변경이 이쪽만 비껴갔다. 진행(journey) 없는 주문을
   * 빼는 것도 제작 목록과 같다 — 화면에 없는 품목이 대시보드에만 잡히면 처리할 곳이 없다.
   */
  private async findUnordered(): Promise<DashboardTaskRow[]> {
    const items = await this.prisma.orderItem.findMany({
      where: {
        status: { not: 'CANCELLED' },
        order: { journeys: { some: { status: { not: 'CANCELLED' } } } },
      },
      select: {
        id: true,
        orderId: true,
        displayName: true,
        order: { select: { orderNo: true, contract: { select: { customer: true } } } },
        ...workOrderStatusSelect,
      },
      orderBy: { createdAt: 'asc' },
    });
    const unordered = items.filter((item) => buildWorkOrderView(item).status === 'UNORDERED');
    return this.withAcknowledged(
      'UNORDERED',
      unordered.map((item) =>
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
