import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { anyInProduction } from '../production/production-status';
import { compareChoiceCodes } from './choice-codes';
import { componentGroupsFor } from './option-component-groups';

/**
 * 옵션 선택 세션 공용 헬퍼 (2026-08-05 option-sessions.service에서 분리).
 * 목록(progress)·조회(query)·편집(sessions) 서비스가 함께 쓰는 세션 모양·판정·가드만 둔다.
 */

export const SESSION_INCLUDE = {
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

export type SessionWithDetail = Prisma.OptionSelectionSessionGetPayload<{
  include: typeof SESSION_INCLUDE;
}>;

/**
 * 단계의 부위 그룹을 카테고리의 부위 슬롯 중 하나로 확정한다.
 * 셔츠·구두처럼 단일 부위 세트는 단계에 componentGroup이 없고(null), 정장도
 * 백필 이전 단계는 null일 수 있다 — 그대로 두면 어느 부위 행에도 안 잡혀
 * 화면에서 선택할 수 없게 되므로 대표 부위(첫 슬롯)로 귀속시킨다.
 */
export function bucketGroup(stageGroup: string | null, groups: string[]): string | null {
  if (stageGroup && groups.includes(stageGroup)) return stageGroup;
  return groups[0] ?? null;
}

/** 품목에 베스트 부위가 살아 있는가 — 정장 3피스 여부 (현업 확정 2026-07-30). */
export function vestActiveOf(components: Array<{ componentType: string; status: string }>): boolean {
  return components.some((c) => c.componentType === 'VEST' && c.status !== 'CANCELLED');
}

/** 베스트를 가질 수 있는 품목인가 — 정장뿐 (맞춤·렌탈 공통, 현업 확정 2026-08-01). */
export function isSuit(productCategory: string): boolean {
  return productCategory === 'SUIT';
}

/**
 * 품목의 부위 슬롯 — 카테고리 상수에서 시작하되, 베스트는 품목의 VEST 부위가
 * 살아 있을 때만 낀다. 2피스 품목은 베스트 탭·단계가 아예 나오지 않는다.
 *
 * 컨설팅 목록만은 예외다(progressComponents) — 제외한 베스트도 행은 남겨야
 * [베스트 제외] 체크를 다시 풀 자리가 생긴다 (현업 확정 2026-08-01).
 */
export function groupsOfItem(
  productCategory: string,
  components: Array<{ componentType: string; status: string }>,
): string[] {
  const vest = vestActiveOf(components);
  return componentGroupsFor(productCategory).filter((g) => g !== 'VEST' || vest);
}

export async function loadSession(prisma: PrismaService, sessionId: string): Promise<SessionWithDetail> {
  const session = await prisma.optionSelectionSession.findUnique({
    where: { id: sessionId },
    include: SESSION_INCLUDE,
  });
  if (!session) throw new NotFoundException('옵션 선택 세션이 없습니다.');
  return session;
}

/**
 * 세션이 붙은 계약 버전이 현재 버전인 계약(대개 1건)을 되짚는다.
 * 옛 버전 품목의 세션이면 없을 수 있어 null 반환.
 */
export function contractOf(session: SessionWithDetail) {
  return session.contractItem.contract ?? null;
}

/** 부위 슬롯(품목 기준 — 베스트는 살아 있을 때만) + 저장값을 병합한 components[] (설계서 04 §2.3) */
export function buildComponents(session: SessionWithDetail) {
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

export function activeStagesOf(session: SessionWithDetail) {
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
export function surchargeTotalOf(session: SessionWithDetail): number {
  const activeStageIds = new Set(activeStagesOf(session).map((s) => s.id));
  return session.values
    .filter((v) => activeStageIds.has(v.optionStageId))
    .reduce((sum, v) => sum + Number(v.extraPriceSnapshot), 0);
}

export type SurchargeState = Awaited<ReturnType<typeof surchargeStateOf>>;

/** 옵션 추가금액 합계와 계약 현재 버전 금액을 견줘 미반영 차액을 계산한다. */
export async function surchargeStateOf(prisma: PrismaService, session: SessionWithDetail) {
  const total = surchargeTotalOf(session);
  const applied = Number(session.surchargeApplied);
  const pending = total - applied;
  const contract = contractOf(session);

  const version = contract?.currentVersionId
    ? await prisma.contractVersion.findUnique({
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

/** 부위별 attr 배열 upsert (start body의 componentAttrs 처리) */
export async function upsertComponentAttrs(
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

// ---------------------------------------------------------------------------
// 편집 가드 — 편집·확정 계열이 공유한다
// ---------------------------------------------------------------------------

export function ensureEditable(session: SessionWithDetail): void {
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
export function ensureContractDraft(contract: { status: string } | null | undefined): void {
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
export function ensureItemNotInProduction(orderItems: Array<{ status: string }>): void {
  if (anyInProduction(orderItems))
    throw new BusinessException(
      'INVALID_STATUS_TRANSITION',
      '제작 진행 중인 품목은 옵션을 변경할 수 없습니다. 제작·입출고 화면에서 상태를 되돌린 뒤 진행해 주세요.',
    );
}

/** row_version 낙관적 잠금 (구현표준 §1.5) */
export function ensureVersion(session: SessionWithDetail, version: number): void {
  if (session.rowVersion !== version)
    throw new BusinessException(
      'VERSION_CONFLICT',
      '다른 화면에서 세션이 먼저 수정되었습니다. 다시 조회해 주세요.',
      undefined,
      { currentVersion: session.rowVersion, requestedVersion: version },
    );
}
