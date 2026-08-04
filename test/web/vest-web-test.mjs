/**
 * 베스트(3피스) 추가/제외 웹 시나리오 — headless Chrome(시스템 크롬)으로 실제 버튼을 누른다.
 *
 * 실행: docs는 docs/test/전체테스트_실행방안.md 참고. 요약:
 *   1) 백엔드(:3000)·프런트(:5173) 개발 서버가 떠 있어야 한다
 *   2) cd test/web && npm install (최초 1회)
 *   3) node vest-web-test.mjs
 *
 * 계약서는 베스트를 다루지 않는다 (현업 확정 2026-08-01) — 정장은 맞춤·렌탈 모두 상의·하의·
 * 베스트 세 부위로 만들어지고, 뺄지 말지는 스타일 컨설팅에서 벌마다 [베스트 제외]로 정한다.
 * 금액은 자동 차감하지 않는다(베스트 값이 그때그때 다르다) — 계약서에서 수기로 조정한다.
 *
 * 흐름: 로그인 → 계약서 작성(고객·계약구분·단가) → 품목표에 베스트 흔적이 없는지 확인 →
 *       임시저장 → 스타일 컨설팅 → 정장 베스트 행에서 [베스트 제외] 체크(옵션 버튼 잠김) →
 *       체크 해제로 재포함 → 계약서로 돌아와 금액이 그대로인지 확인. 각 단계 스크린샷.
 * 끝나면 테스트로 만든 초안 계약을 API로 삭제해 개발 DB를 더럽히지 않는다.
 * 스크린샷: docs/test/screenshots/vest/ (매 실행 시 덮어씀)
 */
import { chromium } from 'playwright-core';
import { mkdirSync, rmSync } from 'fs';

const BASE = process.env.AICRM_WEB ?? 'http://localhost:5173';
const API = process.env.AICRM_API ?? 'http://localhost:3000/api/v1';
const LOGIN_ID = process.env.AICRM_LOGIN ?? 'admin';
const PASSWORD = process.env.AICRM_PASSWORD ?? 'admin1234!';
/** 신체정보(키·몸무게·나이)가 채워진 고객이어야 보완 팝업 없이 진행된다. */
const CUSTOMER = process.env.AICRM_CUSTOMER ?? '강태오';
const CONTRACT_TYPE = process.env.AICRM_CONTRACT_TYPE ?? '비즈니스 정장 맞춤';

const SHOTS = new URL('../../docs/test/screenshots/vest/', import.meta.url).pathname;
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

let step = 0;
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

