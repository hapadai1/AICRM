import { randomUUID } from 'crypto';
import { api, auth, createTestContext, TestContext, truncateBusinessData } from './helpers';

/**
 * AUDIT-001 조회 응답의 이름 보강.
 * 감사로그는 "누가 무엇을 했나"를 사람이 읽을 수 있어야 한다. 스냅샷에 UUID만 남은 예전 로그도
 * 조회 시점에 부모 식별자로 이름을 붙여 "정장 옵션 버전 2"처럼 읽히는지 확인한다.
 */
describe('감사로그 조회 (AUDIT-001)', () => {
  let ctx: TestContext;
  let optionSetId: string;
  let optionSetName: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    await truncateBusinessData(ctx.prisma);
    const optionSet = await ctx.prisma.optionSet.findFirstOrThrow({
      where: { productCategory: 'SUIT' },
    });
    optionSetId = optionSet.id;
    optionSetName = optionSet.name;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('이름이 없는 예전 로그도 조회 시 옵션셋 이름이 붙는다', async () => {
    await ctx.prisma.auditLog.create({
      data: {
        id: randomUUID(),
        action: 'DELETE',
        entityType: 'OPTION_SET_VERSION',
        entityId: randomUUID(),
        // 이름 보강 전에 기록된 형태 — optionSetName 이 없다.
        beforeJson: { optionSetId, versionNo: 2, status: 'DRAFT', stageCount: 14 },
      },
    });

    const res = await api(ctx)
      .get('/api/v1/audit-logs')
      .query({ entityType: 'OPTION_SET_VERSION' })
      .set(auth(ctx))
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].beforeJson).toMatchObject({
      optionSetName,
      versionNo: 2,
      status: 'DRAFT',
    });
  });

  it('이미 이름이 기록된 로그는 저장된 값을 그대로 쓴다', async () => {
    const id = randomUUID();
    await ctx.prisma.auditLog.create({
      data: {
        id,
        action: 'DELETE',
        entityType: 'OPTION_SET_VERSION',
        entityId: randomUUID(),
        // 옵션셋 이름이 나중에 바뀌어도 기록 당시 이름이 남아야 한다.
        beforeJson: { optionSetId, optionSetName: '기록 당시 이름', versionNo: 3 },
      },
    });

    const res = await api(ctx).get(`/api/v1/audit-logs/${id}`).set(auth(ctx)).expect(200);
    expect(res.body.data.beforeJson.optionSetName).toBe('기록 당시 이름');
  });
});
