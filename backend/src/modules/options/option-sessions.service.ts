import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  ConfirmSessionDto,
  CopySessionDto,
  PauseSessionDto,
  SaveStageSelectionDto,
  StartOptionSessionDto,
} from './options.dto';

const SESSION_INCLUDE = {
  orderItem: {
    select: {
      id: true,
      displayName: true,
      productCategory: true,
      order: {
        select: {
          orderNo: true,
          contract: {
            select: {
              id: true,
              contractNo: true,
              currentVersionId: true,
              customer: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  },
  optionSetVersion: {
    select: {
      id: true,
      versionNo: true,
      status: true,
      optionSet: { select: { name: true } },
      stages: {
        orderBy: { sequenceNo: 'asc' as const },
        include: {
          choices: {
            orderBy: { choiceCode: 'asc' as const },
            select: {
              id: true,
              choiceCode: true,
              choiceName: true,
              factoryLabel: true,
              imageFileId: true,
              extraPrice: true,
              active: true,
            },
          },
        },
      },
    },
  },
  values: true,
} satisfies Prisma.OptionSelectionSessionInclude;

type SessionWithDetail = Prisma.OptionSelectionSessionGetPayload<{
  include: typeof SESSION_INCLUDE;
}>;

/** 옵션 선택 세션: 시작·임시저장·재개·확인서·확정·복사 (설계서 §8.3~8.5, 데이터 규칙 §15.3) */
@Injectable()
export class OptionSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * POST /order-items/:id/option-sessions — body { fabric? }
   * - 미확정 현재 세션이 있으면 그대로 반환(fabric 전달 시 갱신)
   * - 확정 세션만 있으면 신규 selection_version_no로 선택값을 복사해 생성
   * - 세션이 없으면 품목 카테고리의 ACTIVE 버전으로 신규 생성
   */
  async start(orderItemId: string, dto: StartOptionSessionDto, actor: AuthUser) {
    const item = await this.prisma.orderItem.findUnique({ where: { id: orderItemId } });
    if (!item) throw new NotFoundException('주문 품목이 없습니다.');

    const sessions = await this.prisma.optionSelectionSession.findMany({
      where: { orderItemId },
      orderBy: { selectionVersionNo: 'desc' },
    });
    const current = sessions.find((s) => s.isCurrent);

    if (current && current.status !== 'CONFIRMED') {
      if (dto.fabric !== undefined && dto.fabric !== current.fabricName) {
        await this.prisma.optionSelectionSession.update({
          where: { id: current.id },
          data: { fabricName: dto.fabric, rowVersion: { increment: 1 } },
        });
      }
      return this.detail(current.id);
    }

    if (!current) {
      const set = await this.prisma.optionSet.findUnique({
        where: { productCategory: item.productCategory },
      });
      if (!set?.activeVersionId)
        throw new BusinessException(
          'OPTION_SET_INVALID',
          `${item.productCategory} 품목에 활성화된 옵션 버전이 없습니다.`,
        );
      const activeVersionId = set.activeVersionId;
      const created = await this.prisma.$transaction(async (tx) => {
        await tx.optionSelectionSession.updateMany({
          where: { orderItemId, isCurrent: true },
          data: { isCurrent: false },
        });
        return tx.optionSelectionSession.create({
          data: {
            id: randomUUID(),
            orderItemId,
            optionSetVersionId: activeVersionId,
            selectionVersionNo: (sessions[0]?.selectionVersionNo ?? 0) + 1,
            status: 'NOT_STARTED',
            fabricName: dto.fabric ?? null,
            isCurrent: true,
          },
        });
      });
      return this.detail(created.id);
    }

    // 확정 세션 재편집: 확정 세션을 복사한 신규 선택 버전 (설계서 §8.5 CONFIRMED → 편집 재개)
    //
    // 새 선택 라운드는 현재 ACTIVE 옵션 버전으로 진행한다. 확정본은 그대로 남으니
    // 이전 버전을 붙들고 있을 이유가 없고, 그러면 마스터를 새로 활성화해도 재선택
    // 화면에 옛 단계·사진이 계속 나온다.
    // 단, 옵션 버전이 바뀌면 단계 구성이 달라 선택값을 옮길 수 없으므로 복사하지 않는다.
    const set = await this.prisma.optionSet.findUnique({
      where: { productCategory: item.productCategory },
    });
    const targetVersionId = set?.activeVersionId ?? current.optionSetVersionId;
    const versionChanged = targetVersionId !== current.optionSetVersionId;

    const created = await this.prisma.$transaction(async (tx) => {
      const values = versionChanged
        ? []
        : await tx.optionSelectionValue.findMany({ where: { selectionSessionId: current.id } });
      const stages = await tx.optionStage.findMany({
        where: { optionSetVersionId: targetVersionId, active: true },
        orderBy: { sequenceNo: 'asc' },
      });
      const selectedStageIds = new Set(values.map((v) => v.optionStageId));
      const complete = stages.length > 0 && stages.every((s) => selectedStageIds.has(s.id));
      const now = new Date();

      await tx.optionSelectionSession.updateMany({
        where: { orderItemId, isCurrent: true },
        data: { isCurrent: false },
      });
      const session = await tx.optionSelectionSession.create({
        data: {
          id: randomUUID(),
          orderItemId,
          optionSetVersionId: targetVersionId,
          selectionVersionNo: (sessions[0]?.selectionVersionNo ?? 0) + 1,
          status: values.length === 0 ? 'NOT_STARTED' : complete ? 'REVIEW' : 'IN_PROGRESS',
          currentStageId: stages.find((s) => !selectedStageIds.has(s.id))?.id ?? null,
          fabricName: dto.fabric ?? current.fabricName,
          startedAt: values.length > 0 ? now : null,
          lastSavedAt: values.length > 0 ? now : null,
          reviewedAt: complete ? now : null,
          // 계약금액 반영 누계는 이어받는다. 새 세션에서 0으로 시작하면
          // 이미 반영한 추가금액을 다시 더하게 된다.
          surchargeApplied: current.surchargeApplied,
          surchargeAppliedAt: current.surchargeAppliedAt,
          isCurrent: true,
        },
      });
      if (values.length > 0) {
        await tx.optionSelectionValue.createMany({
          data: values.map((v) => ({
            id: randomUUID(),
            selectionSessionId: session.id,
            optionStageId: v.optionStageId,
            optionChoiceId: v.optionChoiceId,
            extraPriceSnapshot: v.extraPriceSnapshot,
            selectedBy: actor.id,
          })),
        });
      }
      return session;
    });
    return this.detail(created.id);
  }

  /**
   * GET /order-items/option-progress — 맞춤 품목별 옵션 진행 현황 (연동정합화 계약 §6)
   * 취소 품목은 제외한다. 세션이 없는 품목은 NOT_STARTED로, totalStages는 해당
   * 카테고리의 ACTIVE 옵션 버전 단계 수를 사용한다(활성 버전이 없으면 0).
   */
  async progress(contractId?: string) {
    const [items, optionSets] = await Promise.all([
      this.prisma.orderItem.findMany({
        where: {
          status: { not: 'CANCELLED' },
          order: { transactionType: 'CUSTOM', ...(contractId ? { contractId } : {}) },
        },
        include: {
          order: {
            select: {
              orderNo: true,
              contractId: true,
              completionDueDate: true,
              contract: {
                select: {
                  contractNo: true,
                  customer: { select: { id: true, name: true, phone: true } },
                },
              },
            },
          },
          optionSelectionSessions: {
            where: { isCurrent: true },
            include: {
              values: { select: { optionStageId: true } },
              optionSetVersion: {
                select: { stages: { where: { active: true }, select: { id: true } } },
              },
            },
          },
        },
        orderBy: [{ createdAt: 'asc' }, { sequenceNo: 'asc' }],
      }),
      this.prisma.optionSet.findMany({
        select: {
          productCategory: true,
          activeVersion: {
            select: { stages: { where: { active: true }, select: { id: true } } },
          },
        },
      }),
    ]);
    const activeStageCount = new Map(
      optionSets.map((s) => [s.productCategory, s.activeVersion?.stages.length ?? 0]),
    );

    return items.map((item) => {
      const session = item.optionSelectionSessions[0];
      const activeStageIds = new Set(session?.optionSetVersion.stages.map((s) => s.id) ?? []);
      return {
        orderItemId: item.id,
        displayName: item.displayName,
        productCategory: item.productCategory,
        contractId: item.order.contractId,
        contractNo: item.order.contract.contractNo,
        customerId: item.order.contract.customer.id,
        customerName: item.order.contract.customer.name,
        customerPhone: item.order.contract.customer.phone,
        orderNo: item.order.orderNo,
        completionDueDate: item.order.completionDueDate?.toISOString() ?? null,
        fabric: session?.fabricName ?? null,
        status: session?.status ?? 'NOT_STARTED',
        completedStages: session
          ? session.values.filter((v) => activeStageIds.has(v.optionStageId)).length
          : 0,
        totalStages: session
          ? activeStageIds.size
          : (activeStageCount.get(item.productCategory) ?? 0),
        sessionId: session?.id ?? null,
      };
    });
  }

  /**
   * GET /order-items/:id/option-session — 품목의 현재(is_current) 세션 상세.
   * 세션이 없으면 { session: null }을 반환한다.
   */
  async currentSession(orderItemId: string) {
    const item = await this.prisma.orderItem.findUnique({ where: { id: orderItemId } });
    if (!item) throw new NotFoundException('주문 품목이 없습니다.');

    const current = await this.prisma.optionSelectionSession.findFirst({
      where: { orderItemId, isCurrent: true },
      select: { id: true },
    });
    if (!current) return { session: null };

    const [detail, resume] = await Promise.all([this.detail(current.id), this.resume(current.id)]);
    return { session: { ...detail, resumeStageId: resume.resumeStageId } };
  }

  /** GET /option-sessions/:id — 단계·선택지·현재 선택값 포함 상세 */
  async detail(sessionId: string) {
    const session = await this.load(sessionId);
    const activeStages = this.activeStages(session);
    const valueByStage = new Map(session.values.map((v) => [v.optionStageId, v]));
    return {
      sessionId: session.id,
      orderItemId: session.orderItemId,
      orderItemName: session.orderItem.displayName,
      displayName: session.orderItem.displayName,
      productCategory: session.orderItem.productCategory,
      orderNo: session.orderItem.order.orderNo,
      customerId: session.orderItem.order.contract.customer.id,
      customerName: session.orderItem.order.contract.customer.name,
      optionSetName: session.optionSetVersion.optionSet.name,
      optionSetVersionNo: session.optionSetVersion.versionNo,
      optionSetVersion: {
        id: session.optionSetVersion.id,
        versionNo: session.optionSetVersion.versionNo,
        status: session.optionSetVersion.status,
      },
      selectionVersionNo: session.selectionVersionNo,
      status: session.status,
      currentStageId: session.currentStageId,
      fabricName: session.fabricName,
      startedAt: session.startedAt,
      lastSavedAt: session.lastSavedAt,
      reviewedAt: session.reviewedAt,
      confirmedAt: session.confirmedAt,
      isCurrent: session.isCurrent,
      version: session.rowVersion,
      totalStages: activeStages.length,
      completedStages: activeStages.filter((s) => valueByStage.has(s.id)).length,
      stages: activeStages.map((s) => ({
        stageId: s.id,
        stageCode: s.stageCode,
        stageName: s.stageName,
        sequenceNo: s.sequenceNo,
        required: s.required,
        choices: s.choices
          .filter((c) => c.active)
          .map((c) => ({ ...c, extraPrice: Number(c.extraPrice) })),
        selectedChoiceId: valueByStage.get(s.id)?.optionChoiceId ?? null,
      })),
      surchargeTotal: this.surchargeTotal(session),
      surchargeApplied: Number(session.surchargeApplied),
    };
  }

  /** GET /option-sessions/:id/resume — 중단 지점 (미완료 첫 단계 또는 저장된 current_stage_id) */
  async resume(sessionId: string) {
    const session = await this.load(sessionId);
    const activeStages = this.activeStages(session);
    const selected = new Set(session.values.map((v) => v.optionStageId));
    const firstIncomplete = activeStages.find((s) => !selected.has(s.id));
    const resumeStageId =
      session.status === 'CONFIRMED'
        ? null
        : (session.currentStageId ?? firstIncomplete?.id ?? activeStages[0]?.id ?? null);
    return {
      sessionId: session.id,
      orderItemId: session.orderItemId,
      status: session.status,
      resumeStageId,
      currentStageId: session.currentStageId,
      completedStages: activeStages.filter((s) => selected.has(s.id)).length,
      totalStages: activeStages.length,
      lastSavedAt: session.lastSavedAt,
      version: session.rowVersion,
    };
  }

  /** PUT /option-sessions/:id/stages/:stageId — A/B 선택 UPSERT (화면·API 정의서 §14.2) */
  async saveStage(sessionId: string, stageId: string, dto: SaveStageSelectionDto, actor: AuthUser) {
    const session = await this.load(sessionId);
    this.ensureEditable(session);
    this.ensureVersion(session, dto.version);

    const activeStages = this.activeStages(session);
    const stage = activeStages.find((s) => s.id === stageId);
    if (!stage)
      throw new BusinessException('VALIDATION_ERROR', '세션의 옵션 버전에 없는 단계입니다.', [
        { field: 'stageId', reason: 'STAGE_NOT_IN_VERSION' },
      ]);
    const choice = stage.choices.find((c) => c.id === dto.choiceId && c.active);
    if (!choice)
      throw new BusinessException('VALIDATION_ERROR', '해당 단계의 선택지가 아닙니다.', [
        { field: 'choiceId', reason: 'CHOICE_NOT_IN_STAGE' },
      ]);

    const selected = new Set(session.values.map((v) => v.optionStageId));
    selected.add(stageId);
    const completedStages = activeStages.filter((s) => selected.has(s.id)).length;
    const allDone = completedStages === activeStages.length;
    const nextStage = activeStages.find((s) => s.sequenceNo > stage.sequenceNo);
    const now = new Date();
    const newStatus = allDone ? 'REVIEW' : 'IN_PROGRESS';

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.optionSelectionValue.upsert({
        where: {
          selectionSessionId_optionStageId: {
            selectionSessionId: sessionId,
            optionStageId: stageId,
          },
        },
        create: {
          id: randomUUID(),
          selectionSessionId: sessionId,
          optionStageId: stageId,
          optionChoiceId: choice.id,
          extraPriceSnapshot: choice.extraPrice,
          selectedBy: actor.id,
        },
        update: {
          optionChoiceId: choice.id,
          extraPriceSnapshot: choice.extraPrice,
          selectedBy: actor.id,
          selectedAt: now,
        },
      });
      return tx.optionSelectionSession.update({
        where: { id: sessionId },
        data: {
          status: newStatus,
          currentStageId: nextStage?.id ?? stage.id,
          startedAt: session.startedAt ?? now,
          lastSavedAt: now,
          reviewedAt: newStatus === 'REVIEW' ? (session.reviewedAt ?? now) : session.reviewedAt,
          rowVersion: { increment: 1 },
        },
      });
    });

    return {
      sessionId: session.id,
      status: updated.status,
      savedStageId: stageId,
      savedChoiceId: choice.id,
      nextStageId: nextStage?.id ?? null,
      completedStages,
      totalStages: activeStages.length,
      version: updated.rowVersion,
    };
  }

  /** POST /option-sessions/:id/pause — 중단 저장 (current_stage_id·last_saved_at 갱신) */
  async pause(sessionId: string, dto: PauseSessionDto) {
    const session = await this.load(sessionId);
    this.ensureEditable(session);
    if (dto.version !== undefined) this.ensureVersion(session, dto.version);
    if (dto.currentStageId) {
      const stage = this.activeStages(session).find((s) => s.id === dto.currentStageId);
      if (!stage)
        throw new BusinessException('VALIDATION_ERROR', '세션의 옵션 버전에 없는 단계입니다.', [
          { field: 'currentStageId', reason: 'STAGE_NOT_IN_VERSION' },
        ]);
    }
    const updated = await this.prisma.optionSelectionSession.update({
      where: { id: sessionId },
      data: {
        ...(dto.currentStageId ? { currentStageId: dto.currentStageId } : {}),
        ...(dto.fabricName !== undefined ? { fabricName: dto.fabricName } : {}),
        lastSavedAt: new Date(),
        rowVersion: { increment: 1 },
      },
    });
    return {
      sessionId: updated.id,
      status: updated.status,
      currentStageId: updated.currentStageId,
      lastSavedAt: updated.lastSavedAt,
      version: updated.rowVersion,
    };
  }

  /** GET /option-sessions/:id/review — 전체 단계·선택·누락 목록 (확인서) */
  async review(sessionId: string) {
    const session = await this.load(sessionId);
    const activeStages = this.activeStages(session);
    const valueByStage = new Map(session.values.map((v) => [v.optionStageId, v]));
    const items = activeStages.map((s) => {
      const value = valueByStage.get(s.id);
      const choice = value ? s.choices.find((c) => c.id === value.optionChoiceId) : undefined;
      return {
        stageId: s.id,
        stageCode: s.stageCode,
        stageName: s.stageName,
        sequenceNo: s.sequenceNo,
        required: s.required,
        selected: choice
          ? {
              choiceId: choice.id,
              choiceCode: choice.choiceCode,
              choiceName: choice.choiceName,
              factoryLabel: choice.factoryLabel,
              imageFileId: choice.imageFileId,
              // 마스터 단가가 아니라 선택 시점 스냅샷을 보여준다.
              extraPrice: Number(value!.extraPriceSnapshot),
            }
          : null,
      };
    });
    const missing = items.filter((i) => !i.selected);
    return {
      sessionId: session.id,
      orderItemId: session.orderItemId,
      displayName: session.orderItem.displayName,
      customerName: session.orderItem.order.contract.customer.name,
      orderNo: session.orderItem.order.orderNo,
      optionSetName: session.optionSetVersion.optionSet.name,
      optionSetVersionNo: session.optionSetVersion.versionNo,
      status: session.status,
      fabricName: session.fabricName,
      totalStages: activeStages.length,
      completedStages: activeStages.length - missing.length,
      missingStages: missing.map((m) => ({
        stageId: m.stageId,
        stageName: m.stageName,
        required: m.required,
      })),
      stages: items,
      surcharge: await this.surchargeState(session),
      version: session.rowVersion,
    };
  }

  /**
   * GET /option-sessions/:id/surcharge — 옵션 추가금액과 계약금액 차액
   * 계약 버전은 올리지 않는다. 반영은 apply에서 현재 버전 금액을 제자리 수정한다.
   */
  async surcharge(sessionId: string) {
    return this.surchargeState(await this.load(sessionId));
  }

  /**
   * POST /option-sessions/:id/surcharge/apply — 미반영 차액을 계약 현재 버전 금액에 더한다.
   * - 확정(CONFIRMED) 세션만 반영할 수 있다(선택 중 금액이 흔들리지 않게).
   * - 변경계약(새 버전)이 아니라 현재 버전의 total/balance를 제자리 수정하고 감사로그를 남긴다.
   * - 재확정 시에는 (현재 합계 - 반영 누계)인 차액만 더하므로 여러 번 눌러도 중복되지 않는다.
   */
  async applySurcharge(sessionId: string, actor: AuthUser) {
    const session = await this.load(sessionId);
    if (session.status !== 'CONFIRMED')
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '확정된 옵션 선택만 계약금액에 반영할 수 있습니다.',
        undefined,
        { status: session.status },
      );

    const state = await this.surchargeState(session);
    if (!state.contract)
      throw new BusinessException('VALIDATION_ERROR', '계약의 현재 버전이 없어 반영할 수 없습니다.');
    if (state.pending === 0)
      throw new BusinessException('VALIDATION_ERROR', '반영할 차액이 없습니다.', undefined, {
        surchargeTotal: state.total,
        surchargeApplied: state.applied,
      });

    const versionId = session.orderItem.order.contract.currentVersionId!;
    const { pending } = state;
    const before = state.contract;

    await this.prisma.$transaction(async (tx) => {
      await tx.contractVersion.update({
        where: { id: versionId },
        data: {
          totalAmount: { increment: pending },
          balanceAmount: { increment: pending },
        },
      });
      await tx.optionSelectionSession.update({
        where: { id: sessionId },
        data: { surchargeApplied: state.total, surchargeAppliedAt: new Date() },
      });
      await this.audit.log(
        {
          userId: actor.id,
          action: 'UPDATE',
          entityType: 'CONTRACT_VERSION',
          entityId: versionId,
          before: { totalAmount: before.totalAmount, balanceAmount: before.balanceAmount },
          after: {
            totalAmount: before.totalAmount + pending,
            balanceAmount: before.balanceAmount + pending,
            optionSurcharge: pending,
            optionSessionId: sessionId,
            orderItemId: session.orderItemId,
          },
          reason: `옵션 추가금액 반영 (${session.orderItem.displayName})`,
        },
        tx,
      );
    });

    return this.surcharge(sessionId);
  }

  /** POST /option-sessions/:id/confirm — 서버 재검증 후 CONFIRMED (화면·API 정의서 §14.3) */
  async confirm(sessionId: string, dto: ConfirmSessionDto, actor: AuthUser) {
    const session = await this.load(sessionId);
    if (session.status === 'CONFIRMED')
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '이미 확정된 세션입니다. 재편집은 새 선택 버전으로 진행하세요.',
      );
    this.ensureVersion(session, dto.version);

    const activeStages = this.activeStages(session);
    const valueByStage = new Map(session.values.map((v) => [v.optionStageId, v]));

    // 필수 단계 누락 검증
    const missing = activeStages.filter((s) => s.required && !valueByStage.has(s.id));
    if (missing.length > 0)
      throw new BusinessException(
        'OPTION_STAGE_INCOMPLETE',
        '선택하지 않은 필수 단계가 있습니다.',
        missing.map((s) => ({ field: s.stageCode, reason: 'NOT_SELECTED' })),
        { missingStages: missing.map((s) => ({ stageId: s.id, stageName: s.stageName })) },
      );

    // 전체 선택 서버 재검증: 선택값의 choice가 해당 단계의 활성 선택지인지 확인
    const summary: Array<{ stageName: string; choiceName: string; factoryLabel: string | null }> = [];
    for (const stage of activeStages) {
      const value = valueByStage.get(stage.id);
      if (!value) continue;
      const choice = stage.choices.find((c) => c.id === value.optionChoiceId && c.active);
      if (!choice)
        throw new BusinessException(
          'OPTION_SET_INVALID',
          '선택값이 해당 단계의 선택지와 일치하지 않습니다.',
          [{ field: stage.stageCode, reason: 'CHOICE_STAGE_MISMATCH' }],
        );
      summary.push({
        stageName: stage.stageName,
        choiceName: choice.choiceName,
        factoryLabel: choice.factoryLabel,
      });
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const confirmed = await tx.optionSelectionSession.update({
        where: { id: sessionId },
        data: {
          status: 'CONFIRMED',
          reviewedAt: session.reviewedAt ?? now, // REVIEW 전이 자동 처리
          confirmedAt: now,
          ...(dto.fabricName !== undefined ? { fabricName: dto.fabricName } : {}),
          rowVersion: { increment: 1 },
        },
      });
      await this.audit.log(
        {
          userId: actor.id,
          action: 'CONFIRM',
          entityType: 'OPTION_SELECTION_SESSION',
          entityId: sessionId,
          before: { status: session.status, rowVersion: session.rowVersion },
          after: {
            status: 'CONFIRMED',
            selectionVersionNo: session.selectionVersionNo,
            orderItemId: session.orderItemId,
            optionSummary: summary,
          },
        },
        tx,
      );
      return confirmed;
    });

    return {
      sessionId: updated.id,
      status: updated.status,
      confirmedAt: updated.confirmedAt,
      optionSummary: summary.map((s) => ({ stageName: s.stageName, choiceName: s.choiceName })),
      // 확정 직후 계약금액 차액을 안내하기 위한 값. 반영은 별도 확인(apply)을 거친다.
      surcharge: await this.surcharge(sessionId),
      version: updated.rowVersion,
    };
  }

  /** POST /option-sessions/:id/copy — 동일 카테고리의 다른 품목으로 선택값 복사 */
  async copy(sessionId: string, dto: CopySessionDto, actor: AuthUser) {
    const source = await this.load(sessionId);
    const target = await this.prisma.orderItem.findUnique({
      where: { id: dto.targetOrderItemId },
    });
    if (!target) throw new NotFoundException('복사 대상 품목이 없습니다.');
    if (target.id === source.orderItemId)
      throw new BusinessException('VALIDATION_ERROR', '같은 품목으로는 복사할 수 없습니다.', [
        { field: 'targetOrderItemId', reason: 'SAME_ORDER_ITEM' },
      ]);
    if (target.productCategory !== source.orderItem.productCategory)
      throw new BusinessException(
        'VALIDATION_ERROR',
        '같은 품목 대분류로만 옵션을 복사할 수 있습니다.',
        [{ field: 'targetOrderItemId', reason: 'CATEGORY_MISMATCH' }],
        {
          sourceCategory: source.orderItem.productCategory,
          targetCategory: target.productCategory,
        },
      );

    const activeStages = this.activeStages(source);
    const selectedStageIds = new Set(source.values.map((v) => v.optionStageId));
    const complete =
      activeStages.length > 0 && activeStages.every((s) => selectedStageIds.has(s.id));
    const now = new Date();

    const created = await this.prisma.$transaction(async (tx) => {
      const last = await tx.optionSelectionSession.aggregate({
        where: { orderItemId: target.id },
        _max: { selectionVersionNo: true },
      });
      await tx.optionSelectionSession.updateMany({
        where: { orderItemId: target.id, isCurrent: true },
        data: { isCurrent: false },
      });
      const session = await tx.optionSelectionSession.create({
        data: {
          id: randomUUID(),
          orderItemId: target.id,
          optionSetVersionId: source.optionSetVersionId,
          selectionVersionNo: (last._max.selectionVersionNo ?? 0) + 1,
          status:
            source.values.length === 0 ? 'NOT_STARTED' : complete ? 'REVIEW' : 'IN_PROGRESS',
          currentStageId: activeStages.find((s) => !selectedStageIds.has(s.id))?.id ?? null,
          fabricName: source.fabricName,
          startedAt: source.values.length > 0 ? now : null,
          lastSavedAt: source.values.length > 0 ? now : null,
          reviewedAt: complete ? now : null,
          isCurrent: true,
        },
      });
      if (source.values.length > 0) {
        await tx.optionSelectionValue.createMany({
          data: source.values.map((v) => ({
            id: randomUUID(),
            selectionSessionId: session.id,
            optionStageId: v.optionStageId,
            optionChoiceId: v.optionChoiceId,
            extraPriceSnapshot: v.extraPriceSnapshot,
            selectedBy: actor.id,
          })),
        });
      }
      return session;
    });
    return this.detail(created.id);
  }

  // -------------------------------------------------------------------------

  private async load(sessionId: string): Promise<SessionWithDetail> {
    const session = await this.prisma.optionSelectionSession.findUnique({
      where: { id: sessionId },
      include: SESSION_INCLUDE,
    });
    if (!session) throw new NotFoundException('옵션 선택 세션이 없습니다.');
    return session;
  }

  private activeStages(session: SessionWithDetail) {
    return session.optionSetVersion.stages.filter((s) => s.active);
  }

  /** 선택값 스냅샷 기준 옵션 추가금액 합계 (활성 단계에 남아 있는 선택만 센다) */
  private surchargeTotal(session: SessionWithDetail): number {
    const activeStageIds = new Set(this.activeStages(session).map((s) => s.id));
    return session.values
      .filter((v) => activeStageIds.has(v.optionStageId))
      .reduce((sum, v) => sum + Number(v.extraPriceSnapshot), 0);
  }

  /** 옵션 추가금액 합계와 계약 현재 버전 금액을 견줘 미반영 차액을 계산한다. */
  private async surchargeState(session: SessionWithDetail) {
    const total = this.surchargeTotal(session);
    const applied = Number(session.surchargeApplied);
    const pending = total - applied;
    const { contract } = session.orderItem.order;

    const version = contract.currentVersionId
      ? await this.prisma.contractVersion.findUnique({
          where: { id: contract.currentVersionId },
          select: { versionNo: true, totalAmount: true, depositAmount: true, balanceAmount: true },
        })
      : null;

    return {
      sessionId: session.id,
      orderItemId: session.orderItemId,
      displayName: session.orderItem.displayName,
      status: session.status,
      /** 이 품목 옵션의 추가금액 합계 */
      total,
      /** 그중 계약금액에 이미 반영한 금액 */
      applied,
      /** 아직 반영하지 않은 차액 (이 금액만 반영된다) */
      pending,
      appliedAt: session.surchargeAppliedAt,
      /** 확정 세션만 반영할 수 있다 */
      appliable: session.status === 'CONFIRMED' && pending !== 0 && !!version,
      contract: version
        ? {
            contractId: contract.id,
            contractNo: contract.contractNo,
            versionNo: version.versionNo,
            totalAmount: Number(version.totalAmount),
            depositAmount: Number(version.depositAmount),
            balanceAmount: Number(version.balanceAmount),
            /** 반영했을 때의 금액 (미리보기) */
            afterTotalAmount: Number(version.totalAmount) + pending,
            afterBalanceAmount: Number(version.balanceAmount) + pending,
          }
        : null,
    };
  }

  private ensureEditable(session: SessionWithDetail): void {
    if (session.status === 'CONFIRMED')
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '확정된 세션은 수정할 수 없습니다. 재편집은 새 선택 버전으로 진행하세요.',
      );
  }

  /** row_version 낙관적 잠금 (구현표준 §1.5) */
  private ensureVersion(session: SessionWithDetail, version: number): void {
    if (session.rowVersion !== version)
      throw new BusinessException(
        'VERSION_CONFLICT',
        '다른 화면에서 세션이 먼저 수정되었습니다. 다시 조회해 주세요.',
        undefined,
        { currentVersion: session.rowVersion, requestedVersion: version },
      );
  }
}
