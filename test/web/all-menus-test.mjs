/**
 * 전 메뉴 웹 스모크+대표 인터랙션 — headless Chrome(시스템 크롬)으로 실제 화면을 열어 확인한다.
 *
 * 실행: docs는 docs/test/전체테스트_실행방안.md 참고. 요약:
 *   1) 백엔드(:3000)·프런트(:5173) 개발 서버가 떠 있어야 한다
 *   2) cd test/web && npm install (최초 1회)
 *   3) node all-menus-test.mjs
 *
 * 각 단계: 이동 → 핵심 요소 대기 → (가능하면) 대표 조작 → 스크린샷 → 오류 수집.
 * 파괴적 조작(저장·발송·상태변경)은 하지 않는다. 상세 계약 등 대표 데이터는
 * API로 자동 확보하며, 없으면 그 단계만 SKIP으로 표시한다.
 * 스크린샷: docs/test/screenshots/menus/ (매 실행 시 덮어씀)
 */
import { chromium } from 'playwright-core';
import { mkdirSync, rmSync } from 'fs';

const BASE = process.env.AICRM_WEB ?? 'http://localhost:5173';
const API = process.env.AICRM_API ?? 'http://localhost:3000/api/v1';
const LOGIN_ID = process.env.AICRM_LOGIN ?? 'admin';
const PASSWORD = process.env.AICRM_PASSWORD ?? 'admin1234!';
const SHOTS = new URL('../../docs/test/screenshots/menus/', import.meta.url).pathname;
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

// ---------- 대표 데이터 자동 확보 (API) ----------
async function apiLogin() {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId: LOGIN_ID, password: PASSWORD }),
  });
  const body = await res.json();
  if (!body?.data?.accessToken) throw new Error(`API 로그인 실패: ${JSON.stringify(body)}`);
  return body.data.accessToken;
}

async function apiGet(token, path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return (await res.json())?.data;
}

const token = await apiLogin();
const completedContract = (await apiGet(token, '/contracts?status=COMPLETED&size=1'))?.[0]?.id ?? null;
const orderId = completedContract
  ? ((await apiGet(token, `/contracts/${completedContract}`))?.orders?.[0]?.id ?? null)
  : null;
const measurementId = (await apiGet(token, '/measurements?size=1'))?.[0]?.id ?? null;
const workorderItem = (await apiGet(token, '/work-orders?size=1'))?.[0]?.orderItemId ?? null;

