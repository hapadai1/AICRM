import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationSuggestionService } from '../notifications/notification-suggestion.service';
import { DEFAULT_STALLED_DAYS } from './journeys.constants';
import {
  ChangeStageDto,
  CloseJourneyDto,
  CreateJourneyDto,
  ListJourneysQueryDto,
  ListStagesQueryDto,
  NotificationOutcomeDto,
} from './journeys.dto';

const JOURNEY_SELECT = {
  id: true,
  customerId: true,
  orderId: true,
  trackType: true,
  currentStageCode: true,
  status: true,
  startedAt: true,
  completedAt: true,
  rowVersion: true,
  createdAt: true,
  updatedAt: true,
  customer: { select: { id: true, name: true, phone: true, customerStatus: true } },
  order: { select: { id: true, orderNo: true, transactionType: true } },
} satisfies Prisma.CustomerJourneySelect;

const EVENT_SELECT = {
  id: true,
  fromStageCode: true,
  toStageCode: true,
  reason: true,
  notes: true,
  notificationOutcome: true,
  notificationHistoryId: true,
  changedAt: true,
  actor: { select: { id: true, displayName: true } },
} satisfies Prisma.JourneyEventSelect;

type JourneyRow = Prisma.CustomerJourneyGetPayload<{ select: typeof JOURNEY_SELECT }>;
type StageRow = { code: string; name: string; sequenceNo: number; templateId: string | null };