async function shot(name) {
  step += 1;
  const file = `${SHOTS}${String(step).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file, fullPage: false });
  log(`📸 ${file.split('/').pop()}`);
}

/** antd Select: 클릭 → 검색어 입력 → 드롭다운 옵션 클릭 */
async function pickSelect(selectLocator, keyword, optionText) {
  await selectLocator.click();
  if (keyword) await page.keyboard.type(keyword, { delay: 40 });
  const option = page.locator('.ant-select-item-option', { hasText: optionText }).first();
  await option.waitFor({ state: 'visible' });
  await option.click();
}

/** 테스트가 만든 초안 계약을 API로 삭제 (계약번호 기준) */
async function cleanup(contractNo) {
  if (!contractNo) return;
  try {
    const login = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginId: LOGIN_ID, password: PASSWORD }),
    });
    const token = (await login.json())?.data?.accessToken;
    const list = await fetch(`${API}/contracts?q=${contractNo}&size=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const id = (await list.json())?.data?.[0]?.id;
    if (!id) return;
    const del = await fetch(`${API}/contracts/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    log(`🧹 테스트 계약 정리: ${contractNo} → ${del.ok ? '삭제됨' : `실패(${del.status})`}`);
  } catch (e) {
    log(`🧹 정리 실패(수동 삭제 필요: ${contractNo}): ${e.message}`);
  }
}

let contractNo = null;
try {
  // 1) 로그인
  await page.goto(BASE);
  await page.getByPlaceholder('아이디').fill(LOGIN_ID);
  await page.getByPlaceholder('비밀번호').fill(PASSWORD);
  await shot('login');
  await page.keyboard.press('Enter');
  await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  await shot('after-login');

  // 2) 계약서 작성 화면 — 고객·계약 구분
  await page.goto(`${BASE}/contracts/new`);
  await page.getByText('고객명 또는 전화번호로 검색').waitFor();
  await pickSelect(
    page.locator('.ant-select', { hasText: '고객명 또는 전화번호로 검색' }).first(),
    CUSTOMER,
    CUSTOMER,
  );
  await page.waitForTimeout(600);
  await shot('customer-selected');

  await pickSelect(page.locator('.ant-select', { hasText: '계약 구분 선택' }).first(), null, CONTRACT_TYPE);
  await page.waitForTimeout(400);

  // 3) 품목표: 정장 1벌 100만. 계약서에는 베스트가 없어야 한다(행도, 체크박스도).
  const suitRow = page.locator('tr', { has: page.locator('.ant-select-selection-item[title="정장"]') }).first();
  const numInputs = suitRow.locator('.ant-input-number-input'); // 0=수량 1=단가 2=금액
  // 수량은 계약 구분의 기본 품목을 따라 2벌로 들어오기도 한다 — 금액 검증이 흔들리지 않게 1벌로 고정.
  await numInputs.nth(0).fill('1');
  await numInputs.nth(1).fill('1000000');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);

  if (await page.locator('tr', { hasText: '└ 베스트' }).count())
    throw new Error('계약서 품목표에 베스트 행이 남아 있다');
  if (await page.getByLabel('베스트 제외').count())
    throw new Error('계약서 품목표에 [베스트 제외] 체크박스가 남아 있다');
  await shot('contract-without-vest');

  // 4) 임시저장 — 토스트에서 계약번호 확보(끝나고 정리용)
  await page.getByRole('button', { name: '임시저장' }).click();
  const toast = page.getByText(/임시 저장되었습니다/);
  await toast.waitFor();
  contractNo = (await toast.textContent())?.match(/CTR-[\d-]+/)?.[0] ?? null;
  await shot('draft-saved');

  // 5) 스타일 컨설팅 — 정장은 상의·하의·베스트 세 부위로 나온다
  await page.getByRole('button', { name: '스타일 컨설팅으로 이동' }).click();
  await page.getByText('스타일 컨설팅 —').waitFor();
  await page.locator('td', { hasText: '베스트' }).first().waitFor();
  await shot('consulting-with-vest-row');

  // 6) 정장 #1 베스트 행의 [베스트 제외] 체크 → 옵션 버튼이 잠기고 "제외됨"이 남는다
  const vestBox = page.getByLabel('정장 #1 베스트 제외', { exact: true });
  await vestBox.waitFor();
  if (await vestBox.isChecked()) throw new Error('새 계약인데 베스트가 이미 제외돼 있다');
  await vestBox.click();
  await page.getByText(/베스트를 제외했습니다/).waitFor();
  await page.waitForTimeout(800);
  if (!(await page.getByLabel('정장 #1 베스트 제외', { exact: true }).isChecked()))
    throw new Error('제외 후에도 체크가 들어가지 않았다');
  if (!(await page.getByText('제외됨').count())) throw new Error('옵션 칸에 "제외됨"이 없다');
  await shot('vest-excluded-list');

  // 7) 체크 해제 → 재포함 (계약서 경로가 없어졌으므로 여기서 왕복이 돼야 한다)
  await page.getByLabel('정장 #1 베스트 제외', { exact: true }).click();
  await page.getByText(/베스트를 다시 포함했습니다/).waitFor();
  await page.waitForTimeout(800);
  if (await page.getByLabel('정장 #1 베스트 제외', { exact: true }).isChecked())
    throw new Error('재포함 후에도 체크가 남아 있다');
  await shot('vest-included-again');

  // 8) 계약서로 돌아와 금액이 그대로인지 확인 (베스트는 금액을 건드리지 않는다)
  await page.getByRole('button', { name: /계약으로/ }).click();
  await page.waitForTimeout(1200);
  await shot('back-to-contract');

  const header = await page.locator('text=/합계 .*원/').first().textContent().catch(() => null);
  log(`합계 표시: ${header}`);
  if (header && !header.includes('1,000,000')) throw new Error(`계약 금액이 바뀌었다: ${header}`);
  log(`콘솔 페이지 오류: ${errors.length === 0 ? '없음' : errors.join(' | ')}`);
  log('DONE — 전 단계 통과');
} catch (e) {
  await shot('FAILED');
  console.error('실패:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  await cleanup(contractNo);
}
