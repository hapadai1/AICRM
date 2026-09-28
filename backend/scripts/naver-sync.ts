/**
 * 네이버 예약을 기간을 지정해 CRM 에 적재한다 (실제 DB 반영).
 *
 * 주기 수집은 과거 2일~미래 7일만 보므로, 서버가 오래 꺼져 있었거나 과거 이력을 다시 채울 때 쓴다.
 * 같은 예약은 예약번호로 합쳐지므로 여러 번 돌려도 중복되지 않는다.
 *
 * 실행: cd backend && npx ts-node scripts/naver-sync.ts --back=30 --ahead=30
 * 주의: 주기 수집과 같은 크롬 프로필을 쓰므로, 서버의 수집이 도는 순간과 겹치면 실패한다
 *       (로그의 "다음 네이버 예약 수집" 시각을 피해서 실행).
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { AppointmentsService } from '../src/modules/appointments/appointments.service';
import { PrismaService } from '../src/prisma/prisma.service';

function arg(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const value = hit ? Number(hit.split('=')[1]) : fallback;
  if (!Number.isInteger(value) || value < 0 || value > 365) {
    throw new Error(`--${name} 는 0~365 사이 정수여야 한다`);
  }
  return value;
}

async function main(): Promise<void> {
  const window = { lookbackDays: arg('back', 2), lookaheadDays: arg('ahead', 7) };
  // 앱 컨텍스트가 뜨면 주기 수집 타이머도 걸리지만 첫 실행은 최소 2분 뒤이고, 끝날 때 닫으면서 해제된다
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
  try {
    const prisma = app.get(PrismaService);
    const admin = await prisma.user.findFirst({
      where: { status: 'ACTIVE', userRoles: { some: { role: { code: 'SUPER_ADMIN' } } } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, loginId: true, displayName: true },
    });
    if (!admin) throw new Error('감사 로그 주체로 쓸 SUPER_ADMIN 계정이 없다');

    Logger.log(`네이버 예약 적재 시작 — 과거 ${window.lookbackDays}일 ~ 미래 ${window.lookaheadDays}일`, 'naver-sync');
    // 명시적인 적재 명령이므로 저장본을 쓰지 않고 새로 수집한다
    const result = await app
      .get(AppointmentsService)
      .syncNaverReservations({ ...admin, permissions: [] }, window, { maxAgeMinutes: 0 });

    console.log('\n적재 결과');
    console.log(`  조회 ${result.fetched} / 신규 ${result.created} / 변경 ${result.updated} / 취소 ${result.cancelled}`);
    console.log(`  그대로 ${result.unchanged} / 충돌 ${result.conflicts} / 실패 ${result.failed}`);
    for (const f of result.failures) console.log(`  ✗ ${f.externalId}: ${f.reason}`);
  } finally {
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`\n❌ 실패: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