// ---------- 브라우저 ----------
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
page.setDefaultTimeout(12000);

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 160)}`));
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`console: ${m.text().slice(0, 160)}`);
});

let n = 0;
const results = [];
async function shot(slug) {
  n += 1;
  await page.screenshot({ path: `${SHOTS}${String(n).padStart(2, '0')}-${slug}.png` });
}

/** 화면이 실제 콘텐츠를 그렸는지 — 에러 Alert·404 placeholder면 실패 */
async function contentOk() {
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  if (await page.getByText('페이지를 찾을 수 없습니다').count()) throw new Error('404 placeholder');
  const errAlert = page.locator('.ant-alert-error');
  if (await errAlert.count()) throw new Error(`에러 Alert: ${(await errAlert.first().textContent())?.slice(0, 80)}`);
  await page.locator('.ant-card, .ant-table, .ant-list, canvas').first().waitFor({ state: 'visible' });
}

async function step(name, slug, fn, { skip } = {}) {
  if (skip) {
    results.push({ name, ok: null, note: skip });
    return;
  }
  const before = consoleErrors.length;
  try {
    await fn();
    await shot(slug);
    const errs = consoleErrors.slice(before);
    results.push({ name, ok: true, note: errs.length ? `콘솔오류 ${errs.length}` : '' });
  } catch (e) {
    await shot(`${slug}-FAIL`);
    results.push({ name, ok: false, note: e.message.slice(0, 120) });
  }
}

// 로그인
await page.goto(BASE);
await page.getByPlaceholder('아이디').fill(LOGIN_ID);
await page.getByPlaceholder('비밀번호').fill(PASSWORD);
await page.keyboard.press('Enter');
await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 15000 });
await page.waitForTimeout(600);

await step('대시보드', 'dashboard', async () => {
  await page.goto(`${BASE}/`);
  await contentOk();
});

await step('진행 현황(Journey)', 'journeys', async () => {
  await page.goto(`${BASE}/journeys`);
  await contentOk();
});

await step('예약 목록·캘린더', 'appointments', async () => {
  await page.goto(`${BASE}/appointments`);
  await contentOk();
});

await step('고객 검색→상세', 'customers', async () => {
  await page.goto(`${BASE}/customers`);
  await contentOk();
  const search = page.locator('input[placeholder*="검색"], input[placeholder*="이름"]').first();
  await search.fill('강태오');
  await page.keyboard.press('Enter');
  await page.getByText('강태오').first().waitFor();
  await shot('customers-searched');
  await page.getByText('강태오').first().click();
  await page.waitForTimeout(900);
  await contentOk();
});

await step('계약 목록·필터', 'contracts-list', async () => {
  await page.goto(`${BASE}/contracts`);
  await contentOk();
  await page.locator('.ant-table-row').first().waitFor();
});

await step(
  '계약 상세(완료) — 계약서·버전·주문',
  'contract-detail',
  async () => {
    await page.goto(`${BASE}/contracts/${completedContract}`);
    await contentOk();
    await page.getByRole('button', { name: /계약서 출력/ }).waitFor();
    await page.getByRole('button', { name: /수정하기/ }).waitFor();
  },
  { skip: completedContract ? undefined : '완료 계약 없음' },
);

await step('스타일 컨설팅 진행 목록', 'options-progress', async () => {
  await page.goto(`${BASE}/options`);
  await contentOk();
});

await step(
  '채촌 목록→기록',
  'measurements',
  async () => {
    await page.goto(`${BASE}/measurements`);
    await contentOk();
    await page.goto(`${BASE}/measurements/${measurementId}`);
    await contentOk();
    await shot('measurement-edit');
  },
  { skip: measurementId ? undefined : '채촌 기록 없음' },
);

await step('제작 관리 목록', 'production', async () => {
  await page.goto(`${BASE}/production`);
  await contentOk();
});

await step(
  '계약별 제작 관리(구성품·작업지시서)',
  'contract-production',
  async () => {
    await page.goto(`${BASE}/contracts/${completedContract}/production`);
    await contentOk();
  },
  { skip: completedContract ? undefined : '완료 계약 없음' },
);

await step(
  '작업지시서 미리보기',
  'workorder-preview',
  async () => {
    await page.goto(`${BASE}/work-orders/${workorderItem}`);
    await contentOk();
  },
  { skip: workorderItem ? undefined : '작업지시서 대상 없음' },
);

await step(
  '주문 상세',
  'order-detail',
  async () => {
    await page.goto(`${BASE}/orders/${orderId}`);
    await contentOk();
  },
  { skip: orderId ? undefined : '주문 없음' },
);

await step('수선 목록·신규 접수 모달', 'repairs', async () => {
  await page.goto(`${BASE}/repairs`);
  await contentOk();
  const newBtn = page.getByRole('button', { name: /신규|접수/ }).first();
  if (await newBtn.count()) {
    await newBtn.click();
    await page.waitForTimeout(500);
    await shot('repairs-modal');
    await page.keyboard.press('Escape');
  }
});

await step('렌탈 재고', 'rentals-inventory', async () => {
  await page.goto(`${BASE}/rentals`);
  await contentOk();
});

await step('렌탈 배정', 'rentals-allocate', async () => {
  await page.goto(`${BASE}/rentals/allocate`);
  await contentOk();
});

await step('렌탈 입출고', 'rentals-handover', async () => {
  await page.goto(`${BASE}/rentals/handover`);
  await contentOk();
});

await step('고객 연락(이력·직접 발송 탭)', 'notifications', async () => {
  await page.goto(`${BASE}/notifications`);
  await contentOk();
  const tab = page.getByRole('tab', { name: /직접 발송/ });
  if (await tab.count()) {
    await tab.click();
    await page.waitForTimeout(500);
    await shot('notifications-direct-tab');
  }
});

await step('통계', 'stats', async () => {
  await page.goto(`${BASE}/stats`);
  await contentOk();
});

for (const [name, slug, path] of [
  ['관리자 — 기준정보', 'admin-master', '/admin/master'],
  ['관리자 — 계약 구분', 'admin-contract-types', '/admin/contract-types'],
  ['관리자 — 옵션세트', 'admin-options', '/admin/options'],
  ['관리자 — 연락 문구', 'admin-templates', '/admin/notification-templates'],
  ['관리자 — 사용자', 'admin-users', '/admin/users'],
  ['관리자 — 감사 로그', 'admin-audit', '/admin/audit'],
]) {
  await step(name, slug, async () => {
    await page.goto(`${BASE}${path}`);
    await contentOk();
  });
}

await step('고객 모드 진입 화면', 'customer-mode', async () => {
  await page.goto(`${BASE}/c`);
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  if (await page.getByText('페이지를 찾을 수 없습니다').count()) throw new Error('404 placeholder');
  await page.waitForTimeout(500);
});

console.log('\n===== 결과 =====');
for (const r of results)
  console.log(`${r.ok === null ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'}\t${r.name}${r.note ? `\t(${r.note})` : ''}`);
const fail = results.filter((r) => r.ok === false).length;
console.log(
  `총 ${results.length} · 통과 ${results.filter((r) => r.ok).length} · 실패 ${fail} · 건너뜀 ${results.filter((r) => r.ok === null).length}`,
);
if (consoleErrors.length) {
  console.log('\n----- 수집된 콘솔/페이지 오류 (중복 제거) -----');
  for (const e of [...new Set(consoleErrors)].slice(0, 15)) console.log(e);
}
await browser.close();
process.exitCode = fail > 0 ? 1 : 0;
