import { api, auth, createTestContext, TestContext } from './helpers';

describe('인증·권한 (Phase 1)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('로그인 성공 시 토큰과 권한 목록을 반환한다', async () => {
    const res = await api(ctx)
      .post('/api/v1/auth/login')
      .send({ loginId: 'admin', password: 'admin1234!' })
      .expect(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.user.permissions).toContain('USER_ADMIN');
  });

  it('비밀번호 오류는 AUTH_INVALID_CREDENTIALS 오류 envelope을 반환한다', async () => {
    const res = await api(ctx)
      .post('/api/v1/auth/login')
      .send({ loginId: 'admin', password: 'wrong-password' })
      .expect(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('인증 없이 보호 API 접근 시 401을 반환한다', async () => {
    await api(ctx).get('/api/v1/users').expect(401);
  });

  it('권한 보유 시 사용자 목록을 조회한다', async () => {
    const res = await api(ctx).get('/api/v1/users').set(auth(ctx)).expect(200);
    expect(res.body.data.some((u: { loginId: string }) => u.loginId === 'admin')).toBe(true);
  });

  it('재인증: 올바른 비밀번호는 verified=true를 반환하고 토큰을 재발급하지 않는다', async () => {
    const res = await api(ctx)
      .post('/api/v1/auth/verify-password')
      .set(auth(ctx))
      .send({ password: 'admin1234!' })
      .expect(200);
    expect(res.body.data.verified).toBe(true);
    // 토큰은 발급/회전하지 않는다 (세션 유지)
    expect(res.body.data.accessToken).toBeUndefined();
    expect(res.body.data.refreshToken).toBeUndefined();

    // 성공 재인증이 REAUTH 감사로그로 남는다
    const admin = await ctx.prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
    const logs = await ctx.prisma.auditLog.findMany({
      where: { action: 'REAUTH', entityType: 'USER', entityId: admin.id },
    });
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it('재인증: 틀린 비밀번호는 AUTH_INVALID_CREDENTIALS 401을 반환한다', async () => {
    const res = await api(ctx)
      .post('/api/v1/auth/verify-password')
      .set(auth(ctx))
      .send({ password: 'wrong-password' })
      .expect(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('재인증: 인증 없이 호출하면 401을 반환한다 (@Public 아님)', async () => {
    await api(ctx).post('/api/v1/auth/verify-password').send({ password: 'admin1234!' }).expect(401);
  });

  it('refresh 토큰 회전이 동작한다', async () => {
    const login = await api(ctx)
      .post('/api/v1/auth/login')
      .send({ loginId: 'admin', password: 'admin1234!' })
      .expect(200);
    const refreshed = await api(ctx)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: login.body.data.refreshToken })
      .expect(200);
    expect(refreshed.body.data.accessToken).toBeDefined();
    // 회전된 기존 토큰은 재사용 불가
    await api(ctx)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: login.body.data.refreshToken })
      .expect(401);
  });
});
