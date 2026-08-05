import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { syncPrepStatuses } from '../production/prep-status';
import { anyInProduction } from '../production/production-status';
import { compareChoiceCodes } from './choice-codes';
import { componentGroupsFor } from './option-component-groups';
import {
  ConfirmSessionDto,
  CopySessionDto,
  PauseSessionDto,
  SaveComponentAttrDto,
  SaveStageSelectionDto,
  StartOptionSessionDto,
} from './options.dto';

const SESSION_INCLUDE = {
  contractItem: {
    select: {
      id: true,
      displayName: true,
      productCategory: true,
      // 부위(베스트 유무)가 이 품목의 단계 구성을 가른다 (현업 확정 2026-07-30).
      components: { select: { componentType: true, status: true } },
      // 제작 진행 중(제작요청 이후) 품목은 컨설팅을 잠근다 (현업 확정 2026-07-31).
      orderItems: { select: { status: true } },
      // 품목은 계약 소유다 → 계약번호·고객·금액 반영 대상 계약을 바로 되짚는다.
      contract: {
        select: {
          id: true,
          contractNo: true,
          // 컨설팅 수정은 계약 작성중(DRAFT)에서만 — 서명완료·계약완료는 잠근다 (현업 확정 2026-07-31).
          status: true,
          currentVersionId: true,
          customer: { select: { id: true, name: true } },
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
  componentAttrs: true,
} satisfies Prisma.OptionSelectionSessionInclude;

type SessionWithDetail = Prisma.OptionSelectionSessionGetPayload<{
  include: typeof SESSION_INCLUDE;
}>;

/**
 * 단계의 부위 그룹을 카테고리의 부위 슬롯 중 하나로 확정한다.
 * 셔츠·구두처럼 단일 부위 세트는 단계에 componentGroup이 없고(null), 정장도
 * 백필 이전 단계는 null일 수 있다 — 그대로 두면 어느 부위 행에도 안 잡혀
 * 화면에서 선택할 수 없게 되므로 대표 부위(첫 슬롯)로 귀속시킨다.
 */
function bucketGroup(stageGroup: string | null, groups: string[]): string | null {
  if (stageGroup && groups.includes(stageGroup)) return stageGroup;
  return groups[0] ?? null;
}

/** 품목에 베스트 부위가 살아 있는가 — 정장 3피스 여부 (현업 확정 2026-07-30). */
function vestActiveOf(components: Array<{ componentType: string; status: string }>): boolean {
  return components.some((c) => c.componentType === 'VEST' && c.status !== 'CANCELLED');
}

/** 베스트를 가질 수 있는 품목인가 — 정장뿐 (맞춤·렌탈 공통, 현업 확정 2026-08-01). */
function isSuit(productCategory: string): boolean {
  return productCategory === 'SUIT';
}

/**
 * 품목의 부위 슬롯 — 카테고리 상수에서 시작하되, 베스트는 품목의 VEST 부위가
 * 살아 있을 때만 낀다. 2피스 품목은 베스트 탭·단계가 아예 나오지 않는다.
 *
 * 컨설팅 목록만은 예외다(progressComponents) — 제외한 베스트도 행은 남겨야
 * [베스트 제외] 체크를 다시 풀 자리가 생긴다 (현업 확정 2026-08-01).
 */
function groupsOfItem(
  productCategory: string,
  components: Array<{ componentType: string; status: string }>,
): string[] {
  const vest = vestActiveOf(components);
  return componentGroupsFor(productCategory).filter((g) => g !== 'VEST' || vest);
}

/** 옵션 선택 세션: 시작·임시저장·재개·확인서·확정·복사 (설계서 §8.3~8.5, 데이터 규칙 §15.3) */
@Injectable()
export class OptionSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
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
    this.ensureContractDraft(item.contract);
    this.ensureItemNotInProduction(item.orderItems);

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
        await this.upsertComponentAttrs(this.prisma, current.id, dto.componentAttrs);
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
        await this.upsertComponentAttrs(this.prisma, created.id, dto.componentAttrs);
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
      await this.upsertComponentAttrs(this.prisma, created.id, dto.componentAttrs);
    return this.detail(created.id);
  }

  /**
   * GET /contract-items/option-progress — 맞춤 품목별 옵션 진행 현황 (연동정합화 계약 §6)
   * 컨설팅은 계약 품목(ContractItem)에 붙으므로 CUSTOM 품목을 대상으로 조회하되,
   * 그 계약 버전이 현재 버전인 계약(currentOfContracts)만 센다(옛 버전 품목 제외).
   * 취소 품목은 제외한다. 세션이 없는 품목은 NOT_STARTED로, totalStages는 해당
   * 카테고리의 ACTIVE 옵션 버전 단계 수를 사용한다(활성 버전이 없으면 0).
   */
  async progress(contractId?: string) {
    const [items, optionSets] = await Promise.all([
      this.prisma.contractItem.findMany({
        where: {
          status: { not: 'CANCELLED' },
          transactionType: 'CUSTOM',
          ...(contractId ? { contractId } : {}),
        },
        include: {
          contract: {
            select: {
              id: true,
              contractNo: true,
              // 계약 작성중이 아니면 컨설팅은 보기 전용 — 화면 잠금 판단용 (현업 확정 2026-07-31).
              status: true,
              // 목록의 계약일 기준 기간 검색용. 계약일은 계약완료 시점에 정해지므로
              // 그 전(작성중)에는 작성일로 대신 건다 — 계약 목록과 같은 규칙.
              contractedAt: true,
              createdAt: true,
              // 목록의 계약 구분 열 — 계약 목록과 같은 값을 보여준다.
              contractType: { select: { name: true } },
              customer: { select: { id: true, name: true, phone: true } },
              currentVersion: { select: { completionDueDate: true } },
            },
          },
          orderItems: { select: { status: true } },
          // 베스트 유무(부위)가 이 품목의 부위 행·단계 수를 가른다 (현업 확정 2026-07-30).
          components: { select: { componentType: true, status: true } },
          optionSelectionSessions: {
            where: { isCurrent: true },
            include: {
              values: { select: { optionStageId: true } },
              componentAttrs: true,
              optionSetVersion: {
                select: {
                  stages: {
                    where: { active: true },
                    select: { id: true, componentGroup: true },
                  },
                },
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
            select: {
              stages: { where: { active: true }, select: { id: true, componentGroup: true } },
            },
          },
        },
      }),
    ]);
    const activeStages = new Map(
      optionSets.map((s) => [s.productCategory, s.activeVersion?.stages ?? []]),
    );

    return items.map((item) => {
      const session = item.optionSelectionSessions[0];
      // 2피스(베스트 없는) 품목은 VEST 단계를 진행률 분모에서 뺀다.
      const vestActive = vestActiveOf(item.components);
      const activeStageIds = new Set(
        (session?.optionSetVersion.stages ?? [])
          .filter((s) => vestActive || s.componentGroup !== 'VEST')
          .map((s) => s.id),
      );
      const contract = item.contract;
      return {
        // 부위(상의/하의/베스트) 슬롯 — 목록을 부위 단위 행으로 펼치기 위한 축.
        // 세션이 없는 품목도 카테고리의 ACTIVE 버전 단계로 부위별 총 단계 수를 채운다.
        components: this.progressComponents(item, session, activeStages),
        contractItemId: item.id,
        displayName: item.displayName,
        productCategory: item.productCategory,
        contractId: contract.id,
        contractNo: contract.contractNo,
        contractTypeName: contract.contractType?.name ?? null,
        contractStatus: contract.status,
        // 계약일(미확정이면 null) + 작성일 — 목록의 기간 필터·표시가 둘을 함께 쓴다.
        contractedAt: contract.contractedAt?.toISOString() ?? null,
        contractCreatedAt: contract.createdAt.toISOString(),
        // 제작 진행 중(제작요청 이후) 품목은 계약이 작성중이어도 컨설팅을 잠근다.
        inProduction: anyInProduction(item.orderItems),
        customerId: contract.customer.id,
        customerName: contract.customer.name,
        customerPhone: contract.customer.phone,
        completionDueDate: contract.currentVersion?.completionDueDate?.toISOString() ?? null,
        fabric: session?.fabricName ?? null,
        status: session?.status ?? 'NOT_STARTED',
        completedStages: session
          ? session.values.filter((v) => activeStageIds.has(v.optionStageId)).length
          : 0,
        totalStages: session
          ? activeStageIds.size
          : (activeStages.get(item.productCategory) ?? []).filter(
              (s) => vestActive || s.componentGroup !== 'VEST',
            ).length,
        sessionId: session?.id ?? null,
      };
    });
  }

  /**
   * progress() 행의 부위별 슬롯 — 부위당 원단·컬러·패턴·비고 + 그 부위 단계의 진행 수.
   * 부위 슬롯은 카테고리 상수에서 출발하되, 베스트는 품목의 VEST 부위가 살아 있을 때만
   * 낀다(2026-07-30) — 2피스 품목은 목록에 상의/하의 두 줄만 나온다.
   */
  private progressComponents(
    item: { productCategory: string; components: { componentType: string; status: string }[] },
    session:
      | {
          values: { optionStageId: string }[];
          componentAttrs: {
            componentGroup: string;
            fabricName: string | null;
            colorName: string | null;
            patternName: string | null;
            notes: string | null;
          }[];
          optionSetVersion: { stages: { id: string; componentGroup: string | null }[] };
        }
      | undefined,
    activeStages: Map<string, { id: string; componentGroup: string | null }[]>,
  ) {
    // 컨설팅 목록은 제외한 베스트도 행으로 남긴다 — 체크를 다시 풀 자리가 있어야 한다
    // (현업 확정 2026-08-01). 단계 수는 아래 vestActive 로 0이 되어 진행률은 그대로다.
    const groups = componentGroupsFor(item.productCategory);
    if (groups.length === 0) return [];
    const vestActive = vestActiveOf(item.components);
    const stages = (
      session ? session.optionSetVersion.stages : (activeStages.get(item.productCategory) ?? [])
    ).filter((s) => vestActive || s.componentGroup !== 'VEST');
    const selected = new Set(session?.values.map((v) => v.optionStageId) ?? []);
    const attrByGroup = new Map((session?.componentAttrs ?? []).map((a) => [a.componentGroup, a]));

    return groups.map((group) => {
      const groupStages = stages.filter((s) => bucketGroup(s.componentGroup, groups) === group);
      const attr = attrByGroup.get(group);
      return {
        componentGroup: group,
        fabricName: attr?.fabricName ?? null,
        colorName: attr?.colorName ?? null,
        patternName: attr?.patternName ?? null,
        notes: attr?.notes ?? null,
        totalStages: groupStages.length,
        completedStages: groupStages.filter((s) => selected.has(s.id)).length,
        // 이 부위가 계약 품목에서 빠졌는가 — 베스트만 해당([베스트 제외] 체크 상태).
        excluded: group === 'VEST' && !vestActive,
      };
    });
  }

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
    const session = await this.load(sessionId);
    const activeStages = this.activeStages(session);
    const valueByStage = new Map(session.values.map((v) => [v.optionStageId, v]));
    const contract = this.contractOf(session);
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
      components: this.buildComponents(session),
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

  /** PUT /option-sessions/:id/stages/:stageId — A/B 선택 UPSERT (화면·API 정의서 §14.2) */
  async saveStage(sessionId: string, stageId: string, dto: SaveStageSelectionDto, actor: AuthUser) {
    const session = await this.load(sessionId);
    this.ensureContractDraft(this.contractOf(session));
    this.ensureItemNotInProduction(session.contractItem.orderItems);
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
    this.ensureContractDraft(this.contractOf(session));
    this.ensureItemNotInProduction(session.contractItem.orderItems);
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
      contractItemId: session.contractItemId,
      displayName: session.contractItem.displayName,
      customerName: this.contractOf(session)?.customer.name ?? null,
      optionSetName: session.optionSetVersion.optionSet.name,
      optionSetVersionNo: session.optionSetVersion.versionNo,
      status: session.status,
      // 컨설팅 편집 가능 = 계약 작성중 + 품목 미진행 (현업 확정 2026-07-31). 확인서의 확정·변경 버튼 판단용.
      contractStatus: this.contractOf(session)?.status ?? null,
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
      components: this.buildComponents(session),
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
    this.ensureContractDraft(this.contractOf(session));
    this.ensureItemNotInProduction(session.contractItem.orderItems);
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

    await this.prisma.$transaction(async (tx) => {
      await this.applyPendingTx(tx, session, state, actor);
    });

    return this.surcharge(sessionId);
  }

  /** 미반영 차액을 계약 현재 버전 금액에 제자리 반영하고 감사로그를 남긴다 (확정·수동 반영 공용). */
  private async applyPendingTx(
    tx: Prisma.TransactionClient,
    session: SessionWithDetail,
    state: Awaited<ReturnType<OptionSessionsService['surchargeState']>>,
    actor: AuthUser,
  ) {
    const versionId = this.contractOf(session)!.currentVersionId!;
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
    const session = await this.load(sessionId);
    this.ensureContractDraft(this.contractOf(session));
    this.ensureItemNotInProduction(session.contractItem.orderItems);
    if (session.status === 'CONFIRMED')
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '이미 확정된 세션입니다. 재편집은 새 선택 버전으로 진행하세요.',
      );
    this.ensureVersion(session, dto.version);

    const activeStages = this.activeStages(session);
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
    const state = await this.surchargeState(session);
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
            componentAttrs: this.buildComponents(session),
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
      surcharge: await this.surcharge(sessionId),
      version: updated.rowVersion,
    };
  }

  /** POST /option-sessions/:id/copy — 동일 카테고리의 다른 품목으로 선택값 복사 */
  async copy(sessionId: string, dto: CopySessionDto, actor: AuthUser) {
    const source = await this.load(sessionId);
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
    this.ensureContractDraft(target.contract);
    this.ensureItemNotInProduction(target.orderItems);
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
    return this.detail(created.id);
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
    const session = await this.load(sessionId);
    this.ensureContractDraft(this.contractOf(session));
    this.ensureItemNotInProduction(session.contractItem.orderItems);
    this.ensureEditable(session);
    this.ensureVersion(session, dto.version);

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
    const detail = await this.detail(sessionId);
    return {
      sessionId,
      componentGroup: group,
      component: detail.components.find((c) => c.componentGroup === group) ?? null,
      version: updated.rowVersion,
    };
  }

  // -------------------------------------------------------------------------

  /**
   * 세션이 붙은 계약 버전이 현재 버전인 계약(대개 1건)을 되짚는다.
   * 옛 버전 품목의 세션이면 없을 수 있어 null 반환.
   */
  private contractOf(session: SessionWithDetail) {
    return session.contractItem.contract ?? null;
  }

  /** 부위 슬롯(품목 기준 — 베스트는 살아 있을 때만) + 저장값을 병합한 components[] (설계서 04 §2.3) */
  private buildComponents(session: SessionWithDetail) {
    const groups = groupsOfItem(session.contractItem.productCategory, session.contractItem.components);
    const byGroup = new Map(session.componentAttrs.map((a) => [a.componentGroup, a]));
    return groups.map((group) => {
      const attr = byGroup.get(group);
      return {
        componentGroup: group,
        fabricName: attr?.fabricName ?? null,
        colorName: attr?.colorName ?? null,
        patternName: attr?.patternName ?? null,
        notes: attr?.notes ?? null,
      };
    });
  }

  /** 부위별 attr 배열 upsert (start body의 componentAttrs 처리) */
  private async upsertComponentAttrs(
    client: Pick<PrismaService, 'optionSelectionComponentAttr'>,
    sessionId: string,
    attrs: Array<{
      componentGroup: string;
      fabricName?: string;
      colorName?: string;
      patternName?: string;
      notes?: string;
    }>,
  ): Promise<void> {
    for (const a of attrs) {
      const data = {
        fabricName: a.fabricName ?? null,
        colorName: a.colorName ?? null,
        patternName: a.patternName ?? null,
        notes: a.notes ?? null,
      };
      await client.optionSelectionComponentAttr.upsert({
        where: {
          selectionSessionId_componentGroup: {
            selectionSessionId: sessionId,
            componentGroup: a.componentGroup,
          },
        },
        create: {
          id: randomUUID(),
          selectionSessionId: sessionId,
          componentGroup: a.componentGroup,
          ...data,
        },
        update: data,
      });
    }
  }

  private async load(sessionId: string): Promise<SessionWithDetail> {
    const session = await this.prisma.optionSelectionSession.findUnique({
      where: { id: sessionId },
      include: SESSION_INCLUDE,
    });
    if (!session) throw new NotFoundException('옵션 선택 세션이 없습니다.');
    return session;
  }

  private activeStages(session: SessionWithDetail) {
    // 베스트가 빠진 품목(2피스)은 VEST 단계를 아예 대상에서 뺀다 — 진행률·확정 검증·
    // 추가금액 합계가 전부 이 목록 기준이라, 여기 한 곳만 거르면 같이 맞는다.
    const vestActive = vestActiveOf(session.contractItem.components);
    return session.optionSetVersion.stages
      .filter((s) => s.active)
      .filter((s) => vestActive || s.componentGroup !== 'VEST')
      // DB의 사전순 정렬은 두 자리 코드에서 어긋난다(AA가 B보다 앞). 코드 순서로 되돌린다.
      .map((s) => ({
        ...s,
        choices: [...s.choices].sort((a, b) => compareChoiceCodes(a.choiceCode, b.choiceCode)),
      }));
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
    const contract = this.contractOf(session);

    const version = contract?.currentVersionId
      ? await this.prisma.contractVersion.findUnique({
          where: { id: contract.currentVersionId },
          select: { versionNo: true, totalAmount: true },
        })
      : null;

    return {
      sessionId: session.id,
      contractItemId: session.contractItemId,
      displayName: session.contractItem.displayName,
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
      contract: version && contract
        ? {
            contractId: contract.id,
            contractNo: contract.contractNo,
            versionNo: version.versionNo,
            totalAmount: Number(version.totalAmount),
            /** 반영했을 때의 금액 (미리보기) */
            afterTotalAmount: Number(version.totalAmount) + pending,
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

  /**
   * 컨설팅 수정은 계약 작성중(DRAFT)에서만 (현업 확정 2026-07-31).
   * 서명완료·계약완료 계약은 계약서 [수정하기]로 작성중으로 되돌린 뒤에만 컨설팅을 고친다
   * — 계약서·컨설팅·주문 전체 흐름을 계약 상태 하나로 잠그기 위해서다.
   */
  private ensureContractDraft(contract: { status: string } | null | undefined): void {
    if (contract && contract.status !== 'DRAFT')
      throw new BusinessException(
        'CONTRACT_NOT_DRAFT',
        '작성중인 계약에서만 스타일 컨설팅을 수정할 수 있습니다. 계약서 [수정하기]로 되돌린 뒤 진행해 주세요.',
        undefined,
        { contractStatus: contract.status },
      );
  }

  /**
   * 제작 진행 중(주문품목이 제작요청 이후) 품목의 컨설팅 편집을 막는다 (현업 확정 2026-07-31).
   * 공장에 나간 옷의 옵션이 바뀌면 작업지시서와 실물이 어긋난다. 되돌리려면
   * 제작·입출고 화면의 [되돌리기]로 품목 상태를 생성으로 되돌린 뒤 진행한다.
   */
  private ensureItemNotInProduction(orderItems: Array<{ status: string }>): void {
    const inProduction = anyInProduction(orderItems);
    if (inProduction)
      throw new BusinessException(
        'INVALID_STATUS_TRANSITION',
        '제작 진행 중인 품목은 옵션을 변경할 수 없습니다. 제작·입출고 화면에서 상태를 되돌린 뒤 진행해 주세요.',
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
