import { randomUUID } from 'crypto';
import { NotificationsModule } from '../../backend/src/modules/notifications/notifications.module';
import { api, auth, createTestContext, TestContext, truncateBusinessData } from './helpers';

/** 스텁 벤더가 알림톡을 실패시킬 번호. 어댑터 생성 전에 설정해야 한다. */
const FAIL_PHONE = '010-9999-0000';
const FAIL_PHONE_2 = '010-9999-0001';
process.env.DEMO_ALIMTALK_FAIL_PHONES = `${FAIL_PHONE},${FAIL_PHONE_2}`;

describe('알림 (notifications)', () => {
  let ctx: TestContext;
  let customerId: string;
  let templateId: string;

  beforeAll(async () => {
    ctx = await createTestContext([NotificationsModule]);
    await truncateBusinessData(ctx.prisma);
    customerId = randomUUID();
    await ctx.prisma.customer.create({
      data: { id: customerId, name: '홍길동', phone: '010-2222-3333', phoneNormalized: '01022223333' },
    });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('템플릿을 등록·조회·수정한다', async () => {
    const created = await api(ctx)
      .post('/api/v1/notification-templates')
      .set(auth(ctx))
      .send({
        code: 'PICKUP_GUIDE',
        name: '방문 안내',
        channel: 'ALIMTALK',
        body: '#{name}님, #{date}에 매장 방문을 부탁드립니다.',
      })
      .expect(201);
    templateId = created.body.data.id;
    expect(created.body.data.approvalStatus).toBe('PENDING');
    expect(created.body.data.name).toBe('방문 안내');

    const list = await api(ctx).get('/api/v1/notification-templates').set(auth(ctx)).expect(200);
    expect(list.body.data.some((t: { code: string }) => t.code === 'PICKUP_GUIDE')).toBe(true);

    const updated = await api(ctx)
      .patch(`/api/v1/notification-templates/${templateId}`)
      .set(auth(ctx))
      .send({ approvalStatus: 'APPROVED' })
      .expect(200);
    expect(updated.body.data.approvalStatus).toBe('APPROVED');
  });

  it('중복 템플릿 코드는 VALIDATION_ERROR를 반환한다', async () => {
    const res = await api(ctx)
      .post('/api/v1/notification-templates')
      .set(auth(ctx))
      .send({ code: 'PICKUP_GUIDE', channel: 'SMS', body: '중복' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('미리보기는 템플릿 변수를 치환한 문구를 반환한다', async () => {
    const res = await api(ctx)
      .post('/api/v1/notifications/preview')
      .set(auth(ctx))
      .send({ templateId, variables: { name: '홍길동', date: '2026-07-25' } })
      .expect(201);
    expect(res.body.data.renderedBody).toBe('홍길동님, 2026-07-25에 매장 방문을 부탁드립니다.');
  });

  it('발송 시 SENT 이력이 저장되고 고객 이력에서 조회된다', async () => {
    const res = await api(ctx)
      .post('/api/v1/notifications/send')
      .set(auth(ctx))
      .send({ templateId, customerId, variables: { name: '홍길동', date: '2026-07-25' } })
      .expect(201);
    expect(res.body.data.status).toBe('SENT');
    expect(res.body.data.sentAt).toBeTruthy();
    expect(res.body.data.recipientPhone).toBe('010-2222-3333');
    expect(res.body.data.renderedBody).toContain('홍길동');

    const history = await api(ctx)
      .get(`/api/v1/customers/${customerId}/notifications`)
      .set(auth(ctx))
      .expect(200);
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0].status).toBe('SENT');
    expect(history.body.data[0].template.code).toBe('PICKUP_GUIDE');
    expect(history.body.data[0].template.name).toBe('방문 안내');
    // 발송 본문·채널이 이력에 그대로 보존된다.
    expect(history.body.data[0].channel).toBe('ALIMTALK');
    expect(history.body.data[0].body).toBe('홍길동님, 2026-07-25에 매장 방문을 부탁드립니다.');
  });

  it('알림톡 발송이 실패하면 SMS로 대체 발송하고 두 건 모두 이력에 남는다', async () => {
    const fallbackCustomerId = randomUUID();
    await ctx.prisma.customer.create({
      data: {
        id: fallbackCustomerId,
        name: '정우성',
        phone: FAIL_PHONE,
        phoneNormalized: FAIL_PHONE.replace(/\D/g, ''),
      },
    });

    const res = await api(ctx)
      .post('/api/v1/notifications/send')
      .set(auth(ctx))
      .send({ templateId, customerId: fallbackCustomerId, variables: { name: '정우성', date: '2026-08-10' } })
      .expect(201);

    // 최상위는 최초(알림톡) 시도 결과, results에 대체 발송까지 담긴다.
    expect(res.body.data.status).toBe('FAILED');
    expect(res.body.data.results).toHaveLength(2);
    expect(res.body.data.results[0]).toMatchObject({ channel: 'ALIMTALK', status: 'FAILED' });
    expect(res.body.data.results[1]).toMatchObject({ channel: 'SMS', status: 'SENT' });
    expect(res.body.data.results[1].retryOfId).toBe(res.body.data.results[0].id);

    const history = await api(ctx)
      .get(`/api/v1/customers/${fallbackCustomerId}/notifications`)
      .set(auth(ctx))
      .expect(200);
    expect(history.body.data).toHaveLength(2);
  });

  it('fallbackSms=false면 알림톡 실패 시 대체 발송하지 않는다', async () => {
    const customerNoFallbackId = randomUUID();
    await ctx.prisma.customer.create({
      data: {
        id: customerNoFallbackId,
        name: '무대체',
        phone: FAIL_PHONE_2,
        phoneNormalized: FAIL_PHONE_2.replace(/\D/g, ''),
      },
    });

    const res = await api(ctx)
      .post('/api/v1/notifications/send')
      .set(auth(ctx))
      .send({ templateId, customerId: customerNoFallbackId, fallbackSms: false, variables: { name: '무대체' } })
      .expect(201);
    expect(res.body.data.status).toBe('FAILED');
    expect(res.body.data.results).toHaveLength(1);
  });

  it('같은 triggerKey 재요청은 새 이력을 만들지 않고 최초 결과를 반환한다', async () => {
    const first = await api(ctx)
      .post('/api/v1/notifications/send')
      .set(auth(ctx))
      .send({ templateId, customerId, variables: { name: '홍길동', date: '2026-08-01' }, triggerKey: 'pickup-d1-evt1' })
      .expect(201);
    const second = await api(ctx)
      .post('/api/v1/notifications/send')
      .set(auth(ctx))
      .send({ templateId, customerId, variables: { name: '홍길동', date: '2026-08-01' }, triggerKey: 'pickup-d1-evt1' })
      .expect(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.duplicated).toBe(true);

    const count = await ctx.prisma.notificationHistory.count({ where: { customerId } });
    expect(count).toBe(2); // 직전 테스트 1건 + triggerKey 발송 1건
  });

  it('실패 건 재시도는 기존 이력을 보존하며 새 SENT 이력을 만든다', async () => {
    const failedId = randomUUID();
    await ctx.prisma.notificationHistory.create({
      data: {
        id: failedId,
        templateId,
        customerId,
        recipientPhone: '010-2222-3333',
        status: 'FAILED',
        errorMessage: '벤더 타임아웃',
      },
    });

    const res = await api(ctx).post(`/api/v1/notifications/${failedId}/retry`).set(auth(ctx)).expect(201);
    expect(res.body.data.id).not.toBe(failedId);
    expect(res.body.data.status).toBe('SENT');
    expect(res.body.data.retryOfId).toBe(failedId);

    const original = await ctx.prisma.notificationHistory.findUniqueOrThrow({ where: { id: failedId } });
    expect(original.status).toBe('FAILED');
  });

  it('실패하지 않은 이력은 재시도할 수 없다', async () => {
    const sent = await ctx.prisma.notificationHistory.findFirstOrThrow({
      where: { customerId, status: 'SENT' },
    });
    const res = await api(ctx).post(`/api/v1/notifications/${sent.id}/retry`).set(auth(ctx)).expect(409);
    expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });
});
