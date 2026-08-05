import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { anyInProduction } from '../production/production-status';
import { componentGroupsFor } from './option-component-groups';
import { bucketGroup, vestActiveOf } from './option-session.shared';

/**
 * 옵션 진행 목록 (2026-08-05 option-sessions.service에서 분리).
 * 스타일 컨설팅 목록 화면의 품목별 진행 현황 — 세션 편집과 달리 계약 품목 전체를 훑는 축이다.
 */
@Injectable()
export class OptionProgressService {
  constructor(private readonly prisma: PrismaService) {}

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
}
