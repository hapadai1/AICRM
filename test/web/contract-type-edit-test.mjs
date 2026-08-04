/**
 * 계약 구분 수정 저장 웹 시나리오 — headless Chrome(시스템 크롬)으로 실제 버튼을 누른다.
 *
 * 실행: 백엔드(:3000)·프런트(:5173) 개발 서버가 떠 있어야 한다.
 *   cd test/web && node contract-type-edit-test.mjs
 *
 * 흐름: 로그인 → /admin/contract-types → [수정] → 정렬 순서만 바꿔 [저장]
 *       → 성공 토스트 확인 → 원래 값으로 되돌려 다시 저장(개발 DB 원복).
 * 회귀 대상: 서버가 돌려준 라인의 id·contractTypeId·타임스탬프를 그대로 PATCH로 되보내
 *           forbidNonWhitelisted 400('입력값을 확인해 주세요')이 나던 버그.
 * 스크린샷: docs/test/screenshots/contract-type/ (매 실행 시 덮어씀)
 */
import { chromium } from 'playwright-core';
import { mkdirSync, rmSync } from 'fs';

const BASE = process.env.AICRM_WEB ?? 'http://localhost:5173';
const LOGIN_ID = process.env.AICRM_LOGIN ?? 'admin';
const PASSWORD = process.env.AICRM_PASSWORD ?? 'admin1234!';
/** 정렬 순서를 바꿨다 되돌릴 대상 계약 구분 (기본 시드 기준 sortOrder 1) */
const TARGET = process.env.AICRM_CONTRACT_TYPE ?? '비즈니스 정장 맞춤';

const SHOTS = new URL('../../docs/test/screenshots/contract-type/', import.meta.url).pathname;
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

let step = 0;
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1100 } })).newPage();
page.setDefaultTimeout(15000);
const errors = [];
const failedPatches = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => {
  if (r.request().method() === 'PATCH' && r.url().includes('/contract-types/') && !r.ok())
    failedPatches.push(`${r.status()} ${r.url()}`);
});

async function shot(name) {
  step += 1;
  const file = `${SHOTS}${String(step).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file, fullPage: false });
  log(`📸 ${file.split('/').pop()}`);
}

/** 이름으로 행을 찾아 모달을 열고 정렬 순서를 바꿔 저장 → 모달이 닫히면 true(저장 성공) */
async function editSortOrder(name, sortOrder, shotPrefix) {
  // 앞선 토스트가 남아 있으면 성공/실패 판정이 섞이므로 사라질 때까지 기다린다.
  await page.locator('.ant-message-notice').first().waitFor({ state: 'detached', timeout: 6000 }).catch(() => {});

  const row = page.locator('tbody tr', { hasText: name }).first();
  await row.waitFor();
  await row.getByRole('button', { name: '수정' }).click();
  const modal = page.locator('.ant-modal-content', { hasText: '계약 구분 수정' });
  await modal.waitFor();
  await modal.locator('.ant-input-number-input').first().fill(String(sortOrder));
  await shot(`${shotPrefix}-modal`);
  await modal.getByRole('button', { name: '저장' }).click();

  const ok = page.getByText('계약 구분을 수정했습니다.');
  const fail = page.getByText('입력값을 확인해 주세요.');
  const outcome = await Promise.race([
    ok.waitFor({ timeout: 8000 }).then(() => 'ok'),
    fail.waitFor({ timeout: 8000 }).then(() => 'fail'),
  ]).catch(() => 'timeout');
  await shot(`${shotPrefix}-result`);
  if (outcome !== 'ok') return false;
  // 저장 성공이면 모달이 닫혀야 한다.
  await modal.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  return !(await modal.isVisible().catch(() => false));
}

let exitCode = 0;
try {
  // 1) 로그인
  await page.goto(BASE);
  await page.getByPlaceholder('아이디').fill(LOGIN_ID);
  await page.getByPlaceholder('비밀번호').fill(PASSWORD);
  await page.keyboard.press('Enter');
  await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);

  // 2) 계약 구분 관리
  await page.goto(`${BASE}/admin/contract-types`);
  await page.getByText('계약 구분 관리').waitFor();
  await page.waitForTimeout(600);
  await shot('list');

  // 3) 대상 행 수정 → 정렬 순서 9로 저장
  const saved = await editSortOrder(TARGET, 9, 'edit-9');
  log(saved ? '✅ 저장 성공 (토스트 + 모달 닫힘)' : '❌ 저장 실패');
  if (!saved) exitCode = 1;

  // 4) 원복 (정렬 순서 1)
  const restored = await editSortOrder(TARGET, 1, 'restore-1');
  log(restored ? '🧹 정렬 순서 원복 완료' : '🧹 원복 실패 — 수동 확인 필요');
  if (!restored) exitCode = 1;
} catch (e) {
  log(`❌ 예외: ${e.message}`);
  await shot('error');
  exitCode = 1;
} finally {
  if (failedPatches.length) {
    log(`❌ 실패한 PATCH 응답: ${failedPatches.join(', ')}`);
    exitCode = 1;
  }
  if (errors.length) log(`⚠️ 콘솔 오류: ${errors.join(' | ')}`);
  await browser.close();
  log(exitCode === 0 ? '=== 통과 ===' : '=== 실패 ===');
  process.exit(exitCode);
}
