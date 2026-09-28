/**
 * 네이버 예약 수집본 점검 — DB 에는 아무것도 쓰지 않는다.
 *
 * 기본은 저장된 수집본(docs/naver-booking/latest.json)만 읽는다. 네이버에 접속하지 않는다.
 * "이 예약이 왜 안 보이지" 같은 확인은 이걸로 한다.
 *
 * 실행: cd backend && npx ts-node scripts/naver-check.ts [--all] [--find=이름또는예약번호]
 *
 * --live 를 붙였을 때만 네이버에 새로 접속해 수집하고 저장본을 갱신한다.
 * 세션이 끊겨 있으면 자동 로그인까지 시도하므로 세션을 되살리는 용도로도 쓴다.
 *   npx ts-node scripts/naver-check.ts --live [--back=30 --ahead=30]
 *   창을 띄워 보려면 앞에 NAVER_BOOKING_HEADLESS=false
 */
import { ConfigService } from '@nestjs/config';
import { config as loadEnv } from 'dotenv';
import { join } from 'path';
import { NaverBookingAdapter } from '../src/modules/appointments/adapters/naver-booking.adapter';

loadEnv({ path: join(__dirname, '..', '.env') });
loadEnv({ path: join(__dirname, '..', '..', '.env') });

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main(): Promise<void> {
  const adapter = new NaverBookingAdapter(new ConfigService());
  const live = process.argv.includes('--live');
  const back = arg('back');
  const ahead = arg('ahead');
  const window =
    back !== undefined || ahead !== undefined
      ? { lookbackDays: Number(back ?? 2), lookaheadDays: Number(ahead ?? 7) }
      : undefined;

  const result = await adapter.fetchReservations(window, live ? { maxAgeMinutes: 0 } : { cacheOnly: true });
  const at = result.fetchedAt ? new Date(result.fetchedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '없음';
  console.log(`\n${result.fromCache ? '저장본' : '새로 수집'} — 수집 시각 ${at}, ${result.records.length}건`);
  if (result.fromCache && !result.fetchedAt) {
    console.log('저장된 수집본이 없다. 주기 수집이 한 번 돌거나 --live 로 수집해야 한다.');
    return;
  }

  const find = arg('find');
  const records = find
    ? result.records.filter((r) => r.customerName.includes(find) || r.externalId === find)
    : result.records;
  const mask = (s: string) => (find ? s : s.length > 1 ? s[0] + '*'.repeat(s.length - 1) : s);
  const showAll = process.argv.includes('--all') || !!find;
  const kst = (iso?: string) => (iso ? new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-');
  for (const r of showAll ? records : records.slice(0, 10)) {
    console.log(
      `  ${r.externalId}  ${r.status.padEnd(9)} ${(r.bizItemName ?? r.purposeCode).padEnd(8)} ` +
        `${kst(r.scheduledStart)}  ${mask(r.customerName)}  네이버 변경 ${kst(r.naverUpdatedAt)}` +
        `${r.notes ? '  [메모]' : ''}`,
    );
  }
  if (!showAll && records.length > 10) console.log(`  … 외 ${records.length - 10}건 (--all 로 전체)`);
  if (find && records.length === 0) console.log(`  "${find}" 에 해당하는 예약이 수집본에 없다`);

  const byStatus = records.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`상태 분포: ${JSON.stringify(byStatus)}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`\n❌ 실패: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
