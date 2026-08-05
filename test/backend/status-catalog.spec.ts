import { api, auth, createTestContext, TestContext } from './helpers';

/**
 * 상태 코드 사전 (status-catalog) — 도메인별 상태 표시명·색·흐름 순서의 단일 출처.
 * 프론트가 이 응답으로 하이드레이션하므로, 응답 모양과 흐름 순서 일치를 여기서 굳힌다.
 */
describe('상태 사전 (status-catalog)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('도메인별 상태와 흐름 순서를 내려준다', async () => {
    const res = await api(ctx).get('/api/v1/status-catalog').set(auth(ctx)).expect(200);
    const { statuses, flows } = res.body.data;

    // 흐름은 제작 상태 정의(ITEM_STATUS_FLOW)에서 파생된다 — 시작과 발주 지점을 굳힌다.
    expect(flows.orderItem[0]).toBe('CREATED');
    expect(flows.orderItem).toContain('PRODUCTION_REQUESTED');
    expect(flows.component[0]).toBe('CREATED');

    // order-item 사전은 흐름 순서를 그대로 따른다 (프론트 진행률 계산이 이 순서를 쓴다).
    const orderItemCodes = statuses['order-item'].map((s: { code: string }) => s.code);
    expect(orderItemCodes.slice(0, flows.orderItem.length)).toEqual(flows.orderItem);

    // 화면이 쓰는 도메인이 모두 있고, 모든 엔트리에 표시명·색이 있다.
    for (const domain of ['contract', 'contract-version', 'order', 'order-item', 'component', 'option-session', 'work-order', 'measurement-type']) {
      expect(statuses[domain]?.length).toBeGreaterThan(0);
      for (const entry of statuses[domain]) {
        expect(entry.label).toBeTruthy();
        expect(entry.color).toBeTruthy();
      }
    }
  });

  it('인증 없이는 조회할 수 없다', async () => {
    await api(ctx).get('/api/v1/status-catalog').expect(401);
  });
});
