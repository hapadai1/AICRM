import { randomUUID } from 'crypto';
import { AuthUser } from '../../backend/src/common/decorators';
import { JourneysService } from '../../backend/src/modules/journeys/journeys.service';
import { REPAIR_TYPES } from '../../backend/src/modules/repairs/repairs.dto';
import { RepairsModule } from '../../backend/src/modules/repairs/repairs.module';
import { PrismaService } from '../../backend/src/prisma/prisma.service';
import { api, auth, createTestContext, TestContext, truncateBusinessData } from './helpers';

/** 수선 테스트용 최소 데이터: 고객 1명. 수선 대상은 계약·주문 이력과 무관하다. */
async function seedRepairCustomer(prisma: PrismaService) {
  const admin = await prisma.user.findUniqueOrThrow({ where: { loginId: 'admin' } });
  const suffix = randomUUID().slice(0, 8);
  const customer = await prisma.customer.create({
    data: {
      id: randomUUID(),
      name: `수선고객-${suffix}`,
      phone: '010-9876-5432',
      phoneNormalized: `${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(0, 20),
    },
  });
  return { admin, customer };
}

describe('수선 (RepairsModule)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext([RepairsModule]);
    await truncateBusinessData(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  /** 상태 흐름·연락 제안 테스트가 공유하는 일반 수선 1건 생성 */
  async function createGeneralRepair(customerId: string): Promise<string> {
    const res = await api(ctx)
      .post('/api/v1/repairs')
      .set(auth(ctx))
      .send({ customerId, repairType: 'GENERAL', requestDate: '2026-07-21', description: '수선 흐름 테스트' })
      .expect(201);
    return res.body.data.id;
  }

  // 수선구분 코드 집합의 단일 출처는 기준정보 상수(admin-master/code-labels.constants)다.
  // 화면 선택지는 GET /code-labels 응답에서 만들므로, 그 집합과 접수 검증 집합이 어긋나면
  // "화면에는 보이는데 접수하면 400"이 된다. 그 계약을 여기서 고정한다.
  it('수선구분 기준정보와 접수가 허용하는 코드 집합이 일치한다', async () => {
    const labels = await api(ctx).get('/api/v1/code-labels').set(auth(ctx)).expect(200);
    const codes = (labels.body.data['repair-type'] as Array<{ code: string }>).map((i) => i.code);
    expect(codes).toEqual([...REPAIR_TYPES]);

    const { customer } = await seedRepairCustomer(ctx.prisma);
    const rejected = await api(ctx)
      .post('/api/v1/repairs')
      .set(auth(ctx))
      .send({
        customerId: customer.id,
        repairType: 'NOT_A_REPAIR_TYPE',
        requestDate: '2026-07-21',
        description: '허용되지 않는 유형',
      })
      .expect(400);
    expect(rejected.body.error.code).toBe('VALIDATION_ERROR');
  });

  describe('수선 접수 — 대상 품목 검증', () => {
    it('CUSTOM 수선은 대상 품목 없이는 접수할 수 없다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const res = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({
          customerId: customer.id,
          repairType: 'CUSTOM_DURING',
          requestDate: '2026-07-21',
          description: '소매 수선',
        })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.fieldErrors?.[0]).toMatchObject({
        field: 'items',
        reason: 'REQUIRED_FOR_CUSTOM',
      });
    });

    // 계약에 등록된 주문 품목을 찾아 연결하던 방식은 폐기됐다 — 품목만 자유롭게 고른다.
    it('대상 품목은 계약 이력과 무관하게 구성품 코드에서 고른다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const res = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({
          customerId: customer.id,
          repairType: 'AFTER_SALE',
          requestDate: '2026-07-21',
          dueDate: '2026-07-30',
          description: '자켓 소매 길이 수선',
          items: [
            { targetProduct: 'JACKET', quantity: 1 },
            { targetProduct: 'TROUSERS', quantity: 2 },
          ],
        })
        .expect(201);
      expect(res.body.data.status).toBe('RECEIVED');
      // 입력 순서가 곧 순번이다 — 같은 접수에 품목을 여러 줄로 적을 수 있다.
      expect(res.body.data.items).toEqual([
        expect.objectContaining({ targetProduct: 'JACKET', quantity: 1, sequenceNo: 1 }),
        expect.objectContaining({ targetProduct: 'TROUSERS', quantity: 2, sequenceNo: 2 }),
      ]);
      // 주문 품목·구성품 연결은 더 이상 만들지 않는다.
      expect(res.body.data.orderItem).toBeNull();
      expect(res.body.data.component).toBeNull();
      // 접수 시 초기 상태 이벤트 생성
      expect(res.body.data.statusEvents.length).toBe(1);
      expect(res.body.data.statusEvents[0].newStatus).toBe('RECEIVED');
    });

    it('기준정보에 없는 품목 코드는 거부된다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const res = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({
          customerId: customer.id,
          repairType: 'AFTER_SALE',
          requestDate: '2026-07-21',
          description: '소매 수선',
          items: [{ targetProduct: 'NOT_A_PRODUCT', quantity: 1 }],
        })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    // 렌탈 수선은 수선 도메인이 아니라 렌탈 진행에서 관리한다 — 수선구분에서 제거됐다.
    it.each(['RENTAL_PRE', 'RENTAL_POST'])('폐지된 수선구분 %s는 거부된다', async (repairType) => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const res = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({
          customerId: customer.id,
          repairType,
          requestDate: '2026-07-21',
          description: '단추 교체',
        })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('GENERAL 수선은 대상 품목 없이 접수된다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const ok = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({
          customerId: customer.id,
          repairType: 'GENERAL',
          requestDate: '2026-07-21',
          description: '외부 구입 자켓 소매 수선',
        })
        .expect(201);
      expect(ok.body.data.customer.id).toBe(customer.id);
      expect(ok.body.data.orderItem).toBeNull();
      // 수선 응답에는 렌탈 실물 연결 자체가 없다 (렌탈 수선은 렌탈 진행에서 관리)
      expect(ok.body.data.rentalInventoryItem).toBeUndefined();
    });

    it('GENERAL 수선은 대상 설명(description)이 필수다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const res = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({ customerId: customer.id, repairType: 'GENERAL', requestDate: '2026-07-21' })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('REPAIR 진행 자동생성 (설계서 02 §7.2·§9.2)', () => {
    it('수선 접수 시 REPAIR 진행이 자동 생성되고 REPAIR_RECEIVED에서 시작한다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);

      const journeys = await ctx.prisma.customerJourney.findMany({
        where: { sourceRepairRequestId: repairId },
      });
      expect(journeys).toHaveLength(1);
      expect(journeys[0]).toMatchObject({
        trackType: 'REPAIR',
        // REPAIR_RECEIVED는 AUTO 단계 — 접수 등록이 곧 자동완료.
        currentStageCode: 'REPAIR_RECEIVED',
        status: 'ACTIVE',
        customerId: customer.id,
        orderId: null,
      });
    });

    it('같은 수선요청으로 진행을 다시 만들어도 중복되지 않는다 (멱등)', async () => {
      const { admin, customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);

      const journeysService = ctx.app.get(JourneysService);
      const actor: AuthUser = {
        id: admin.id,
        loginId: 'admin',
        displayName: '관리자',
        permissions: [],
      };
      const result = await ctx.prisma.$transaction((tx) =>
        journeysService.createRepairJourney(tx, customer.id, repairId, actor),
      );
      expect(result.created).toBe(false);

      const journeys = await ctx.prisma.customerJourney.findMany({
        where: { sourceRepairRequestId: repairId },
      });
      expect(journeys).toHaveLength(1);
    });
  });

  describe('수선 상태 흐름', () => {

    it('접수→요청→진행→입고→연락→출고 순서로만 진행된다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);

      // 단계 건너뛰기 차단
      const skip = await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'RETURNED_TO_SHOP' })
        .expect(409);
      expect(skip.body.error.code).toBe('INVALID_STATUS_TRANSITION');

      for (const status of ['REQUESTED', 'RETURNED_TO_SHOP', 'CUSTOMER_NOTIFIED', 'RELEASED']) {
        const res = await api(ctx)
          .post(`/api/v1/repairs/${repairId}/status-events`)
          .set(auth(ctx))
          .send({ newStatus: status, eventDate: '2026-07-22' })
          .expect(201);
        expect(res.body.data.newStatus).toBe(status);
      }

      // 출고 완료 후 추가 전이 불가
      const after = await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'REQUESTED' })
        .expect(409);
      expect(after.body.error.code).toBe('INVALID_STATUS_TRANSITION');

      const detail = await api(ctx).get(`/api/v1/repairs/${repairId}`).set(auth(ctx)).expect(200);
      expect(detail.body.data.status).toBe('RELEASED');
      expect(detail.body.data.statusEvents.length).toBe(5); // 접수 + 4회 전이
    });

    it('바로 이전 단계로 되돌릴 수 있다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);
      await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'REQUESTED' })
        .expect(201);
      // 수선 요청 → 접수로 한 단계 되돌리기
      const back = await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'RECEIVED', notes: '잘못 눌러 되돌림' })
        .expect(201);
      expect(back.body.data.newStatus).toBe('RECEIVED');
      const detail = await api(ctx).get(`/api/v1/repairs/${repairId}`).set(auth(ctx)).expect(200);
      expect(detail.body.data.status).toBe('RECEIVED');
    });

    it('두 단계 이상 되돌리거나 취소(CANCELLED)로 전이할 수 없다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);
      for (const status of ['REQUESTED', 'RETURNED_TO_SHOP']) {
        await api(ctx)
          .post(`/api/v1/repairs/${repairId}/status-events`)
          .set(auth(ctx))
          .send({ newStatus: status })
          .expect(201);
      }
      // 수선 입고 → 접수로 두 단계 되돌리기 차단
      const jump = await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'RECEIVED' })
        .expect(409);
      expect(jump.body.error.code).toBe('INVALID_STATUS_TRANSITION');

      // 취소 전이는 더 이상 허용되지 않는다 (흐름 밖 코드)
      const cancel = await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'CANCELLED', notes: '고객 취소' })
        .expect(400);
      expect(cancel.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('상태 변경 시 감사로그가 남는다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);
      await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'REQUESTED' })
        .expect(201);
      const logs = await ctx.prisma.auditLog.findMany({
        where: { entityType: 'REPAIR_REQUEST', entityId: repairId, action: 'STATUS_CHANGE' },
      });
      expect(logs.length).toBe(1);
    });
  });

  describe('수선 목록·수정', () => {
    it('상태·고객 필터로 페이지네이션 목록을 조회한다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({
          customerId: customer.id,
          repairType: 'GENERAL',
          requestDate: '2026-07-21',
          description: '외부 구입 자켓 얼룩 제거',
        })
        .expect(201);

      const res = await api(ctx)
        .get(`/api/v1/repairs?status=RECEIVED&customerId=${customer.id}&page=1&size=10`)
        .set(auth(ctx))
        .expect(200);
      expect(res.body.page.totalElements).toBe(1);
      expect(res.body.data[0].customer.id).toBe(customer.id);
      expect(res.body.data[0].status).toBe('RECEIVED');

      const none = await api(ctx)
        .get(`/api/v1/repairs?status=RELEASED&customerId=${customer.id}`)
        .set(auth(ctx))
        .expect(200);
      expect(none.body.page.totalElements).toBe(0);
    });

    it('excludeReleased=true면 출고완료 건은 목록에서 빠진다(상태 지정 시 예외)', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);
      for (const status of ['REQUESTED', 'RETURNED_TO_SHOP', 'CUSTOMER_NOTIFIED', 'RELEASED']) {
        await api(ctx)
          .post(`/api/v1/repairs/${repairId}/status-events`)
          .set(auth(ctx))
          .send({ newStatus: status })
          .expect(201);
      }

      // 완료건 제외 — 목록에서 빠진다
      const excluded = await api(ctx)
        .get(`/api/v1/repairs?customerId=${customer.id}&excludeReleased=true`)
        .set(auth(ctx))
        .expect(200);
      expect(excluded.body.data.find((r: { id: string }) => r.id === repairId)).toBeUndefined();

      // 상태를 직접 고르면 제외 옵션보다 우선한다
      const explicit = await api(ctx)
        .get(`/api/v1/repairs?customerId=${customer.id}&status=RELEASED&excludeReleased=true`)
        .set(auth(ctx))
        .expect(200);
      expect(
        explicit.body.data.find((r: { id: string; status: string }) => r.id === repairId)?.status,
      ).toBe('RELEASED');
    });

    it('PATCH로 완료예정일·내용을 수정한다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const created = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({ customerId: customer.id, repairType: 'GENERAL', requestDate: '2026-07-21', description: '수선' })
        .expect(201);

      const res = await api(ctx)
        .patch(`/api/v1/repairs/${created.body.data.id}`)
        .set(auth(ctx))
        .send({ dueDate: '2026-08-05', description: '바지 기장 수선', notes: '급행' })
        .expect(200);
      expect(res.body.data.description).toBe('바지 기장 수선');
      expect(res.body.data.dueDate).toContain('2026-08-05');
      expect(res.body.data.notes).toBe('급행');
    });

    it('없는 수선 요청 조회는 404', async () => {
      const res = await api(ctx).get(`/api/v1/repairs/${randomUUID()}`).set(auth(ctx)).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  /**
   * 개발설계서 05 G-06 — 상태를 바꾸면 문구를 준비해 확인창 재료로 돌려준다.
   *
   * 수선 메뉴에서 '고객 연락'(CUSTOMER_NOTIFIED)으로 전이할 때만 연락 제안이 실린다
   * (2026-07-30 현업 요청으로 복원). 문구는 REPAIR_CHECKED_IN 진행 단계의 고정 문구를
   * 공유하고, 실제 발송·이력은 화면 확인창의 POST /notifications/send에서 남는다.
   */
  describe('고객 연락 제안', () => {
    it("'고객 연락' 전이에만 연락 제안이 실리고, 다른 전이에는 null이다", async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);

      // 연락 시점이 아닌 전이는 제안이 없다.
      for (const status of ['REQUESTED', 'RETURNED_TO_SHOP']) {
        const res = await api(ctx)
          .post(`/api/v1/repairs/${repairId}/status-events`)
          .set(auth(ctx))
          .send({ newStatus: status })
          .expect(201);
        expect(res.body.data.suggestedNotification).toBeNull();
        expect(res.body.data.newStatus).toBe(status);
      }

      // 고객 연락 전이에는 수선 입고 안내 문구가 실린다.
      const notified = await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'CUSTOMER_NOTIFIED' })
        .expect(201);
      expect(notified.body.data.newStatus).toBe('CUSTOMER_NOTIFIED');
      expect(notified.body.data.suggestedNotification).toMatchObject({
        templateCode: 'JOURNEY_REPAIR_CHECKED_IN',
        // 알림톡 미승인 템플릿이라 실제로는 SMS로 나간다.
        channel: 'SMS',
        recipientPhone: customer.phone,
        customerId: customer.id,
        triggerKey: `repair:${repairId}:CUSTOMER_NOTIFIED`,
      });
      // 고객명이 치환돼 본문에 들어간다.
      expect(notified.body.data.suggestedNotification.renderedBody).toContain(customer.name);
    });
  });
  /** 개발설계서 05 G-07 — 설계 PDF 1페이지 "수선 물품 방문" 대응 */
  describe('접수·출고 방식', () => {
    it('방문 수거/배송이면 주소를 요구하고, 저장 후 응답에 담긴다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);

      const missing = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({
          customerId: customer.id,
          repairType: 'GENERAL',
          requestDate: '2026-07-21',
          description: '바지 기장',
          receiptMethod: 'PICKUP',
        });
      expect(missing.status).toBe(400);
      expect(missing.body.error.fieldErrors?.[0]).toMatchObject({
        field: 'pickupAddress',
        reason: 'REQUIRED_FOR_PICKUP',
      });

      const created = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({
          customerId: customer.id,
          repairType: 'GENERAL',
          requestDate: '2026-07-21',
          description: '바지 기장',
          receiptMethod: 'PICKUP',
          pickupAddress: '서울시 강남구 테헤란로 1',
          releaseMethod: 'VISIT',
        })
        .expect(201);
      expect(created.body.data).toMatchObject({
        receiptMethod: 'PICKUP',
        pickupAddress: '서울시 강남구 테헤란로 1',
        releaseMethod: 'VISIT',
      });

      // 출고를 방문 배송으로 바꾸면 배송 주소가 필요하다.
      const badUpdate = await api(ctx)
        .patch(`/api/v1/repairs/${created.body.data.id}`)
        .set(auth(ctx))
        .send({ releaseMethod: 'DELIVERY' });
      expect(badUpdate.status).toBe(400);
      expect(badUpdate.body.error.fieldErrors?.[0]).toMatchObject({
        field: 'deliveryAddress',
        reason: 'REQUIRED_FOR_DELIVERY',
      });

      const okUpdate = await api(ctx)
        .patch(`/api/v1/repairs/${created.body.data.id}`)
        .set(auth(ctx))
        .send({ releaseMethod: 'DELIVERY', deliveryAddress: '서울시 서초구 서초대로 2' })
        .expect(200);
      expect(okUpdate.body.data).toMatchObject({
        releaseMethod: 'DELIVERY',
        deliveryAddress: '서울시 서초구 서초대로 2',
      });
    });

    it('방식을 지정하지 않아도 접수된다 (기존 동작 유지)', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const res = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({
          customerId: customer.id,
          repairType: 'GENERAL',
          requestDate: '2026-07-21',
          description: '단추 교체',
        })
        .expect(201);
      expect(res.body.data.receiptMethod).toBeNull();
      expect(res.body.data.releaseMethod).toBeNull();
    });
  });
});
