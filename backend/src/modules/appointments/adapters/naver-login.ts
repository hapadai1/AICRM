import { Logger } from '@nestjs/common';
import { Page } from 'playwright-core';

/**
 * 네이버 자동 로그인 (설계서 16.1 수집 부속).
 *
 * 평소에는 저장된 세션을 재사용하므로 이 코드는 돌지 않는다. 세션이 만료됐을 때만
 * 한 번 시도해서 사람 손을 빌리지 않고 수집을 이어가기 위한 장치다.
 *
 * 캡차를 부르지 않기 위한 원칙:
 *  - 값을 붙여넣지 않고 한 글자씩 실제 키 입력으로 친다. 네이버 로그인 폼은 입력 행태(bvsd)를
 *    함께 수집하므로, 순간 입력은 기계로 판정되기 쉽다.
 *  - "로그인 상태 유지"를 켜서 다음 만료까지 간격을 최대한 늘린다.
 *  - 캡차·기기등록 같은 추가 확인이 뜨면 즉시 포기하고 사람에게 넘긴다. 절대 우회하지 않고,
 *    연달아 재시도하지도 않는다 (연타가 차단을 부른다).
 */

export interface NaverCredentials {
  id: string;
  pw: string;
}

export class NaverLoginBlockedError extends Error {
  constructor(reason: string) {
    super(
      `네이버 자동 로그인이 추가 확인을 요구해 중단했다 (${reason}). ` +
        '사람이 한 번 로그인해야 한다: cd ops/naver-recon && node recon.mjs ' +
        '("로그인 상태 유지" 체크 필수).',
    );
    this.name = 'NaverLoginBlockedError';
  }
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);

/**
 * 사람처럼 한 글자씩 — 글자마다 입력 간격을 흩뜨린다.
 *
 * 입력이 실제로 들어갔는지 반드시 확인한다. 네이버 로그인 폼은 입력란을 가려 두거나
 * 포커스 시 값을 지우는 경우가 있어, 빈 폼을 그대로 제출하면 원인을 알기 어려운 실패가 된다.
 */
async function typeLikeHuman(page: Page, selector: string, value: string): Promise<void> {
  const field = page.locator(selector).first();
  await field.click();
  await page.waitForTimeout(rand(200, 600));
  await page.keyboard.type(value, { delay: rand(60, 180) });

  if ((await field.inputValue().catch(() => '')) === value) return;

  // 키 입력이 먹지 않았다 — 값을 직접 채우고 입력 이벤트를 알린다
  await field.fill(value);
  const filled = await field.inputValue().catch(() => '');
  if (filled !== value) {
    throw new NaverLoginBlockedError(
      `입력란(${selector})에 값이 들어가지 않음 — 로그인 화면 구조가 바뀐 것으로 보인다`,
    );
  }
}

/**
 * 로그인 화면이면 로그인해서 목표 페이지로 돌아간다.
 * 이미 로그인돼 있으면 아무것도 하지 않는다.
 *
 * @returns 실제로 로그인을 수행했으면 true
 */
