import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ContractsService } from '../contracts/contracts.service';
import { syncPrepStatuses } from '../production/prep-status';
import { OptionSessionQueryService } from './option-session-query.service';
import {
  activeStagesOf,
  buildComponents,
  contractOf,
  ensureContractDraft,
  ensureEditable,
  ensureItemNotInProduction,
  ensureVersion,
  groupsOfItem,
  loadSession,
  SessionWithDetail,
  SurchargeState,
  surchargeStateOf,
  upsertComponentAttrs,
  vestActiveOf,
} from './option-session.shared';
import {
  ConfirmSessionDto,
  CopySessionDto,
  PauseSessionDto,
  SaveComponentAttrDto,
  SaveStageSelectionDto,
  StartOptionSessionDto,
} from './options.dto';

/**
 * 옵션 선택 세션 편집·확정 (설계서 §8.3~8.5, 데이터 규칙 §15.3).
 * 2026-08-05 분리: 목록은 OptionProgressService, 조회는 OptionSessionQueryService가 진다.
 */
@Injectable()
export class OptionSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly contracts: ContractsService,
    private readonly query: OptionSessionQueryService,
  ) {}

  /**
   * POST /contract-items/:id/option-sessions — body { fabric? }
   * - 미확정 현재 세션이 있으면 그대로 반환(fabric 전달 시 갱신)
   * - 확정 세션만 있으면 신규 selection_version_no로 선택값을 복사해 생성
   * - 세션이 없으면 품목 카테고리의 ACTIVE 버전으로 신규 생성
   */
  async start(contractItemId: string, dto: StartOptionSessionDto, actor: AuthUser) {
    const item = await this.prisma.contractItem.findUnique({
      where: { id: contractItemId },
      include: {
        components: { select: { componentType: true, status: true } },
        contract: { select: { status: true } },
        orderItems: { select: { status: true } },
      },
    });
    if (!item) throw new NotFoundException('계약 품목이 없습니다.');
    ensureContractDraft(item.contract);
    ensureItemNotInProduction(item.orderItems);

    const sessions = await this.prisma.optionSelectionSession.findMany({
      where: { contractItemId },
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
      if (dto.componentAttrs?.length)
        await upsertComponentAttrs(this.prisma, current.id, dto.componentAttrs);
      return this.query.detail(current.id);
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
          where: { contractItemId, isCurrent: true },
          data: { isCurrent: false },
        });
        return tx.optionSelectionSession.create({
          data: {
            id: randomUUID(),
            contractItemId,
            optionSetVersionId: activeVersionId,
            selectionVersionNo: (sessions[0]?.selectionVersionNo ?? 0) + 1,
            status: 'NOT_STARTED',
            fabricName: dto.fabric ?? null,
            isCurrent: true,
          },
        });
      });
      if (dto.componentAttrs?.length)
        await upsertComponentAttrs(this.prisma, created.id, dto.componentAttrs);
      return this.query.detail(created.id);
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
      const allStages = await tx.optionStage.findMany({
        where: { optionSetVersionId: targetVersionId, active: true },
        orderBy: { sequenceNo: 'asc' },
      });
      // 이 품목의 단계 구성 — 베스트 없는(2피스) 품목은 VEST 단계를 뺀다 (2026-07-30).
      const vestActive = vestActiveOf(item.components);
      const stages = allStages.filter((s) => vestActive || s.componentGroup !== 'VEST');
      const usableStageIds = new Set(stages.map((s) => s.id));
      const values = versionChanged
        ? []
        : (
            await tx.optionSelectionValue.findMany({ where: { selectionSessionId: current.id } })
          ).filter((v) => usableStageIds.has(v.optionStageId));
      const selectedStageIds = new Set(values.map((v) => v.optionStageId));
      const complete = stages.length > 0 && stages.every((s) => selectedStageIds.has(s.id));
      const now = new Date();

      await tx.optionSelectionSession.updateMany({
        where: { contractItemId, isCurrent: true },
        data: { isCurrent: false },
      });
      const session = await tx.optionSelectionSession.create({
        data: {
          id: randomUUID(),
          contractItemId,
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
      // 부위별 원단·컬러·패턴도 새 선택 라운드로 이어받는다 (베스트가 빠졌으면 그 부위는 제외).
      const attrs = (
        await tx.optionSelectionComponentAttr.findMany({
          where: { selectionSessionId: current.id },
        })
      ).filter((a) => vestActive || a.componentGroup !== 'VEST');
      if (attrs.length > 0) {
        await tx.optionSelectionComponentAttr.createMany({
          data: attrs.map((a) => ({
            id: randomUUID(),
            selectionSessionId: session.id,
            componentGroup: a.componentGroup,
            fabricName: a.fabricName,
            colorName: a.colorName,
            patternName: a.patternName,
            notes: a.notes,
          })),
        });
      }
      return session;
    });
    if (dto.componentAttrs?.length)
      await upsertComponentAttrs(this.prisma, created.id, dto.componentAttrs);
    return this.query.detail(created.id);
  }

  /** PUT /option-sessions/:id/stages/:stageId — A/B 선택 UPSERT (화면·API 정의서 §14.2) */
  async saveStage(sessionId: string, stageId: string, dto: SaveStageSelectionDto, actor: AuthUser) {
    const session = await loadSession(this.prisma, sessionId);
    ensureContractDraft(contractOf(session));
    ensureItemNotInProduction(session.contractItem.orderItems);
    ensureEditable(session);
    ensureVersion(session, dto.version);

    const activeStages = activeStagesOf(session);
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
    const session = await loadSession(this.prisma, sessionId);
    ensureContractDraft(contractOf(session));
    ensureItemNotInProduction(session.contractItem.orderItems);
    ensureEditable(session);
    if (dto.version !== undefined) ensureVersion(session, dto.version);
    if (dto.currentStageId) {
      const stage = activeStagesOf(session).find((s) => s.id === dto.currentStageId);
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

  /**
   * POST /option-sessions/:id/surcharge/apply — 미반영 차액을 계약 현재 버전 금액에 더한다.
   * - 확정(CONFIRMED) 세션만 반영할 수 있다(선택 중 금액이 흔들리지 않게).
   * - 변경계약(새 버전)이 아니라 현재 버전의 total/balance를 제자리 수정하고 감사로그를 남긴다.
   * - 재확정 시에는 (현재 합계 - 반영 누계)인 차액만 더하므로 여러 번 눌러도 중복되지 않는다.
   */
  async applySurcharge(sessionId: string, actor: AuthUser) {
    const session = await loadSession(this.prisma, sessionId);
    ensureContractDraft(contractOf(session));
    ensureItemNotInProduction(session.contractItem.orderItems);
    if (session.status !== 'CONFIRMED')
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '확정된 옵션 선택만 계약금액에 반영할 수 있습니다.',
        undefined,
        { status: session.status },
      );

    const state = await surchargeStateOf(this.prisma, session);
    if (!state.contract)
      throw new BusinessException('VALIDATION_ERROR', '계약의 현재 버전이 없어 반영할 수 없습니다.');
    if (state.pending === 0)
      throw new BusinessException('VALIDATION_ERROR', '반영할 차액이 없습니다.', undefined, {
        surchargeTotal: state.total,
        surchargeApplied: state.applied,
      });

    await this.prisma.$transaction(async (tx) => {
      await this.applyPendingTx(tx, session, state, actor);
    });

    return this.query.surcharge(sessionId);
  }

  /** 미반영 차액을 계약 현재 버전 금액에 제자리 반영하고 감사로그를 남긴다 (확정·수동 반영 공용). */
  private async applyPendingTx(
    tx: Prisma.TransactionClient,
    session: SessionWithDetail,
    state: SurchargeState,
    actor: AuthUser,
  ) {
    const versionId = contractOf(session)!.currentVersionId!;
    const { pending } = state;
    const before = state.contract!;

    await tx.contractVersion.update({
      where: { id: versionId },
      data: { totalAmount: { increment: pending } },
    });
    await tx.optionSelectionSession.update({
      where: { id: session.id },
      data: { surchargeApplied: state.total, surchargeAppliedAt: new Date() },
    });
    // 계약 금액에 더한 만큼 품목 맨 아래 '옵션(추가금액)' 롤업 라인도 갱신한다.
    // (surchargeApplied 반영 뒤에 불러 이 세션 몫까지 합계에 든다.)
    await this.contracts.syncOptionRollupLine(tx, contractOf(session)!.id, versionId);
    await this.audit.log(
      {
        userId: actor.id,
        action: 'UPDATE',
        entityType: 'CONTRACT_VERSION',
        entityId: versionId,
        before: { totalAmount: before.totalAmount },
        after: {
          totalAmount: before.totalAmount + pending,
          optionSurcharge: pending,
          optionSessionId: session.id,
          contractItemId: session.contractItemId,
        },
        reason: `옵션 추가금액 반영 (${session.contractItem.displayName})`,
      },
      tx,
    );
  }

  /** POST /option-sessions/:id/confirm — 서버 재검증 후 CONFIRMED (화면·API 정의서 §14.3) */
  async confirm(sessionId: string, dto: ConfirmSessionDto, actor: AuthUser) {
    const session = await loadSession(this.prisma, sessionId);
    ensureContractDraft(contractOf(session));
    ensureItemNotInProduction(session.contractItem.orderItems);
    if (session.status === 'CONFIRMED')
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '이미 확정된 세션입니다. 재편집은 새 선택 버전으로 진행하세요.',
      );
    ensureVersion(session, dto.version);

    const activeStages = activeStagesOf(session);
    const valueByStage = new Map(session.values.map((v) => [v.optionStageId, v]));

    // 단계 누락 검증 — 필수/선택 구분 없이 활성 단계는 모두 골라야 확정된다.
    const missing = activeStages.filter((s) => !valueByStage.has(s.id));
    if (missing.length > 0)
      throw new BusinessException(
        'OPTION_STAGE_INCOMPLETE',
        '선택하지 않은 단계가 있습니다. 모든 단계를 선택해야 확정할 수 있습니다.',
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
    // 확정과 계약금액 반영은 한 트랜잭션이다 (현업 확정 2026-07-31).
    // 확정된 세션에 미반영 차액이 남는 상태를 만들지 않는다.
    const state = await surchargeStateOf(this.prisma, session);
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
            contractItemId: session.contractItemId,
            optionSummary: summary,
            componentAttrs: buildComponents(session),
          },
        },
        tx,
      );
      if (state.pending !== 0 && state.contract)
        await this.applyPendingTx(tx, session, state, actor);
      // 옵션 확정은 준비가 한 칸 나아간 것이다 — 그 품목의 상태에 반영한다.
      const orderItems = await tx.orderItem.findMany({
        where: { sourceContractItemId: session.contractItemId },
        select: { id: true },
      });
      await syncPrepStatuses(tx, orderItems.map((o) => o.id), actor.id);
      return confirmed;
    });

    return {
      sessionId: updated.id,
      status: updated.status,
      confirmedAt: updated.confirmedAt,
      optionSummary: summary.map((s) => ({ stageName: s.stageName, choiceName: s.choiceName })),
      // 반영 결과 안내용 — 확정과 함께 반영되므로 정상 흐름에서 pending은 0이다.
      surcharge: await this.query.surcharge(sessionId),
      version: updated.rowVersion,
    };
  }

  /** POST /option-sessions/:id/copy — 동일 카테고리의 다른 품목으로 선택값 복사 */
  async copy(sessionId: string, dto: CopySessionDto, actor: AuthUser) {
    const source = await loadSession(this.prisma, sessionId);
    const target = await this.prisma.contractItem.findUnique({
      where: { id: dto.targetContractItemId },
      include: {
        contract: { select: { status: true } },
        orderItems: { select: { status: true } },
        // 대상의 베스트 유무에 따라 VEST 선택값 복사 여부를 가른다 (2026-07-30).
        components: { select: { componentType: true, status: true } },
      },
    });
    if (!target) throw new NotFoundException('복사 대상 품목이 없습니다.');
    ensureContractDraft(target.contract);
    ensureItemNotInProduction(target.orderItems);
    if (target.id === source.contractItemId)
      throw new BusinessException('VALIDATION_ERROR', '같은 품목으로는 복사할 수 없습니다.', [
        { field: 'targetContractItemId', reason: 'SAME_CONTRACT_ITEM' },
      ]);
    if (target.productCategory !== source.contractItem.productCategory)
      throw new BusinessException(
        'VALIDATION_ERROR',
        '같은 품목 대분류로만 옵션을 복사할 수 있습니다.',
        [{ field: 'targetContractItemId', reason: 'CATEGORY_MISMATCH' }],
        {
          sourceCategory: source.contractItem.productCategory,
          targetCategory: target.productCategory,
        },
      );

    // 복사본의 단계 구성은 '대상 품목'의 베스트 유무를 따른다 — 3피스→2피스 복사면
    // VEST 선택값을 버리고, 2피스→3피스 복사면 베스트 단계만 미완료로 남는다.
    const targetVestActive = vestActiveOf(target.components);
    const targetStages = source.optionSetVersion.stages
      .filter((s) => s.active)
      .filter((s) => targetVestActive || s.componentGroup !== 'VEST');
    const stageGroup = new Map(source.optionSetVersion.stages.map((s) => [s.id, s.componentGroup]));
    const copyValues = source.values.filter(
      (v) => targetVestActive || stageGroup.get(v.optionStageId) !== 'VEST',
    );
    const copyAttrs = source.componentAttrs.filter(
      (a) => targetVestActive || a.componentGroup !== 'VEST',
    );
    const selectedStageIds = new Set(copyValues.map((v) => v.optionStageId));
    const complete =
      targetStages.length > 0 && targetStages.every((s) => selectedStageIds.has(s.id));
    const now = new Date();

    const created = await this.prisma.$transaction(async (tx) => {
      const last = await tx.optionSelectionSession.aggregate({
        where: { contractItemId: target.id },
        _max: { selectionVersionNo: true },
      });
      await tx.optionSelectionSession.updateMany({
        where: { contractItemId: target.id, isCurrent: true },
        data: { isCurrent: false },
      });
      const session = await tx.optionSelectionSession.create({
        data: {
          id: randomUUID(),
          contractItemId: target.id,
          optionSetVersionId: source.optionSetVersionId,
          selectionVersionNo: (last._max.selectionVersionNo ?? 0) + 1,
          status:
            copyValues.length === 0 ? 'NOT_STARTED' : complete ? 'REVIEW' : 'IN_PROGRESS',
          currentStageId: targetStages.find((s) => !selectedStageIds.has(s.id))?.id ?? null,
          fabricName: source.fabricName,
          startedAt: copyValues.length > 0 ? now : null,
          lastSavedAt: copyValues.length > 0 ? now : null,
          reviewedAt: complete ? now : null,
          isCurrent: true,
        },
      });
      if (copyValues.length > 0) {
        await tx.optionSelectionValue.createMany({
          data: copyValues.map((v) => ({
            id: randomUUID(),
            selectionSessionId: session.id,
            optionStageId: v.optionStageId,
            optionChoiceId: v.optionChoiceId,
            extraPriceSnapshot: v.extraPriceSnapshot,
            selectedBy: actor.id,
          })),
        });
      }
      // 부위별 원단·컬러·패턴도 함께 복사한다.
      if (copyAttrs.length > 0) {
        await tx.optionSelectionComponentAttr.createMany({
          data: copyAttrs.map((a) => ({
            id: randomUUID(),
            selectionSessionId: session.id,
            componentGroup: a.componentGroup,
            fabricName: a.fabricName,
            colorName: a.colorName,
            patternName: a.patternName,
            notes: a.notes,
          })),
        });
      }
      return session;
    });
    return this.query.detail(created.id);
  }

  /**
   * PUT /option-sessions/:id/component-attrs/:group — 부위별 원단·컬러·패턴·비고 upsert.
   * ensureEditable(CONFIRMED 불가) + 낙관적 잠금(rowVersion) 재사용. 세션 lastSavedAt·rowVersion 증가.
   */
  async saveComponentAttr(
    sessionId: string,
    group: string,
    dto: SaveComponentAttrDto,
    _actor: AuthUser,
  ) {
    const session = await loadSession(this.prisma, sessionId);
    ensureContractDraft(contractOf(session));
    ensureItemNotInProduction(session.contractItem.orderItems);
    ensureEditable(session);
    ensureVersion(session, dto.version);

    const validGroups = groupsOfItem(
      session.contractItem.productCategory,
      session.contractItem.components,
    );
    if (!validGroups.includes(group))
      throw new BusinessException(
        'VALIDATION_ERROR',
        '이 품목에 해당하지 않는 부위입니다.',
        [{ field: 'group', reason: 'INVALID_COMPONENT_GROUP' }],
        { productCategory: session.contractItem.productCategory, validGroups },
      );

    const attrData = {
      fabricName: dto.fabricName ?? null,
      colorName: dto.colorName ?? null,
      patternName: dto.patternName ?? null,
      notes: dto.notes ?? null,
    };
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.optionSelectionComponentAttr.upsert({
        where: {
          selectionSessionId_componentGroup: {
            selectionSessionId: sessionId,
            componentGroup: group,
          },
        },
        create: { id: randomUUID(), selectionSessionId: sessionId, componentGroup: group, ...attrData },
        update: attrData,
      });
      return tx.optionSelectionSession.update({
        where: { id: sessionId },
        data: { lastSavedAt: now, rowVersion: { increment: 1 } },
      });
    });
    const detail = await this.query.detail(sessionId);
    return {
      sessionId,
      componentGroup: group,
      component: detail.components.find((c) => c.componentGroup === group) ?? null,
      version: updated.rowVersion,
    };
  }
}
