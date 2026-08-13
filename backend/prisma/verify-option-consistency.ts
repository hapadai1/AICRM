/**
 * 옵션 확정 정합성 검증 — "확정(CONFIRMED)인데 필수 단계 미충족" 세션이 하나라도 있으면 실패한다.
 *
 * 왜 필요한가: 정상 확정은 서비스의 confirm()을 거치며 "모든 활성 단계를 채워야 확정" 규칙이
 * 강제된다. 그러나 시드는 테이블에 직접 INSERT하므로 이 규칙이 적용되지 않아, 픽이 단계 수보다
 * 적은데 status='CONFIRMED'인 오염 세션이 태어날 수 있다(그러면 목록에서 "확정 완료"인데
 * 진행률이 100%가 아니게 된다). 이 스크립트는 소스(어느 시드/경로)와 무관하게 DB 전체를 훑어
 * 그런 세션을 잡아낸다. seed:all의 마지막 단계로 돌려 오염을 원천 차단한다.
 *
 * 필수 단계 판정은 앱과 동일하다: 활성 단계 중, 품목에 활성 VEST 부위가 없으면 VEST 단계를 뺀다.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface Violation {
  contractNo: string;
  item: string;
  have: number;
  required: number;
}

export async function findOptionConsistencyViolations(
  client: PrismaClient = prisma,
): Promise<Violation[]> {
  const sessions = await client.optionSelectionSession.findMany({
    where: { isCurrent: true, status: 'CONFIRMED' },
    select: {
      contractItem: {
        select: {
          displayName: true,
          contract: { select: { contractNo: true } },
          components: { select: { componentType: true, status: true } },
        },
      },
      optionSetVersion: {
        select: { stages: { where: { active: true }, select: { id: true, componentGroup: true } } },
      },
      values: { select: { optionStageId: true } },
    },
  });

  const violations: Violation[] = [];
  for (const s of sessions) {
    // 활성 VEST 부위가 있어야 VEST 단계가 필수가 된다(2피스 품목은 VEST 제외). 앱의 vestActiveOf와 동일.
    const vestActive = s.contractItem.components.some(
      (c) => c.componentType === 'VEST' && c.status !== 'CANCELLED',
    );
    const required = s.optionSetVersion.stages.filter(
      (st) => vestActive || st.componentGroup !== 'VEST',
    );
    const have = new Set(s.values.map((v) => v.optionStageId));
    const missing = required.filter((st) => !have.has(st.id));
    if (missing.length > 0) {
      violations.push({
        contractNo: s.contractItem.contract.contractNo,
        item: s.contractItem.displayName,
        have: required.length - missing.length,
        required: required.length,
      });
    }
  }
  return violations;
}

async function main(): Promise<void> {
  const violations = await findOptionConsistencyViolations();
  if (violations.length > 0) {
    console.error(`[verify] 확정인데 단계 미충족 세션 ${violations.length}건:`);
    for (const v of violations) {
      console.error(`  - ${v.contractNo} / ${v.item}: ${v.have}/${v.required} 단계`);
    }
    throw new Error(`옵션 확정 정합성 위반 ${violations.length}건 — 시드/데이터를 확인하세요.`);
  }
  console.log('[verify] 옵션 확정 정합성 OK — 위반 없음');
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
