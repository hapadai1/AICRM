/**
 * 네이버 예약 파트너센터 정찰 스크립트 (1회성, 사람 참여형)
 *
 * 목적: 예약 목록 화면이 내부적으로 호출하는 JSON API의 엔드포인트·응답 필드를
 * 실제로 캡처해서, NaverReservationAdapter 구현과 저장본 기반 테스트의 근거를 만든다.
 *
 * 왜 사람 참여형인가: 자동 로그인은 캡차를 유발하는 최대 위험 지점이다.
 * 첫 로그인은 사람이 실제 크롬 창에서 직접 하고(캡차·2단계인증 대응 가능),
 * 세션은 전용 프로필(.profile/)에 저장되어 이후 실행에서 재사용된다.
 *
 * 실행:
 *   1) cd ops/naver-recon && npm install   (최초 1회)
 *   2) node recon.mjs --doctor             (환경 점검: 크롬·.env 확인)
 *   3) node recon.mjs                      (크롬 창이 뜨면 직접 로그인)
 *      - 로그인 후 예약 목록이 보이면, 예약 1건 클릭·기간 변경 등 자유롭게 탐색
 *        (그동안 오가는 JSON이 전부 캡처된다)
 *      - 탐색을 마치면 이 터미널에서 Enter → HTML·스크린샷·요약 저장 후 종료
 *
 * 산출물: out/<타임스탬프>/
 *   - NNN_*.json     캡처된 JSON 응답 본문
 *   - index.json     요청 URL ↔ 파일 매핑 (메서드·상태코드 포함)
 *   - summary.md     엔드포인트별 호출 횟수 요약 (분석 시작점)
 *   - page.html      렌더된 예약 목록 HTML
 *   - page.png       전체 스크린샷
 *
 * 주의: out/ 과 .profile/ 은 예약 개인정보·세션 쿠키를 담으므로 gitignore 대상이다.
 * nid.naver.com(로그인) 응답은 자격증명 노출 방지를 위해 캡처하지 않는다.
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DOCTOR = process.argv.includes('--doctor');
// --auto: 이미 로그인된 세션(.profile)을 전제로, 사람 대기 없이 목록을 열어
// 자연스러운 대기·스크롤 후 캡처를 저장하고 스스로 종료한다. 조회(GET)만 발생한다.
const AUTO = process.argv.includes('--auto');

// ---------- .env 로드 (루트 .env, 외부 의존성 없이 단순 파싱) ----------
function loadEnv() {
  const path = join(ROOT, '.env');
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = loadEnv();
const BIZ_ID = env.NAVER_BOOKING_BIZ_ID ?? '1581427';
const LOOKBACK = Number(env.NAVER_BOOKING_LOOKBACK_DAYS ?? 2);
const LOOKAHEAD = Number(env.NAVER_BOOKING_LOOKAHEAD_DAYS ?? 7);

function ymd(d) {
  return d.toISOString().slice(0, 10);
}
const today = new Date();
const start = new Date(today.getTime() - LOOKBACK * 86400_000);
const end = new Date(today.getTime() + LOOKAHEAD * 86400_000);
const LIST_URL =
  `https://partner.booking.naver.com/bizes/${BIZ_ID}/booking-list-view` +
  `?dateDropdownType=WEEK&startDateTime=${ymd(start)}&endDateTime=${ymd(end)}&dateFilter=USEDATE`;

// ---------- 환경 점검 모드 ----------
if (DOCTOR) {
  const problems = [];
  if (!env.NAVER_BOOKING_BIZ_ID) problems.push('.env 에 NAVER_BOOKING_BIZ_ID 가 없다 (기본값 1581427 사용 예정)');
  if (!env.NAVER_BOOKING_ID) problems.push('.env 에 NAVER_BOOKING_ID 가 없다 (수동 로그인이라 필수는 아님)');
  try {
    const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
    await browser.close();
    console.log('✅ 시스템 크롬 실행 확인');
  } catch (e) {
    problems.push(`크롬 실행 실패: ${e.message}`);
  }
  console.log(`조회 창: ${ymd(start)} ~ ${ymd(end)} (과거 ${LOOKBACK}일 + 미래 ${LOOKAHEAD}일)`);
  console.log(`대상 URL: ${LIST_URL}`);
  if (problems.length) {
    console.log('\n⚠️ 점검 결과:');
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log('✅ 환경 점검 통과 — `node recon.mjs` 로 정찰을 시작할 수 있다');
  process.exit(0);
}

// ---------- 산출물 디렉터리 ----------
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = join(HERE, 'out', stamp);
mkdirSync(OUT, { recursive: true });

// ---------- 브라우저: 전용 프로필 + 실제 크롬 (사람과 동일한 지문) ----------
const context = await chromium.launchPersistentContext(join(HERE, '.profile'), {
  channel: 'chrome',
  headless: false,
  chromiumSandbox: true, // 샌드박스 유지 — --no-sandbox 경고 바 제거, 일반 크롬과 동일 실행
  viewport: null, // 실제 창 크기 그대로 (고정 뷰포트는 자동화 신호)
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
  args: ['--disable-blink-features=AutomationControlled'],
});
const page = context.pages()[0] ?? (await context.newPage());

// ---------- JSON 응답 캡처 ----------
let seq = 0;
const index = [];
context.on('response', async (resp) => {
  try {
    const url = new URL(resp.url());
    if (!url.hostname.endsWith('naver.com')) return;
    if (url.hostname === 'nid.naver.com') return; // 로그인 응답은 캡처 제외
    const ct = (resp.headers()['content-type'] ?? '').toLowerCase();
    if (!ct.includes('json')) return;
    const body = await resp.text();
    if (!body) return;
    seq += 1;
    const slug = (url.pathname + url.search)
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120);
    const file = `${String(seq).padStart(3, '0')}_${slug || 'root'}.json`;
    writeFileSync(join(OUT, file), body);
    index.push({
      n: seq,
      method: resp.request().method(),
      status: resp.status(),
      url: resp.url(),
      file,
    });
    console.log(`  [${seq}] ${resp.request().method()} ${resp.status()} ${url.pathname}`);
  } catch {
    // 이미 닫힌 응답 등은 무시
  }
});

if (AUTO) {
  console.log(`[auto] 저장된 세션으로 예약 목록을 연다: ${ymd(start)} ~ ${ymd(end)}`);
} else {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('크롬 창이 열린다. 네이버 로그인 화면이 나오면 직접 로그인하세요.');
  console.log('(캡차·2단계인증이 떠도 사람이 직접 처리하면 된다. 세션은 저장되어 재사용됨)');
  console.log(`조회 창: ${ymd(start)} ~ ${ymd(end)}`);
  console.log('로그인 후 예약 목록에서 자유롭게 탐색 — 예약 상세 1건 클릭, 기간 변경,');
  console.log('상태 필터(확정/취소) 변경까지 해보면 필드 파악에 가장 좋다.');
  console.log('');
  console.log('👉 탐색을 마치면 이 터미널에서 Enter 를 누르세요 (저장 후 종료).');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (AUTO) {
  // ---------- 자동 모드: 사람 같은 대기·스크롤 후 종료 ----------
  await sleep(9000 + Math.random() * 3000); // SPA 데이터 로딩 대기
  let landed = page.url();
  console.log(`[auto] 현재 URL: ${landed}`);
  if (/nid\.naver\.com/.test(landed)) {
    // 세션 없음 → 사람 로그인을 기다렸다가 이어서 자동 캡처 (최대 15분).
    // 리다이렉트 도중의 순간적인 partner URL 을 로그인 완료로 오인하지 않도록,
    // partner 도메인에 "안정적으로 머무는지"를 재확인하고 실패하면 계속 기다린다.
    console.log('[auto] 🔑 열린 크롬 창에서 로그인해 주세요 — "로그인 상태 유지" 반드시 체크!');
    const deadline = Date.now() + 15 * 60_000;
    const onPartner = () => /partner\.booking\.naver\.com/.test(page.url());
    let loggedIn = false;
    while (Date.now() < deadline && !loggedIn) {
      await sleep(3000);
      if (!onPartner()) continue;
      await sleep(5000); // 리다이렉트 안정화 대기
      if (!onPartner()) continue;
      console.log('[auto] 로그인 후보 감지 — 목록 재진입으로 세션 검증');
      if (!page.url().includes('booking-list-view')) {
        await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
      }
      await sleep(9000 + Math.random() * 3000);
      loggedIn = onPartner(); // 세션이 없으면 nid 로 다시 튕긴다
      if (!loggedIn) console.log('[auto] 아직 로그인 전 — 계속 대기한다');
    }
    if (loggedIn) console.log('[auto] ✅ 로그인 확정 — 예약 목록 캡처를 계속한다');
    landed = page.url();
  }
  if (/nid\.naver\.com/.test(landed)) {
    console.log('[auto] ⚠️ 로그인이 완료되지 않아 캡처 없이 종료한다');
  } else {
    // 목록을 사람처럼 천천히 스크롤 (조회만 발생)
    for (let i = 0; i < 3; i += 1) {
      await page.mouse.wheel(0, 500 + Math.floor(Math.random() * 300)).catch(() => {});
      await sleep(1200 + Math.random() * 1500);
    }
    await sleep(4000);
  }
  writeFileSync(join(OUT, 'meta.json'), JSON.stringify({ finalUrl: landed, listUrl: LIST_URL }, null, 2));
} else {
  // ---------- 수동 모드: 사용자가 Enter 를 누를 때까지 캡처 유지 ----------
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    rl.once('line', () => {
      rl.close();
      resolve();
    });
  });
}

// ---------- 마무리 저장 ----------
try {
  writeFileSync(join(OUT, 'page.html'), await page.content());
  await page.screenshot({ path: join(OUT, 'page.png'), fullPage: true });
} catch (e) {
  console.log(`페이지 저장 실패(창을 닫았을 수 있음): ${e.message}`);
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2));

// 엔드포인트별 요약 (쿼리 제거한 경로 기준)
const byPath = new Map();
for (const e of index) {
  const p = new URL(e.url).origin + new URL(e.url).pathname;
  if (!byPath.has(p)) byPath.set(p, { count: 0, sample: e.file });
  byPath.get(p).count += 1;
}
const summary = [
  `# 네이버 예약 정찰 요약 (${stamp})`,
  '',
  `- 조회 창: ${ymd(start)} ~ ${ymd(end)}`,
  `- 캡처된 JSON 응답: ${index.length}건, 고유 엔드포인트: ${byPath.size}개`,
  '',
  '| 엔드포인트 | 호출 수 | 샘플 파일 |',
  '|---|---|---|',
  ...[...byPath.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([p, v]) => `| ${p} | ${v.count} | ${v.sample} |`),
  '',
].join('\n');
writeFileSync(join(OUT, 'summary.md'), summary);

console.log('');
console.log(`✅ 저장 완료: ${OUT}`);
console.log(`   JSON ${index.length}건 / 고유 엔드포인트 ${byPath.size}개 — summary.md 참고`);
await context.close();
