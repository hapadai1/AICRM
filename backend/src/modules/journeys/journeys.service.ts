import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { todayAsDbDate } from '../../common/date';
import { AuthUser } from '../../common/decorators';
import { Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { defaultLabelsOf } from '../admin-master/code-labels.constants';
import { AuditService } from '../audit/audit.service';
import { NotificationSuggestionService } from '../notifications/notification-suggestion.service';
import { applyItemStatus } from '../production/item-status';
import { repairItemsLabel } from '../repairs/repair-item-label';
import { CONSULT_RESERVED_EXPIRE_DAYS, DEFAULT_STALLED_DAYS } from './journeys.constants';
import { computeGating, type GatingResult } from './journey-gating';
import {
  ChangeStageDto,
  CloseJourneyDto,
  CompleteItemDto,
  CreateJourneyDto,
  ListJourneysQueryDto,
  ListStagesQueryDto,
  NotificationOutcomeDto,
  PutStageMessageDto,
} from './journeys.dto';

const JOURNEY_SELECT = {
  id: true,
  customerId: true,
  orderId: true,
  sourceRepairRequestId: true,
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

/**
 * 수선 유형 라벨 — REPAIR 트랙 대상 품목 표시명에 쓴다.
 * 기준정보 상수(단일 출처)의 기본 표시명을 그대로 쓴다. 관리자 오버라이드는 반영하지 않는다
 * (진행 상세 조회마다 master_code_labels를 읽지 않기 위함).
 */
const REPAIR_TYPE_LABELS = defaultLabelsOf('repair-type');

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
type StageRow = {
  id: string;
  code: string;
  name: string;
  sequenceNo: number;
  templateId: string | null;
  completionMode: string;
  targetScope: string;
};

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

/**
 * 상담 예약 자동종료 지연평가 (설계서 02 §9.2·§10.3).
 * ACTIVE인 CONSULT_RESERVED 단계이고, 아직 계약(주문 연결)이 없으며, 예약 후 임계 일수가 지났으면
 * 화면 표기용 expired 힌트를 준다. 실제 status는 바꾸지 않는다(스케줄러 없음, 플래그만).
 */
function isConsultReservedExpired(
  row: Pick<JourneyRow, 'currentStageCode' | 'status' | 'orderId' | 'startedAt'>,
  now: number = Date.now(),
): boolean {
  if (row.status !== 'ACTIVE' || row.currentStageCode !== 'CONSULT_RESERVED' || row.orderId != null)
    return false;
  const ageDays = (now - row.startedAt.getTime()) / (24 * 60 * 60 * 1000);
  return ageDays > CONSULT_RESERVED_EXPIRE_DAYS;
}

/**
 * 단계 마스터 응답. 연락 문구는 시점에 붙어서만 존재하므로(2026-07-29) 본문·승인까지 함께 준다 —
 * 관리 화면이 문구 목록을 따로 받지 않고 이 한 번의 조회로 표를 그린다.
 */
const STAGE_MASTER_SELECT = {
  id: true,
  trackType: true,
  code: true,
  name: true,
  sequenceNo: true,
  templateId: true,
  template: {
    select: { id: true, code: true, name: true, channel: true, body: true, approvalStatus: true },
  },
} as const;

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
      select: STAGE_MASTER_SELECT,
    });
  }

  /**
   * 그 시점에 보낼 문구를 쓴다 — 없으면 만들어 붙이고, 있으면 본문·채널·승인만 고친다.
   *
   * 문구는 **시점 하나에만 붙는다**(2026-07-29 결정). 같은 내용을 두 시점에서 쓰려면
   * 시점마다 따로 쓴다 — 문구를 공유하면 한쪽을 고칠 때 다른 시점 문구까지 바뀐다.
   * 그래서 코드·이름도 담당자가 정하지 않고 단계에서 만든다(내부 식별자다).
   */
  async putStageMessage(id: string, dto: PutStageMessageDto, actor: AuthUser) {
    const stage = await this.prisma.journeyStage.findUnique({ where: { id } });
    if (!stage) throw new NotFoundException('진행 단계가 없습니다.');

    if (stage.templateId) {
      const before = await this.prisma.notificationTemplate.findUnique({
        where: { id: stage.templateId },
      });
      const template = await this.prisma.notificationTemplate.update({
        where: { id: stage.templateId },
        data: {
          body: dto.body,
          ...(dto.channel ? { channel: dto.channel } : {}),
          ...(dto.approvalStatus ? { approvalStatus: dto.approvalStatus } : {}),
        },
      });
      await this.audit.log({
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'NOTIFICATION_TEMPLATE',
        entityId: template.id,
        before,
        after: template,
      });
      return this.stageWithTemplate(id);
    }

    // 코드는 단계에서 만든다. 지웠다 다시 쓰는 경우가 있으므로 충돌하면 뒤에 번호를 붙인다.
    const template = await this.prisma.notificationTemplate.create({
      data: {
        id: randomUUID(),
        code: await this.freeTemplateCode(`JOURNEY_${stage.code}`),
        name: `${stage.name} 안내`,
        channel: dto.channel ?? 'ALIMTALK',
        body: dto.body,
        approvalStatus: dto.approvalStatus ?? 'PENDING',
      },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'NOTIFICATION_TEMPLATE',
      entityId: template.id,
      after: template,
    });
    return this.updateStageTemplate(id, template.id, actor);
  }

  /**
   * 그 시점의 연락을 끈다 — 매핑을 풀고 문구를 지운다.
   * 발송 이력은 남긴다(본문·수신번호가 이력 자체에 있다). 링크만 끊어 '직접 입력'으로 남는다.
   */
  async deleteStageMessage(id: string, actor: AuthUser) {
    const stage = await this.prisma.journeyStage.findUnique({ where: { id } });
    if (!stage) throw new NotFoundException('진행 단계가 없습니다.');
    if (!stage.templateId) return this.stageWithTemplate(id);
    const templateId = stage.templateId;

    const updated = await this.updateStageTemplate(id, null, actor);
    // 문구는 시점 하나에만 붙지만, 예전 데이터가 공유 중이면 남겨 둔다.
    const usedElsewhere = await this.prisma.journeyStage.count({ where: { templateId } });
    if (usedElsewhere > 0) return updated;

    const before = await this.prisma.notificationTemplate.findUnique({ where: { id: templateId } });
    await this.prisma.notificationHistory.updateMany({
      where: { templateId },
      data: { templateId: null },
    });
    await this.prisma.notificationRule.deleteMany({ where: { templateId } });
    await this.prisma.notificationTemplate.delete({ where: { id: templateId } });
    await this.audit.log({
      userId: actor.id,
      action: 'DELETE',
      entityType: 'NOTIFICATION_TEMPLATE',
      entityId: templateId,
      before,
    });
    return updated;
  }

  /** `JOURNEY_{단계코드}`가 이미 쓰이고 있으면 뒤에 번호를 붙여 비어 있는 코드를 찾는다. */
  private async freeTemplateCode(base: string): Promise<string> {
    for (let n = 0; n < 100; n += 1) {
      const code = n === 0 ? base : `${base}_${n + 1}`;
      const exists = await this.prisma.notificationTemplate.findUnique({ where: { code } });
      if (!exists) return code;
    }
    throw new BusinessException('VALIDATION_ERROR', '문구 코드를 만들 수 없습니다.', [
      { field: 'code', reason: 'DUPLICATE' },
    ]);
  }

  private stageWithTemplate(id: string) {
    return this.prisma.journeyStage.findUniqueOrThrow({
      where: { id },
      select: STAGE_MASTER_SELECT,
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
      // 문구는 시점 하나에만 붙는다 — 공유하면 한 시점을 고칠 때 다른 시점 문구까지 바뀐다.
      const takenBy = await this.prisma.journeyStage.findFirst({
        where: { templateId, id: { not: id } },
        select: { name: true },
      });
      if (takenBy)
        throw new BusinessException(
          'VALIDATION_ERROR',
          `이미 '${takenBy.name}' 시점에 쓰는 문구입니다. 시점마다 문구를 따로 씁니다.`,
          [{ field: 'templateId', reason: 'ALREADY_MAPPED' }],
        );
    }
    const updated = await this.prisma.journeyStage.update({
      where: { id },
      data: { templateId },
      select: STAGE_MASTER_SELECT,
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
      select: {
        id: true,
        code: true,
        name: true,
        sequenceNo: true,
        templateId: true,
        completionMode: true,
        targetScope: true,
      },
    });
    if (stages.length === 0)
      throw new BusinessException('VALIDATION_ERROR', `진행 단계가 정의되지 않은 트랙입니다: ${trackType}`, [
        { field: 'trackType', reason: 'NO_STAGES' },
      ]);
    return stages;
  }

  // ---------------------------------------------------------------------------
  // 품목별 완료 / 게이팅 (v2 D2 · 설계서 02 §3·§4)
  // ---------------------------------------------------------------------------

  /**
   * 단계의 게이팅 대상 품목을 화면 표시 정보와 함께 해석한다.
   * - ORDER_ITEMS: 진행에 묶인 주문의 활성 품목(취소 제외) — CUSTOM/RENTAL
   * - REPAIR_ITEMS: 수선요청(RepairRequest) — REPAIR 트랙(S6에서 연결)
   */
  private async resolveTargets(
    journey: Pick<JourneyRow, 'orderId' | 'sourceRepairRequestId'>,
    stage: Pick<StageRow, 'targetScope'>,
  ): Promise<{
    targetType: 'ORDER_ITEM' | 'REPAIR_ITEM' | null;
    targets: Array<{ id: string; displayName: string; productCategory: string; status: string }>;
  }> {
    if (stage.targetScope === 'ORDER_ITEMS') {
      if (!journey.orderId) return { targetType: 'ORDER_ITEM', targets: [] };
      const items = await this.prisma.orderItem.findMany({
        where: { orderId: journey.orderId, status: { not: 'CANCELLED' } },
        orderBy: [{ productCategory: 'asc' }, { sequenceNo: 'asc' }],
        select: { id: true, displayName: true, productCategory: true, status: true },
      });
      return { targetType: 'ORDER_ITEM', targets: items };
    }
    if (stage.targetScope === 'REPAIR_ITEMS') {
      // 기본안(설계서 02 §7.2): RepairRequest 1건 = journey 1건 → 대상 품목 = 그 수선요청 1건.
      if (!journey.sourceRepairRequestId) return { targetType: 'REPAIR_ITEM', targets: [] };
      const repair = await this.prisma.repairRequest.findUnique({
        where: { id: journey.sourceRepairRequestId },
        select: {
          id: true,
          repairType: true,
          description: true,
          status: true,
          items: { select: { targetProduct: true, quantity: true }, orderBy: { sequenceNo: 'asc' } },
          orderItem: { select: { displayName: true, productCategory: true } },
          component: { select: { componentType: true } },
        },
      });
      if (!repair) return { targetType: 'REPAIR_ITEM', targets: [] };
      const label = REPAIR_TYPE_LABELS[repair.repairType] ?? repair.repairType;
      // 대상명: 대상 품목 > (구방식 연결) 맞춤 품목 > 구성품 > 대상 설명 순으로 채운다.
      const linkedName =
        repairItemsLabel(repair.items) ??
        repair.orderItem?.displayName ??
        repair.component?.componentType ??
        repair.description;
      return {
        targetType: 'REPAIR_ITEM',
        targets: [
          {
            id: repair.id,
            displayName: `${label} · ${linkedName}`,
            productCategory: repair.orderItem?.productCategory ?? 'REPAIR',
            status: repair.status,
          },
        ],
      };
    }
    return { targetType: null, targets: [] };
  }

  /** 단계 게이팅 현황 계산 (대상 품목 vs 완료 기록). */
  private async gatingOf(
    journey: Pick<JourneyRow, 'id' | 'orderId' | 'sourceRepairRequestId'>,
    stage: Pick<StageRow, 'code' | 'completionMode' | 'targetScope'>,
  ): Promise<GatingResult> {
    const mode = stage.completionMode === 'AUTO' ? 'AUTO' : 'GATED';
    const { targets } = await this.resolveTargets(journey, stage);
    const completions = await this.prisma.journeyStageItemCompletion.findMany({
      where: { journeyId: journey.id, stageCode: stage.code },
      select: { targetId: true, revokedAt: true },
    });
    return computeGating(
      stage.code,
      mode,
      targets.map((t) => t.id),
      completions,
    );
  }

  /** 단계 대상 품목 목록 + 완료상태 + 게이팅 + production 힌트 */
  async getStageItems(id: string, stageCode: string) {
    const journey = await this.prisma.customerJourney.findUnique({
      where: { id },
      select: JOURNEY_SELECT,
    });
    if (!journey) throw new NotFoundException('진행이 없습니다.');
    const stages = await this.stagesOf(journey.trackType);
    const stage = stages.find((s) => s.code === stageCode);
    if (!stage)
      throw new BusinessException('VALIDATION_ERROR', `이 트랙에 없는 단계입니다: ${stageCode}`, [
        { field: 'stageCode', reason: 'UNKNOWN_STAGE' },
      ]);

    const { targetType, targets } = await this.resolveTargets(journey, stage);
    const completions = await this.prisma.journeyStageItemCompletion.findMany({
      where: { journeyId: id, stageCode },
      select: {
        targetId: true,
        revokedAt: true,
        completedAt: true,
        completedBy: true,
        completedByUser: { select: { id: true, displayName: true } },
      },
    });
    const byTarget = new Map(completions.map((c) => [c.targetId, c]));

    const items = targets.map((t) => {
      const c = byTarget.get(t.id);
      const done = c != null && c.revokedAt === null;
      return {
        targetId: t.id,
        targetType,
        displayName: t.displayName,
        productCategory: t.productCategory,
        completed: done,
        completedAt: done ? c!.completedAt : null,
        completedBy: done ? c!.completedBy : null,
        completedByName: done ? (c!.completedByUser?.displayName ?? null) : null,
        // production 상태는 힌트일 뿐 완료를 자동 생성하지 않는다(D2 비연동).
        productionHint: { status: t.status },
      };
    });
    const gating = computeGating(
      stageCode,
      stage.completionMode === 'AUTO' ? 'AUTO' : 'GATED',
      targets.map((t) => t.id),
      completions,
    );
    return { stageCode, completionMode: stage.completionMode, items, gating };
  }

  /** 품목 완료(멱등 upsert). 완료 취소된 기록은 되살린다. */
  async completeItem(
    id: string,
    stageCode: string,
    targetId: string,
    dto: CompleteItemDto,
    actor: AuthUser,
  ) {
    const journey = await this.prisma.customerJourney.findUnique({
      where: { id },
      select: JOURNEY_SELECT,
    });
    if (!journey) throw new NotFoundException('진행이 없습니다.');
    const stages = await this.stagesOf(journey.trackType);
    const stage = stages.find((s) => s.code === stageCode);
    if (!stage)
      throw new BusinessException('VALIDATION_ERROR', `이 트랙에 없는 단계입니다: ${stageCode}`, [
        { field: 'stageCode', reason: 'UNKNOWN_STAGE' },
      ]);
    if (stage.completionMode !== 'GATED')
      throw new BusinessException('VALIDATION_ERROR', '이 단계는 품목별 완료 대상이 아닙니다.', [
        { field: 'stageCode', reason: 'NOT_GATED' },
      ]);

    // 대상 품목 검증 (다형 참조라 앱에서 존재·소속 검증)
    const { targetType, targets } = await this.resolveTargets(journey, stage);
    if (!targets.some((t) => t.id === targetId))
      throw new BusinessException('VALIDATION_ERROR', '이 단계의 대상 품목이 아닙니다.', [
        { field: 'targetId', reason: 'NOT_A_TARGET' },
      ]);

    const now = new Date();
    const existing = await this.prisma.journeyStageItemCompletion.findUnique({
      where: {
        journeyId_stageCode_targetType_targetId: {
          journeyId: id,
          stageCode,
          targetType: targetType!,
          targetId,
        },
      },
    });
    if (existing) {
      // 멱등: 이미 완료면 그대로, 취소상태면 되살린다.
      if (existing.revokedAt !== null) {
        await this.prisma.journeyStageItemCompletion.update({
          where: { id: existing.id },
          data: { revokedAt: null, completedAt: now, completedBy: actor.id, notes: dto.notes ?? null },
        });
      }
    } else {
      await this.prisma.journeyStageItemCompletion.create({
        data: {
          id: randomUUID(),
          journeyId: id,
          stageCode,
          targetType: targetType!,
          targetId,
          completedAt: now,
          completedBy: actor.id,
          notes: dto.notes ?? null,
        },
      });
    }
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'JOURNEY_STAGE_ITEM_COMPLETION',
      entityId: id,
      before: {
        stageCode,
        targetId,
        completed: !!existing && existing.revokedAt === null,
        notes: existing?.notes ?? null,
      },
      after: { stageCode, targetId, completed: true, notes: dto.notes ?? null },
    });

    // 렌탈 반납 완료를 품목 상태에 반영한다 (방안 A) — 반납은 진행 기록에만 남아
    // 출고(RELEASED)가 완료로 오인됐다. 반납이 끝난 품목만 COMPLETED로 승격한다.
    if (stageCode === 'RENTAL_RETURNED' && targetType === 'ORDER_ITEM')
      await this.syncRentalReturnStatus(targetId, true, actor.id);

    const gating = await this.gatingOf(journey, stage);
    return {
      completion: { targetId, targetType, completedAt: now, completedBy: actor.id },
      gating,
    };
  }

  /**
   * 렌탈 반납(RENTAL_RETURNED) 완료/취소를 품목 상태에 반영한다 (2026-08-12, 방안 A).
   * 반납은 진행 단계 기록에만 남고 품목 상태를 바꾸지 않아, 목록·진행률이 출고(RELEASED)를
   * 완료로 오인했다. 반납 완료 시 RELEASED→COMPLETED, 취소 시 COMPLETED→RELEASED로 되돌린다.
   * 품목 상태 단일 기록자(applyItemStatus)를 거쳐 제작 이력과 짝으로 남긴다.
   */
  private async syncRentalReturnStatus(
    orderItemId: string,
    done: boolean,
    actorId: string,
  ): Promise<void> {
    const item = await this.prisma.orderItem.findUnique({
      where: { id: orderItemId },
      select: { status: true },
    });
    if (!item) return;
    const from = item.status;
    // 반납 완료는 출고까지 끝난 품목만, 취소는 반납으로 완료된 품목만 되돌린다(그 외 상태는 건드리지 않는다).
    if (done && from !== 'RELEASED') return;
    if (!done && from !== 'COMPLETED') return;
    const to = done ? 'COMPLETED' : 'RELEASED';
    await this.prisma.$transaction(async (tx) => {
      await applyItemStatus(tx, {
        orderItemId,
        from,
        to,
        eventDate: new Date(),
        actorId,
        notes: done ? '렌탈 반납 완료' : '렌탈 반납 취소',
      });
      await this.audit.log(
        {
          userId: actorId,
          action: 'STATUS_CHANGE',
          entityType: 'ORDER_ITEM',
          entityId: orderItemId,
          before: { status: from },
          after: { status: to },
          reason: done ? '렌탈 반납 완료' : '렌탈 반납 취소',
        },
        tx,
      );
    });
  }

  /** 품목 완료 취소(revokedAt 세팅, 물리삭제 금지). */
  async uncompleteItem(id: string, stageCode: string, targetId: string, actor: AuthUser) {
    const journey = await this.prisma.customerJourney.findUnique({
      where: { id },
      select: JOURNEY_SELECT,
    });
    if (!journey) throw new NotFoundException('진행이 없습니다.');
    const stages = await this.stagesOf(journey.trackType);
    const stage = stages.find((s) => s.code === stageCode);
    if (!stage)
      throw new BusinessException('VALIDATION_ERROR', `이 트랙에 없는 단계입니다: ${stageCode}`, [
        { field: 'stageCode', reason: 'UNKNOWN_STAGE' },
      ]);
    const { targetType } = await this.resolveTargets(journey, stage);
    const existing = await this.prisma.journeyStageItemCompletion.findUnique({
      where: {
        journeyId_stageCode_targetType_targetId: {
          journeyId: id,
          stageCode,
          targetType: targetType!,
          targetId,
        },
      },
    });
    if (existing && existing.revokedAt === null) {
      await this.prisma.journeyStageItemCompletion.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
      });
      await this.audit.log({
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'JOURNEY_STAGE_ITEM_COMPLETION',
        entityId: id,
        before: { stageCode, targetId, completed: true, completedAt: existing.completedAt },
        after: { stageCode, targetId, completed: false },
      });
      // 반납 완료를 되돌리면 품목도 완료 전(RELEASED)으로 강등한다 (방안 A).
      if (stageCode === 'RENTAL_RETURNED' && targetType === 'ORDER_ITEM')
        await this.syncRentalReturnStatus(targetId, false, actor.id);
    }
    return { gating: await this.gatingOf(journey, stage) };
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

  /**
   * 수선 접수 시 REPAIR 진행을 자동 생성한다 (설계서 02 §7.2·§9.2).
   * REPAIR_RECEIVED는 AUTO 단계 — 접수 등록이 곧 자동완료다(추가 품목완료 불필요).
   * 같은 수선요청으로 이미 진행이 있으면 그대로 둔다(멱등).
   * repairs.create 트랜잭션에서 호출되므로 그 tx 위에서 실행한다.
   */
  async createRepairJourney(
    tx: Prisma.TransactionClient,
    customerId: string,
    repairRequestId: string,
    actor: AuthUser,
  ): Promise<{ id: string; created: boolean }> {
    // sourceRepairRequestId는 unique이므로 상태 무관 1건만 존재 — 있으면 그대로 둔다(멱등).
    const existing = await tx.customerJourney.findUnique({
      where: { sourceRepairRequestId: repairRequestId },
      select: { id: true },
    });
    if (existing) return { id: existing.id, created: false };

    const journey = await tx.customerJourney.create({
      data: {
        id: randomUUID(),
        customerId,
        orderId: null,
        sourceRepairRequestId: repairRequestId,
        trackType: 'REPAIR',
        currentStageCode: 'REPAIR_RECEIVED',
        status: 'ACTIVE',
        startedAt: new Date(),
      },
      select: { id: true },
    });
    await this.audit.log(
      {
        userId: actor.id,
        action: 'CREATE',
        entityType: 'CUSTOMER_JOURNEY',
        entityId: journey.id,
        after: {
          trackType: 'REPAIR',
          currentStageCode: 'REPAIR_RECEIVED',
          sourceRepairRequestId: repairRequestId,
        },
      },
      tx,
    );
    return { id: journey.id, created: true };
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

    // 연락은 "방금 끝낸 단계"의 문구다 (2026-08-12) — 현재 단계로 들어오게 만든 이벤트의
    // 출발 단계(=끝난 단계)를 본다. 가봉 입고를 끝내 가봉 피팅에 와 있으면, 아직 안 보냈을 때
    // [고객 연락] 버튼을 상시 띄운다. (발송 자체는 여전히 담당자가 확인창에서 눌러야 나간다)
    const enteringEvent = events.find((e) => e.toStageCode === row.currentStageCode);
    const completedStage = enteringEvent
      ? stages.find((s) => s.code === enteringEvent.fromStageCode)
      : undefined;
    const currentSuggestion =
      row.status === 'ACTIVE' &&
      completedStage?.templateId &&
      enteringEvent &&
      enteringEvent.notificationOutcome !== 'SENT'
        ? await this.buildSuggestion(row, completedStage, enteringEvent.id)
        : null;

    // 게이팅: 대상 품목은 트랙 내 GATED 단계가 공유하므로 한 번만 해석한다.
    // CUSTOM/RENTAL = 주문 활성 품목, REPAIR = 원천 수선요청(설계서 02 §7.2).
    const orderTargets =
      row.orderId != null
        ? await this.prisma.orderItem.findMany({
            where: { orderId: row.orderId, status: { not: 'CANCELLED' } },
            select: { id: true },
          })
        : [];
    const orderTargetIds = orderTargets.map((t) => t.id);
    const repairTargetIds =
      row.sourceRepairRequestId != null
        ? (await this.resolveTargets(row, { targetScope: 'REPAIR_ITEMS' })).targets.map((t) => t.id)
        : [];
    const completions = await this.prisma.journeyStageItemCompletion.findMany({
      where: { journeyId: id },
      select: { stageCode: true, targetId: true, revokedAt: true },
    });
    const completionsByStage = new Map<string, { targetId: string; revokedAt: Date | null }[]>();
    for (const c of completions) {
      const arr = completionsByStage.get(c.stageCode) ?? [];
      arr.push({ targetId: c.targetId, revokedAt: c.revokedAt });
      completionsByStage.set(c.stageCode, arr);
    }

    // 각 단계의 완료일·비고 = "fromStageCode=단계"인 가장 최근 전진 이벤트(events는 changedAt desc 정렬).
    const leaveEventByStage = new Map<string, { changedAt: Date; notes: string | null }>();
    for (const e of events) {
      if (e.fromStageCode && !leaveEventByStage.has(e.fromStageCode)) {
        leaveEventByStage.set(e.fromStageCode, { changedAt: e.changedAt, notes: e.notes });
      }
    }

    const stagesView = stages.map((s) => {
      const targetIds =
        s.targetScope === 'ORDER_ITEMS'
          ? orderTargetIds
          : s.targetScope === 'REPAIR_ITEMS'
            ? repairTargetIds
            : [];
      const gating = computeGating(
        s.code,
        s.completionMode === 'AUTO' ? 'AUTO' : 'GATED',
        targetIds,
        completionsByStage.get(s.code) ?? [],
      );
      const leave = leaveEventByStage.get(s.code);
      return {
        code: s.code,
        name: s.name,
        sequenceNo: s.sequenceNo,
        hasTemplate: s.templateId != null,
        completionMode: s.completionMode,
        targetCount: gating.targetCount,
        completedCount: gating.completedCount,
        canComplete: gating.canComplete,
        completed: leave != null,
        completedAt: leave?.changedAt ?? null,
        notes: leave?.notes ?? null,
      };
    });

    return {
      ...toJourneyView(row, stages),
      // 상담 예약 자동종료 지연평가 힌트(화면 표기용, status 변경 없음).
      expired: isConsultReservedExpired(row),
      stages: stagesView,
      events,
      currentSuggestion,
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

    // 게이팅(D2): 전진일 때 현재 단계가 GATED면 대상 전 품목 완료를 서버에서 재검증한다.
    // 후진·건너뛰기 시 중간 단계는 검증하지 않는다(현장 유연성, 설계서 02 §5.1).
    const isForward = target.sequenceNo > currentSeq;
    const currentMeta = stages.find((s) => s.code === journey.currentStageCode);
    if (isForward && currentMeta?.completionMode === 'GATED') {
      const gate = await this.gatingOf(journey, currentMeta);
      if (!gate.canComplete)
        throw new BusinessException(
          'STAGE_NOT_COMPLETE',
          '이 단계의 모든 품목이 완료되어야 다음 단계로 넘어갈 수 있습니다.',
          [{ field: 'toStageCode', reason: 'STAGE_ITEMS_INCOMPLETE' }],
          { targetCount: gate.targetCount, completedCount: gate.completedCount },
        );
    }

    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const event = await tx.journeyEvent.create({
        data: {
          id: randomUUID(),
          journeyId: id,
          stageId: target.id,
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
      /*
        고객 연락은 "그 단계가 **끝났을 때**" 나간다 (현업 확정 2026-08-12). 가봉·완성복 '입고 안내'는
        실제 입고가 끝나야 보내는 문구인데, 전에는 들어가는 단계(target)의 템플릿을 제안해서
        발주를 끝내고 가봉 입고 단계에 **진입만 해도** 가봉 입고 안내가 떴다(입고 전인데도).
        전진은 지금 단계를 끝내고 다음으로 넘어가는 것이므로, 방금 끝낸 단계(currentMeta)의 문구를
        제안한다. 후진·건너뛰기는 완료가 아니므로 제안하지 않는다.
        발송은 별도 요청이다 — 발송 실패가 단계 변경을 롤백해서는 안 되고, 담당자가 문구를 보고
        취소할 수 있어야 하기 때문이다.
      */
      suggestedNotification:
        isForward && currentMeta
          ? await this.buildSuggestion(result.updated, currentMeta, result.event.id)
          : null,
    };
  }

  /** 그 단계 완료 시 보낼 템플릿이 있으면 치환된 문구를 만들어 확인창 재료로 돌려준다. */
  private async buildSuggestion(journey: JourneyRow, stage: StageRow, eventId: string) {
    if (!stage.templateId) return null;
    const suggestion = await this.suggestions.build({
      templateId: stage.templateId,
      customerId: journey.customerId,
      orderId: journey.orderId,
      // 같은 진행의 같은 단계는 한 번만 발송된다.
      triggerKey: `journey:${journey.id}:${stage.code}`,
    });
    // 발송 결과를 어느 이력에 봉합할지, 확인창 제목에 어느 단계인지 화면이 알아야 한다.
    return suggestion ? { eventId, stageName: stage.name, ...suggestion } : null;
  }

  /**
   * 수동 [고객 연락] 버튼 재료 — 그 단계 템플릿으로 문구를 만들고 마지막 발송일을 함께 돌려준다.
   * 단계 전진 흐름과 달리 멱등키를 걸지 않아(triggerKey 빈 값) 담당자가 필요하면 다시 보낼 수 있다.
   */
  async getStageContact(id: string, stageCode: string) {
    const row = await this.prisma.customerJourney.findUnique({
      where: { id },
      select: JOURNEY_SELECT,
    });
    if (!row) throw new NotFoundException('진행이 없습니다.');
    const stages = await this.stagesOf(row.trackType);
    const stage = stages.find((s) => s.code === stageCode);
    if (!stage) throw new NotFoundException('단계가 없습니다.');
    if (!stage.templateId) return { suggestion: null, lastSentAt: null };

    const built = await this.suggestions.build({
      templateId: stage.templateId,
      customerId: row.customerId,
      orderId: row.orderId,
      // build는 triggerKey를 요구하지만 수동 발송은 쓰지 않는다 — 아래에서 응답에서 뺀다.
      triggerKey: '',
    });
    /*
      수동 발송은 멱등키 없이 매번 나가야 재발송이 된다 (현업 요청 2026-08-13).
      triggerKey를 응답에 남기면 화면이 그 값으로 발송해 서버가 중복으로 막으므로, 아예 뺀다.
      (자동 전진 발송은 여전히 journey:{id}:{stage} 키로 한 번만 나간다.)
    */
    const suggestion = built
      ? (() => {
          const { triggerKey: _drop, ...rest } = built;
          return { stageName: stage.name, ...rest };
        })()
      : null;

    // 마지막 발송일 — 단계마다 템플릿이 하나씩이라(가봉 입고·완성복 입고 각각) 템플릿으로 이력을 짚는다.
    // 같은 고객이 여러 주문을 가질 수 있으므로 주문까지 좁혀 다른 계약의 발송과 섞이지 않게 한다.
    const last = await this.prisma.notificationHistory.findFirst({
      where: {
        customerId: row.customerId,
        templateId: stage.templateId,
        status: 'SENT',
        ...(row.orderId ? { orderId: row.orderId } : {}),
      },
      orderBy: { sentAt: 'desc' },
      select: { sentAt: true },
    });

    return { suggestion, lastSentAt: last?.sentAt ?? null };
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
    if (dto.outcome === 'SENT')
      // 연락 문구는 방금 **끝낸** 단계의 것이다 — 완료 이벤트의 출발 단계(fromStageCode)로 판정한다.
      await this.syncRepairNotified(journeyId, event.fromStageCode, actor);
    return updated;
  }

  /**
   * 수선 입고 안내를 실제로 보냈으면 수선 건의 '마지막 연락 시각'을 찍는다.
   *
   * 고객 연락은 더 이상 수선 상태가 아니라 발송 액션이다(수선 메뉴 버튼과 같은 사실).
   * 연락 경로가 진행 카드로도 열려 있어, 진행 카드에서 REPAIR_CHECKED_IN(수선 입고) 완료 문구를
   * 보내면 여기서 last_notified_at을 찍어 수선 메뉴 버튼도 [재발송]으로 맞춘다(상태는 건드리지 않는다).
   * 연락은 이미 나갔으므로 어긋나도 조용히 건너뛴다 — 발송 결과 기록을 실패시키지 않는다.
   */
  private async syncRepairNotified(journeyId: string, completedStageCode: string | null, actor: AuthUser) {
    if (completedStageCode !== 'REPAIR_CHECKED_IN') return;
    const journey = await this.prisma.customerJourney.findUnique({
      where: { id: journeyId },
      select: { trackType: true, sourceRepairRequestId: true },
    });
    const repairId = journey?.sourceRepairRequestId;
    if (journey?.trackType !== 'REPAIR' || !repairId) return;

    const repair = await this.prisma.repairRequest.findUnique({
      where: { id: repairId },
      select: { id: true },
    });
    if (!repair) return;

    await this.prisma.repairRequest.update({
      where: { id: repairId },
      data: { lastNotifiedAt: new Date() },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'NOTIFY',
      entityType: 'REPAIR_REQUEST',
      entityId: repairId,
      reason: '수선 입고 안내 발송(진행 카드)',
    });
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
      /** 상담 예약 자동종료 지연평가 힌트(화면 표기용) */
      expired: isConsultReservedExpired(r, now),
    }));
    return new Paginated(items, query.page, query.size, total, {
      stalledThresholdDays: query.stalledDays ?? DEFAULT_STALLED_DAYS,
    });
  }
}