export async function loginToNaver(
  page: Page,
  creds: NaverCredentials,
  logger = new Logger('NaverLogin'),
): Promise<boolean> {
  if (!/nid\.naver\.com/.test(page.url())) return false;
  if (!creds.id || !creds.pw) {
    throw new NaverLoginBlockedError('계정 정보 없음 (NAVER_BOOKING_ID/PW)');
  }

  logger.log('세션이 만료돼 자동 로그인을 시도한다');
  await page.waitForSelector('#id', { timeout: 20_000 });
  await page.waitForTimeout(rand(500, 1500)); // 화면을 보는 시간

  await typeLikeHuman(page, '#id', creds.id);
  await page.waitForTimeout(rand(300, 900));
  await typeLikeHuman(page, '#pw', creds.pw);
  await page.waitForTimeout(rand(300, 900));

  // "로그인 상태 유지" — 켜 두면 다음 만료까지 간격이 크게 늘어난다
  const keep = page.locator('#loginStay');
  if ((await keep.count()) > 0 && !(await keep.isChecked().catch(() => true))) {
    await page.click('label[for="loginStay"]').catch(() => keep.check({ force: true }));
    await page.waitForTimeout(rand(200, 600));
  }

  await submitLogin(page);
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForTimeout(rand(2500, 4000));

  await assertNoExtraVerification(page);

  // 로그인 성공이면 원래 목적지(파트너센터)로 돌아가 있다
  if (/nid\.naver\.com/.test(page.url())) {
    await page.waitForTimeout(3000);
    if (/nid\.naver\.com/.test(page.url())) {
      // 왜 막혔는지 모르면 다음 시도도 똑같이 실패한다 — 화면이 말하는 이유를 그대로 싣는다
      throw new NaverLoginBlockedError(
        `로그인 화면에 머무름 — 네이버 안내: "${(await loginPageMessage(page)) || '(메시지 없음)'}"`,
      );
    }
  }
  logger.log('자동 로그인 성공');
  return true;
}

/**
 * 로그인 화면이 띄운 안내 문구를 뽑는다 (비밀번호 오류·보호조치 등).
 * 실패 원인을 로그에 남기기 위한 것으로, 개인정보는 담기지 않는다.
 */
async function loginPageMessage(page: Page): Promise<string> {
  for (const selector of ['.error_message', '#err_common', '.error_area', '[role="alert"]']) {
    const el = page.locator(selector).first();
    if ((await el.count()) > 0) {
      const text = (await el.innerText().catch(() => ''))?.trim();
      if (text) return text.replace(/\s+/g, ' ').slice(0, 200);
    }
  }
  const body = (await page.locator('body').innerText().catch(() => '')) ?? '';
  const hit = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /아이디|비밀번호|보호|제한|확인|일치/.test(l) && l.length < 120);
  return hit ?? '';
}

/**
 * 로그인 제출. 네이버는 화면 폭에 따라 로그인 버튼을 두 개(#loginBtn_row/#loginBtn_column) 두고
 * 하나만 보여 주므로, 보이는 버튼을 찾아 누른다. 둘 다 못 찾으면 비밀번호 칸에서 Enter 로 제출한다.
 */
async function submitLogin(page: Page): Promise<void> {
  for (const selector of ['#loginBtn_row', '#loginBtn_column', 'button[type="submit"]']) {
    const button = page.locator(selector).first();
    if ((await button.count()) > 0 && (await button.isVisible().catch(() => false))) {
      await button.click();
      return;
    }
  }
  await page.press('#pw', 'Enter');
}

/** 캡차·기기등록 등 사람이 풀어야 하는 화면이 떴는지 확인한다. 떴으면 즉시 중단. */
async function assertNoExtraVerification(page: Page): Promise<void> {
  const url = page.url();
  if (/captcha/i.test(url)) throw new NaverLoginBlockedError('캡차 화면');
  if (/deviceConfirm|device_confirm/i.test(url)) throw new NaverLoginBlockedError('새 기기 등록 확인');
  if (/otp|two.?factor/i.test(url)) throw new NaverLoginBlockedError('2단계 인증');

  // 캡차 입력란이 실제로 보이는지 (DOM 에만 있고 숨어 있는 경우가 많다)
  for (const selector of ['#ncaptchaSplit', '#captcha', 'input[name="chptchakey"]']) {
    const el = page.locator(selector).first();
    if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
      throw new NaverLoginBlockedError('캡차 입력 요구');
    }
  }

  const body = (await page.locator('body').innerText().catch(() => '')) ?? '';
  for (const phrase of ['자동입력 방지', '새로운 기기', '기기 등록', '일시적으로 제한']) {
    if (body.includes(phrase)) throw new NaverLoginBlockedError(phrase);
  }
}
