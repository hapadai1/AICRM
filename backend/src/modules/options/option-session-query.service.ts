import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { anyInProduction } from '../production/production-status';
import {
  activeStagesOf,
  buildComponents,
  bucketGroup,
  contractOf,
  groupsOfItem,
  isSuit,
  loadSession,
  surchargeStateOf,
  surchargeTotalOf,
  vestActiveOf,
} from './option-session.shared';

/**
 * 옵션 선택 세션 조회 (2026-08-05 option-sessions.service에서 분리).
 * 세션 상세·재개 지점·확인서·추가금액 상태 — 세션을 "읽어서 보여주는" 책임만 갖는다.
 */
@Injectable()
export class OptionSessionQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /contract-items/:id/option-session — 품목의 현재(is_current) 세션 상세.
   * 세션이 없으면 { session: null }을 반환한다.
   */
  async currentSession(contractItemId: string) {
    const item = await this.prisma.contractItem.findUnique({ where: { id: contractItemId } });
    if (!item) throw new NotFoundException('계약 품목이 없습니다.');

    const current = await this.prisma.optionSelectionSession.findFirst({
      where: { contractItemId, isCurrent: true },
      select: { id: true },
    });
    if (!current) return { session: null };

    const [detail, resume] = await Promise.all([this.detail(current.id), this.resume(current.id)]);
    return { session: { ...detail, resumeStageId: resume.resumeStageId } };
  }

  /** GET /option-sessions/:id — 단계·선택지·현재 선택값 포함 상세 */
  async detail(sessionId: string) {
    const session = await loadSession(this.prisma, sessionId);
    const activeStages = activeStagesOf(session);
    const valueByStage = new Map(session.values.map((v) => [v.optionStageId, v]));
    const contract = contractOf(session);
    return {
      sessionId: session.id,
      contractItemId: session.contractItemId,
      contractItemName: session.contractItem.displayName,
      displayName: session.contractItem.displayName,
      productCategory: session.contractItem.productCategory,
      customerId: contract?.customer.id ?? null,
      customerName: contract?.customer.name ?? null,
      optionSetName: session.optionSetVersion.optionSet.name,
      optionSetVersionNo: session.optionSetVersion.versionNo,
      optionSetVersion: {
        id: session.optionSetVersion.id,
        versionNo: session.optionSetVersion.versionNo,
        status: session.optionSetVersion.status,
      },
      selectionVersionNo: session.selectionVersionNo,
      status: session.status,
      // 컨설팅 편집 가능 = 계약 작성중 + 품목 미진행 (현업 확정 2026-07-31). 화면 잠금 판단용.
      contractStatus: contract?.status ?? null,
      inProduction: anyInProduction(session.contractItem.orderItems),
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
        // 부위(상의/하의/베스트) 축 — 화면이 부위별로 단계를 나눠 띄운다.
        componentGroup: bucketGroup(
          s.componentGroup,
          groupsOfItem(session.contractItem.productCategory, session.contractItem.components),
        ),
        choices: s.choices
          .filter((c) => c.active)
          .map((c) => ({ ...c, extraPrice: Number(c.extraPrice) })),
        selectedChoiceId: valueByStage.get(s.id)?.optionChoiceId ?? null,
      })),
      components: buildComponents(session),
      surchargeTotal: surchargeTotalOf(session),
      surchargeApplied: Number(session.surchargeApplied),
    };
  }

  /** GET /option-sessions/:id/resume — 중단 지점 (미완료 첫 단계 또는 저장된 current_stage_id) */
  async resume(sessionId: string) {
    const session = await loadSession(this.prisma, sessionId);
    const activeStages = activeStagesOf(session);
    const selected = new Set(session.values.map((v) => v.optionStageId));
    const firstIncomplete = activeStages.find((s) => !selected.has(s.id));
    const resumeStageId =
      session.status === 'CONFIRMED'
        ? null
        : (session.currentStageId ?? firstIncomplete?.id ?? activeStages[0]?.id ?? null);
    return {
      sessionId: session.id,
      contractItemId: session.contractItemId,
      status: session.status,
      resumeStageId,
      currentStageId: session.currentStageId,
      completedStages: activeStages.filter((s) => selected.has(s.id)).length,
      totalStages: activeStages.length,
      lastSavedAt: session.lastSavedAt,
      version: session.rowVersion,
    };
  }

  /** GET /option-sessions/:id/review — 전체 단계·선택·누락 목록 (확인서) */
  async review(sessionId: string) {
    const session = await loadSession(this.prisma, sessionId);
    const activeStages = activeStagesOf(session);
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
      contractItemId: session.contractItemId,
      displayName: session.contractItem.displayName,
      customerName: contractOf(session)?.customer.name ?? null,
      optionSetName: session.optionSetVersion.optionSet.name,
      optionSetVersionNo: session.optionSetVersion.versionNo,
      status: session.status,
      // 컨설팅 편집 가능 = 계약 작성중 + 품목 미진행 (현업 확정 2026-07-31). 확인서의 확정·변경 버튼 판단용.
      contractStatus: contractOf(session)?.status ?? null,
      inProduction: anyInProduction(session.contractItem.orderItems),
      fabricName: session.fabricName,
      // 이 벌에서 베스트를 뺐는가 — 확정 팝업의 "계약서 변경내용"에 함께 알린다.
      // 베스트 금액은 자동 차감하지 않으므로(값이 그때그때 다르다) 수기 조정을 안내한다.
      vestExcluded:
        isSuit(session.contractItem.productCategory) &&
        !vestActiveOf(session.contractItem.components),
      totalStages: activeStages.length,
      completedStages: activeStages.length - missing.length,
      missingStages: missing.map((m) => ({
        stageId: m.stageId,
        stageName: m.stageName,
        required: m.required,
      })),
      stages: items,
      components: buildComponents(session),
      surcharge: await surchargeStateOf(this.prisma, session),
      version: session.rowVersion,
    };
  }

  /**
   * GET /option-sessions/:id/surcharge — 옵션 추가금액과 계약금액 차액
   * 계약 버전은 올리지 않는다. 반영은 apply에서 현재 버전 금액을 제자리 수정한다.
   */
  async surcharge(sessionId: string) {
    return surchargeStateOf(this.prisma, await loadSession(this.prisma, sessionId));
  }
}