/** 화면이 쓰는 평면 뷰 (연동정합화 계약과 동일한 원칙: 응답은 화면 요구 형태로) */
function toJourneyView(row: JourneyRow, stages: StageRow[]) {
  const current = stages.find((s) => s.code === row.currentStageCode);
  return {
    id: row.id,
    customerId: row.customerId,
    customerName: row.customer.name,
    phone: row.customer.phone,
    orderId: row.orderId,
    orderNo: row.order?.orderNo ?? null,
    trackType: row.trackType,
    currentStageCode: row.currentStageCode,
    currentStageName: current?.name ?? row.currentStageCode,
    currentStageSequenceNo: current?.sequenceNo ?? null,
    totalStages: stages.length,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    version: row.rowVersion,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class JourneysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly suggestions: NotificationSuggestionService,
  ) {}

  // ---------------------------------------------------------------------------
  // 단계 마스터
  // ---------------------------------------------------------------------------

  async listStages(query: ListStagesQueryDto) {
    return this.prisma.journeyStage.findMany({
      where: { active: true, ...(query.trackType ? { trackType: query.trackType } : {}) },
      orderBy: [{ trackType: 'asc' }, { sequenceNo: 'asc' }],
      select: {
        id: true,
        trackType: true,
        code: true,
        name: true,
        sequenceNo: true,
        templateId: true,
        template: { select: { id: true, code: true, name: true, channel: true } },
      },
    });
  }

  /** 단계에 붙일 연락 문구를 바꾼다. null이면 그 단계에서는 연락을 제안하지 않는다. */
  async updateStageTemplate(id: string, templateId: string | null, actor: AuthUser) {
    const stage = await this.prisma.journeyStage.findUnique({ where: { id } });
    if (!stage) throw new NotFoundException('진행 단계가 없습니다.');
    if (templateId) {
      const template = await this.prisma.notificationTemplate.findUnique({
        where: { id: templateId },
      });
      if (!template)
        throw new BusinessException('VALIDATION_ERROR', '알림 템플릿이 없습니다.', [
          { field: 'templateId', reason: 'NOT_FOUND' },
        ]);
    }
    const updated = await this.prisma.journeyStage.update({
      where: { id },
      data: { templateId },
      select: {
        id: true,
        trackType: true,
        code: true,
        name: true,
        sequenceNo: true,
        templateId: true,
        template: { select: { id: true, code: true, name: true, channel: true } },
      },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'JOURNEY_STAGE',
      entityId: id,
      before: { templateId: stage.templateId },
      after: { templateId },
    });
    return updated;
  }

  private async stagesOf(trackType: string): Promise<StageRow[]> {
    const stages = await this.prisma.journeyStage.findMany({
      where: { trackType, active: true },
      orderBy: { sequenceNo: 'asc' },
      select: { code: true, name: true, sequenceNo: true, templateId: true },
    });
    if (stages.length === 0)
      throw new BusinessException('VALIDATION_ERROR', `진행 단계가 정의되지 않은 트랙입니다: ${trackType}`, [
        { field: 'trackType', reason: 'NO_STAGES' },
      ]);
    return stages;
  }

  // ---------------------------------------------------------------------------
  // 진행 생성·조회
  // ---------------------------------------------------------------------------

  async create(customerId: string, dto: CreateJourneyDto, actor: AuthUser) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new BusinessException('CUSTOMER_NOT_FOUND', '고객이 없습니다.');

    const stages = await this.stagesOf(dto.trackType);
    const startStage = dto.startStageCode
      ? stages.find((s) => s.code === dto.startStageCode)
      : stages[0];
    if (!startStage)
      throw new BusinessException('VALIDATION_ERROR', '알 수 없는 시작 단계입니다.', [
        { field: 'startStageCode', reason: 'UNKNOWN_STAGE' },
      ]);

    if (dto.orderId) {
      const order = await this.prisma.order.findUnique({ where: { id: dto.orderId } });
      if (!order) throw new BusinessException('NOT_FOUND', '주문이 없습니다.');
      // 주문 1건당 진행 1건. 중복 생성은 업무상 오류다.
      const duplicated = await this.prisma.customerJourney.findFirst({
        where: { orderId: dto.orderId, status: { not: 'CANCELLED' } },
      });
      if (duplicated)
        throw new BusinessException('VALIDATION_ERROR', '이미 진행이 등록된 주문입니다.', [
          { field: 'orderId', reason: 'DUPLICATE' },
        ]);
    }

    const now = new Date();
    const journey = await this.prisma.customerJourney.create({
      data: {
        id: randomUUID(),
        customerId,
        orderId: dto.orderId ?? null,
        trackType: dto.trackType,
        currentStageCode: startStage.code,
        status: 'ACTIVE',
        startedAt: now,
      },
      select: JOURNEY_SELECT,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'CUSTOMER_JOURNEY',
      entityId: journey.id,
      after: { trackType: dto.trackType, currentStageCode: startStage.code, orderId: dto.orderId },
    });
    return toJourneyView(journey, stages);
  }

  async listByCustomer(customerId: string) {
    const rows = await this.prisma.customerJourney.findMany({
      where: { customerId },
      orderBy: { startedAt: 'desc' },
      select: JOURNEY_SELECT,
    });
    const stagesByTrack = new Map<string, StageRow[]>();
    for (const track of new Set(rows.map((r) => r.trackType))) {
      stagesByTrack.set(track, await this.stagesOf(track));
    }
    return rows.map((r) => toJourneyView(r, stagesByTrack.get(r.trackType) ?? []));
  }

  async get(id: string) {
    const row = await this.prisma.customerJourney.findUnique({
      where: { id },
      select: JOURNEY_SELECT,
    });
    if (!row) throw new NotFoundException('진행이 없습니다.');
    const stages = await this.stagesOf(row.trackType);
    const events = await this.prisma.journeyEvent.findMany({
      where: { journeyId: id },
      orderBy: { changedAt: 'desc' },
      select: EVENT_SELECT,
    });
    return {
      ...toJourneyView(row, stages),
      stages: stages.map((s) => ({
        code: s.code,
        name: s.name,
        sequenceNo: s.sequenceNo,
        hasTemplate: s.templateId != null,
      })),
      events,
    };
  }

  // ---------------------------------------------------------------------------
  // 단계 변경 — 고객 연락의 유일한 트리거 (개발설계서 05 G-11/G-06)
  // ---------------------------------------------------------------------------

  async changeStage(id: string, dto: ChangeStageDto, actor: AuthUser) {
    const journey = await this.prisma.customerJourney.findUnique({
      where: { id },
      select: JOURNEY_SELECT,
    });
    if (!journey) throw new NotFoundException('진행이 없습니다.');
    if (journey.status !== 'ACTIVE')
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '종료된 진행의 단계는 변경할 수 없습니다.',
        undefined,
        { status: journey.status },
      );
    if (journey.rowVersion !== dto.version)
      throw new BusinessException(
        'VERSION_CONFLICT',
        '다른 사용자가 먼저 변경했습니다. 새로고침 후 다시 시도해 주세요.',
        undefined,
        { current: journey.rowVersion, requested: dto.version },
      );

    const stages = await this.stagesOf(journey.trackType);
    const target = stages.find((s) => s.code === dto.toStageCode);
    if (!target)
      throw new BusinessException('VALIDATION_ERROR', `이 트랙에 없는 단계입니다: ${dto.toStageCode}`, [
        { field: 'toStageCode', reason: 'UNKNOWN_STAGE' },
      ]);

    const currentSeq = stages.find((s) => s.code === journey.currentStageCode)?.sequenceNo ?? 0;
    if (target.sequenceNo === currentSeq)
      throw new BusinessException('VALIDATION_ERROR', '이미 해당 단계입니다.', [
        { field: 'toStageCode', reason: 'SAME_STAGE' },
      ]);
    // 전진은 건너뛰기를 허용한다(현장에서 단계가 생략되는 경우가 있다).
    // 후진은 사유를 남겨야 한다 — production-status.ts의 되돌리기 규칙과 동일한 철학.
    if (target.sequenceNo < currentSeq && !dto.reason)
      throw new BusinessException('VALIDATION_ERROR', '이전 단계로 되돌리려면 사유가 필요합니다.', [
        { field: 'reason', reason: 'REQUIRED_FOR_BACKWARD' },
      ]);

    const stageRow = await this.prisma.journeyStage.findUnique({
      where: { trackType_code: { trackType: journey.trackType, code: target.code } },
      select: { id: true },
    });

    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const event = await tx.journeyEvent.create({
        data: {
          id: randomUUID(),
          journeyId: id,
          stageId: stageRow!.id,
          fromStageCode: journey.currentStageCode,
          toStageCode: target.code,
          reason: dto.reason ?? null,
          notes: dto.notes ?? null,
          notificationOutcome: 'NONE',
          actorId: actor.id,
          changedAt: now,
        },
        select: EVENT_SELECT,
      });
      const updated = await tx.customerJourney.update({
        where: { id },
        data: { currentStageCode: target.code, rowVersion: { increment: 1 } },
        select: JOURNEY_SELECT,
      });
      await this.audit.log(
        {
          userId: actor.id,
          action: 'STATUS_CHANGE',
          entityType: 'CUSTOMER_JOURNEY',
          entityId: id,
          before: { currentStageCode: journey.currentStageCode },
          after: { currentStageCode: target.code },
          reason: dto.reason,
        },
        tx,
      );
      return { event, updated };
    });

    return {
      journey: toJourneyView(result.updated, stages),
      event: result.event,
      // 발송은 별도 요청이다. 발송 실패가 단계 변경을 롤백해서는 안 되고,
      // 담당자가 문구를 보고 취소할 수 있어야 하기 때문이다.
      suggestedNotification: await this.buildSuggestion(result.updated, target, result.event.id),
    };
  }

  /** 단계에 연결된 템플릿이 있으면 치환된 문구를 만들어 확인창 재료로 돌려준다. */
  private async buildSuggestion(journey: JourneyRow, stage: StageRow, eventId: string) {
    if (!stage.templateId) return null;
    const suggestion = await this.suggestions.build({
      templateId: stage.templateId,
      customerId: journey.customerId,
      orderId: journey.orderId,
      // 같은 진행의 같은 단계는 한 번만 발송된다.
      triggerKey: `journey:${journey.id}:${stage.code}`,
    });
    // 발송 결과를 어느 이력에 봉합할지 화면이 알아야 한다.
    return suggestion ? { eventId, ...suggestion } : null;
  }

  /** 발송 확인창의 처리 결과를 이력에 봉합한다. */
  async setNotificationOutcome(
    journeyId: string,
    eventId: string,
    dto: NotificationOutcomeDto,
    actor: AuthUser,
  ) {
    const event = await this.prisma.journeyEvent.findUnique({ where: { id: eventId } });
    if (!event || event.journeyId !== journeyId)
      throw new NotFoundException('단계 변경 이력이 없습니다.');
    if (dto.outcome === 'SENT' && !dto.notificationHistoryId)
      throw new BusinessException('VALIDATION_ERROR', '발송 이력 ID가 필요합니다.', [
        { field: 'notificationHistoryId', reason: 'REQUIRED_FOR_SENT' },
      ]);

    const updated = await this.prisma.journeyEvent.update({
      where: { id: eventId },
      data: {
        notificationOutcome: dto.outcome,
        notificationHistoryId: dto.notificationHistoryId ?? null,
      },
      select: EVENT_SELECT,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'JOURNEY_EVENT',
      entityId: eventId,
      before: { notificationOutcome: event.notificationOutcome },
      after: { notificationOutcome: dto.outcome },
    });
    return updated;
  }

  // ---------------------------------------------------------------------------
  // 종료
  // ---------------------------------------------------------------------------

  async close(id: string, status: 'COMPLETED' | 'CANCELLED', dto: CloseJourneyDto, actor: AuthUser) {
    const journey = await this.prisma.customerJourney.findUnique({
      where: { id },
      select: JOURNEY_SELECT,
    });
    if (!journey) throw new NotFoundException('진행이 없습니다.');
    if (journey.status !== 'ACTIVE')
      throw new BusinessException('INVALID_STATUS_TRANSITION', '이미 종료된 진행입니다.', undefined, {
        status: journey.status,
      });
    if (journey.rowVersion !== dto.version)
      throw new BusinessException('VERSION_CONFLICT', '다른 사용자가 먼저 변경했습니다.', undefined, {
        current: journey.rowVersion,
        requested: dto.version,
      });

    const updated = await this.prisma.customerJourney.update({
      where: { id },
      data: { status, completedAt: new Date(), rowVersion: { increment: 1 } },
      select: JOURNEY_SELECT,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'STATUS_CHANGE',
      entityType: 'CUSTOMER_JOURNEY',
      entityId: id,
      before: { status: journey.status },
      after: { status },
      reason: dto.reason,
    });
    return toJourneyView(updated, await this.stagesOf(updated.trackType));
  }

  // ---------------------------------------------------------------------------
  // 진행 현황 (칸반·정체 조회)
  // ---------------------------------------------------------------------------

  async list(query: ListJourneysQueryDto) {
    const stageCodes = query.stageCodes
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const where: Prisma.CustomerJourneyWhereInput = {
      ...(query.trackType ? { trackType: query.trackType } : {}),
      ...(query.status ? { status: query.status } : { status: 'ACTIVE' }),
      ...(stageCodes?.length ? { currentStageCode: { in: stageCodes } } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
    };
    if (query.stalledDays) {
      const threshold = new Date(Date.now() - query.stalledDays * 24 * 60 * 60 * 1000);
      where.updatedAt = { lt: threshold };
    }

    const [rows, total] = await Promise.all([
      this.prisma.customerJourney.findMany({
        where,
        orderBy: { updatedAt: 'asc' },
        skip: query.skip,
        take: query.size,
        select: JOURNEY_SELECT,
      }),
      this.prisma.customerJourney.count({ where }),
    ]);

    const stagesByTrack = new Map<string, StageRow[]>();
    for (const track of new Set(rows.map((r) => r.trackType))) {
      stagesByTrack.set(track, await this.stagesOf(track));
    }
    const now = Date.now();
    const items = rows.map((r) => ({
      ...toJourneyView(r, stagesByTrack.get(r.trackType) ?? []),
      /** 현재 단계에 머문 일수 — 보드에서 정체 강조에 쓴다 */
      daysInStage: Math.floor((now - r.updatedAt.getTime()) / (24 * 60 * 60 * 1000)),
    }));
    return new Paginated(items, query.page, query.size, total, {
      stalledThresholdDays: query.stalledDays ?? DEFAULT_STALLED_DAYS,
    });
  }
}
