/**
 * 미확정 옵션 선택 세션을 각 품목의 현재 ACTIVE 옵션 버전으로 옮긴다.
 *
 * 옵션 마스터를 새 버전으로 활성화해도 이미 만들어진 세션은 예전 버전을 계속 참조한다.
 * 확정본은 작업지시서의 근거라 그대로 둬야 하지만, 아직 진행 중인 세션까지 옛 단계·사진을
 * 보여줄 이유는 없다.
 *
 * - CONFIRMED 세션은 건드리지 않는다.
 * - 옵션 버전이 바뀌면 단계 구성이 달라 선택값을 옮길 수 없으므로 지운다(다시 고른다).
 * - 실행: npm run migrate:option-sessions        (무엇이 바뀔지 보여주기만 함)
 *         APPLY=1 npm run migrate:option-sessions (실제 반영)
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const apply = process.env.APPLY === '1';

  const sets = await prisma.optionSet.findMany({
    where: { activeVersionId: { not: null } },
    select: { productCategory: true, activeVersionId: true },
  });
  const activeByCategory = new Map(sets.map((s) => [s.productCategory, s.activeVersionId!]));

  const sessions = await prisma.optionSelectionSession.findMany({
    where: { status: { not: 'CONFIRMED' } },
    select: {
      id: true,
      status: true,
      optionSetVersionId: true,
      orderItem: { select: { displayName: true, productCategory: true } },
      optionSetVersion: { select: { versionNo: true } },
      _count: { select: { values: true } },
    },
  });

  const targets = sessions.filter((s) => {
    const active = activeByCategory.get(s.orderItem.productCategory);
    return active && active !== s.optionSetVersionId;
  });

  if (targets.length === 0) {
    console.log('옮길 세션이 없습니다. 미확정 세션은 모두 현재 활성 버전을 쓰고 있습니다.');
    return;
  }

  console.log(`${apply ? '반영' : '미리보기'} — 대상 ${targets.length}건`);
  for (const s of targets) {
    console.log(
      `  ${s.orderItem.productCategory} ${s.orderItem.displayName} · ${s.status} · ` +
        `V${s.optionSetVersion.versionNo} → 활성 버전 (선택값 ${s._count.values}건 삭제)`,
    );
  }

  if (!apply) {
    console.log('\n실제로 반영하려면 APPLY=1 을 붙여 다시 실행하세요.');
    return;
  }

  for (const s of targets) {
    const target = activeByCategory.get(s.orderItem.productCategory)!;
    await prisma.$transaction(async (tx) => {
      await tx.optionSelectionValue.deleteMany({ where: { selectionSessionId: s.id } });
      await tx.optionSelectionSession.update({
        where: { id: s.id },
        data: {
          optionSetVersionId: target,
          status: 'NOT_STARTED',
          currentStageId: null,
          reviewedAt: null,
          rowVersion: { increment: 1 },
        },
      });
    });
  }
  console.log(`\n${targets.length}건을 현재 활성 버전으로 옮겼습니다.`);
}

main()
  .catch((error) => {
    console.error('세션 이전 실패:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
