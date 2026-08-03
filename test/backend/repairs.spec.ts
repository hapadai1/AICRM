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

interface RepairUnitBody {
  id: string;
  unitNo: number;
  status: string;
}
interface RepairItemBody {
  id: string;
  targetProduct: string;
  quantity: number;
  sequenceNo: number;
  requestedAt: string | null;
  units: RepairUnitBody[];
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

  /** 상태 흐름·연락 제안 테스트가 공유하는 일반 수선 1건 생성 (대상 품목은 모든 유형에서 필수다) */
  async function createGeneralRepair(
    customerId: string,
    items: { targetProduct: string; quantity: number }[] = [{ targetProduct: 'JACKET', quantity: 1 }],
  ): Promise<string> {
    const res = await api(ctx)
      .post('/api/v1/repairs')
      .set(auth(ctx))
      .send({
        customerId,
        repairType: 'GENERAL',
        requestDate: '2026-07-21',
        description: '수선 흐름 테스트',
        items,
      })
      .expect(201);
    return res.body.data.id;
  }

  async function detailOf(repairId: string) {
    const res = await api(ctx).get(`/api/v1/repairs/${repairId}`).set(auth(ctx)).expect(200);
    return res.body.data as {
      status: string;
      items: RepairItemBody[];
      statusEvents: {
        newStatus: string;
        notes: string | null;
        repairRequestItemId: string | null;
        repairRequestItemUnitId: string | null;
      }[];
    };
  }

  /** 줄 수선요청 → 그 줄의 벌을 전부 입고 (부분 진행을 만들 때는 직접 호출한다) */
  async function requestAndReturnAll(repairId: string) {
    const detail = await detailOf(repairId);
    for (const item of detail.items) {
      await api(ctx)
        .post(`/api/v1/repairs/${repairId}/items/${item.id}/request`)
        .set(auth(ctx))
        .send({})
        .expect(201);
      for (const unit of item.units) {
        await api(ctx)
          .post(`/api/v1/repairs/${repairId}/units/${unit.id}/return`)
          .set(auth(ctx))
          .send({})
          .expect(201);
      }
    }
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
        items: [{ targetProduct: 'JACKET', quantity: 1 }],
      })
      .expect(400);
    expect(rejected.body.error.code).toBe('VALIDATION_ERROR');
  });

  describe('수선 접수 — 대상 품목 검증', () => {
    // 진행(수선요청·입고·출고)이 품목 위에서 돌아가므로 품목 없는 건은 누를 것이 없다.
    it.each([...REPAIR_TYPES])('%s 수선은 대상 품목 없이는 접수할 수 없다', async (repairType) => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const res = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({
          customerId: customer.id,
          repairType,
          requestDate: '2026-07-21',
          description: '소매 수선',
        })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.fieldErrors?.[0]).toMatchObject({ field: 'items', reason: 'REQUIRED' });
    });

    // 계약에 등록된 주문 품목을 찾아 연결하던 방식은 폐기됐다 — 품목만 자유롭게 고른다.
    it('대상 품목은 계약 이력과 무관하게 구성품 코드에서 고르고, 수량만큼 벌이 생긴다', async () => {
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
      // 입고·출고는 벌 단위다 — 하의 2벌은 #1·#2로 따로 센다.
      const items = res.body.data.items as RepairItemBody[];
      expect(items.map((i) => i.units.length)).toEqual([1, 2]);
      expect(items[1].units.map((u) => u.unitNo)).toEqual([1, 2]);
      expect(items.every((i) => i.requestedAt === null)).toBe(true);
      expect(items.flatMap((i) => i.units).every((u) => u.status === 'PENDING')).toBe(true);
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
          items: [{ targetProduct: 'JACKET', quantity: 1 }],
        })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('GENERAL 수선은 대상 설명(description)이 필수다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const res = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({
          customerId: customer.id,
          repairType: 'GENERAL',
          requestDate: '2026-07-21',
          items: [{ targetProduct: 'JACKET', quantity: 1 }],
        })
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

  /**
   * 품목별 진행 (현업 확정 2026-08-01).
   * 수선요청은 접수 줄 단위, 입고·출고는 벌 단위이고 건 상태는 그 진행에서 계산된다.
   */
  describe('품목별 진행', () => {
    it('수선요청 전에는 입고할 수 없다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);
      const detail = await detailOf(repairId);

      const res = await api(ctx)
        .post(`/api/v1/repairs/${repairId}/units/${detail.items[0].units[0].id}/return`)
        .set(auth(ctx))
        .send({})
        .expect(409);
      expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('모든 줄을 요청해야 건이 수선 요청으로 넘어간다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id, [
        { targetProduct: 'JACKET', quantity: 1 },
        { targetProduct: 'TROUSERS', quantity: 1 },
      ]);
      const detail = await detailOf(repairId);

      await api(ctx)
        .post(`/api/v1/repairs/${repairId}/items/${detail.items[0].id}/request`)
        .set(auth(ctx))
        .send({})
        .expect(201);
      expect((await detailOf(repairId)).status).toBe('RECEIVED');

      await api(ctx)
        .post(`/api/v1/repairs/${repairId}/items/${detail.items[1].id}/request`)
        .set(auth(ctx))
        .send({})
        .expect(201);
      expect((await detailOf(repairId)).status).toBe('REQUESTED');
    });

    it('전 벌 입고로 수선 입고가 되고, 전 벌 출고로 출고 완료가 된다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      // 상의 2벌 — 한 벌만 입고된 중간 상태를 확인하기 위해 수량을 나눈다.
      const repairId = await createGeneralRepair(customer.id, [
        { targetProduct: 'JACKET', quantity: 2 },
      ]);
      const before = await detailOf(repairId);
      const [item] = before.items;

      await api(ctx)
        .post(`/api/v1/repairs/${repairId}/items/${item.id}/request`)
        .set(auth(ctx))
        .send({})
        .expect(201);
      await api(ctx)
        .post(`/api/v1/repairs/${repairId}/units/${item.units[0].id}/return`)
        .set(auth(ctx))
        .send({})
        .expect(201);
      // 한 벌은 아직 수선집에 있다 — 건은 수선 요청에 머문다.
      expect((await detailOf(repairId)).status).toBe('REQUESTED');

      // 입고된 벌은 연락 전이라도 먼저 내줄 수 있다(부분 출고).
      await api(ctx)
        .post(`/api/v1/repairs/${repairId}/units/${item.units[0].id}/release`)
        .set(auth(ctx))
        .send({})
        .expect(201);
      expect((await detailOf(repairId)).status).toBe('REQUESTED');

      await api(ctx)
        .post(`/api/v1/repairs/${repairId}/units/${item.units[1].id}/return`)
        .set(auth(ctx))
        .send({})
        .expect(201);
      expect((await detailOf(repairId)).status).toBe('RETURNED_TO_SHOP');

      await api(ctx)
        .post(`/api/v1/repairs/${repairId}/units/${item.units[1].id}/release`)
        .set(auth(ctx))
        .send({})
        .expect(201);
      const done = await detailOf(repairId);
      expect(done.status).toBe('RELEASED');
      // 연락 없이 전량 출고되면 건너뛴 단계를 자동으로 채워 순서를 지킨다.
      expect(
        done.statusEvents.find((e) => e.newStatus === 'CUSTOMER_NOTIFIED')?.notes,
      ).toBe('연락 전 출고로 자동 정리');
    });

    it('벌 진행을 한 칸 되돌리면 건 상태도 따라 내려온다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);
      await requestAndReturnAll(repairId);
      expect((await detailOf(repairId)).status).toBe('RETURNED_TO_SHOP');

      const detail = await detailOf(repairId);
      const unitId = detail.items[0].units[0].id;
      await api(ctx)
        .delete(`/api/v1/repairs/${repairId}/units/${unitId}/status`)
        .set(auth(ctx))
        .expect(200);
      const back = await detailOf(repairId);
      expect(back.status).toBe('REQUESTED');
      expect(back.items[0].units[0].status).toBe('PENDING');
    });

    it('입고된 벌이 있으면 그 줄의 수선요청은 되돌릴 수 없다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);
      await requestAndReturnAll(repairId);

      const detail = await detailOf(repairId);
      const res = await api(ctx)
        .delete(`/api/v1/repairs/${repairId}/items/${detail.items[0].id}/request`)
        .set(auth(ctx))
        .expect(409);
      expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('한 번 연락한 건은 출고를 되돌려도 고객 연락에 머문다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);
      await requestAndReturnAll(repairId);
      await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'CUSTOMER_NOTIFIED' })
        .expect(201);

      const detail = await detailOf(repairId);
      const unitId = detail.items[0].units[0].id;
      await api(ctx)
        .post(`/api/v1/repairs/${repairId}/units/${unitId}/release`)
        .set(auth(ctx))
        .send({})
        .expect(201);
      expect((await detailOf(repairId)).status).toBe('RELEASED');

      await api(ctx)
        .delete(`/api/v1/repairs/${repairId}/units/${unitId}/status`)
        .set(auth(ctx))
        .expect(200);
      // 연락은 이미 나간 사실이라 '수선 입고'로 내려가지 않는다(연락 버튼이 다시 뜨면 안 된다).
      expect((await detailOf(repairId)).status).toBe('CUSTOMER_NOTIFIED');
    });

    it('진행 이력은 건·줄·벌을 구분해 남고 감사로그도 쌓인다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);
      await requestAndReturnAll(repairId);

      const detail = await detailOf(repairId);
      const scopes = detail.statusEvents.map((e) =>
        e.repairRequestItemUnitId ? 'unit' : e.repairRequestItemId ? 'item' : 'repair',
      );
      // 접수(건) · 수선요청(줄) · 롤업(건) · 입고(벌) · 롤업(건)
      expect(scopes).toEqual(['repair', 'item', 'repair', 'unit', 'repair']);

      const logs = await ctx.prisma.auditLog.findMany({
        where: { entityType: 'REPAIR_REQUEST', entityId: repairId, action: 'STATUS_CHANGE' },
      });
      expect(logs.length).toBe(2); // 수선 요청 · 수선 입고
    });
  });

  describe('건 단위 상태 변경은 고객 연락만 허용한다', () => {
    it.each(['REQUESTED', 'RELEASED'])('%s로 직접 전이할 수 없다', async (newStatus) => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);
      const res = await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.fieldErrors?.[0]).toMatchObject({
        field: 'newStatus',
        reason: 'NOT_MANUAL',
      });
    });

    it('수선 입고는 품목별 입고로만 정해진다 (연락 되돌리기 경로만 허용)', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);
      const res = await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'RETURNED_TO_SHOP' })
        .expect(409);
      expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('취소(CANCELLED)로는 전이할 수 없다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);
      const res = await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'CANCELLED', notes: '고객 취소' })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('전 벌 입고 후 고객 연락하고, 되돌릴 수 있다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);
      await requestAndReturnAll(repairId);

      await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'CUSTOMER_NOTIFIED' })
        .expect(201);
      expect((await detailOf(repairId)).status).toBe('CUSTOMER_NOTIFIED');

      await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'RETURNED_TO_SHOP', notes: '잘못 눌러 되돌림' })
        .expect(201);
      expect((await detailOf(repairId)).status).toBe('RETURNED_TO_SHOP');
    });
  });

  describe('수선 목록·수정', () => {
    it('상태·고객 필터로 페이지네이션 목록을 조회한다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      await createGeneralRepair(customer.id);

      const res = await api(ctx)
        .get(`/api/v1/repairs?status=RECEIVED&customerId=${customer.id}&page=1&size=10`)
        .set(auth(ctx))
        .expect(200);
      expect(res.body.page.totalElements).toBe(1);
      expect(res.body.data[0].customer.id).toBe(customer.id);
      expect(res.body.data[0].status).toBe('RECEIVED');
      // 목록도 품목·벌을 함께 준다 — 화면이 목록에서 바로 진행 표를 그린다.
      expect(res.body.data[0].items[0].units).toHaveLength(1);

      const none = await api(ctx)
        .get(`/api/v1/repairs?status=RELEASED&customerId=${customer.id}`)
        .set(auth(ctx))
        .expect(200);
      expect(none.body.page.totalElements).toBe(0);
    });

    it('excludeReleased=true면 출고완료 건은 목록에서 빠진다(상태 지정 시 예외)', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);
      await requestAndReturnAll(repairId);
      const detail = await detailOf(repairId);
      await api(ctx)
        .post(`/api/v1/repairs/${repairId}/units/${detail.items[0].units[0].id}/release`)
        .set(auth(ctx))
        .send({})
        .expect(201);

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
      const repairId = await createGeneralRepair(customer.id);

      const res = await api(ctx)
        .patch(`/api/v1/repairs/${repairId}`)
        .set(auth(ctx))
        .send({ dueDate: '2026-08-05', description: '바지 기장 수선', notes: '급행' })
        .expect(200);
      expect(res.body.data.description).toBe('바지 기장 수선');
      expect(res.body.data.dueDate).toContain('2026-08-05');
      expect(res.body.data.notes).toBe('급행');
    });

    it('진행 전 품목은 자유롭게 바꾸고, 수량을 늘리면 벌이 늘어난다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);

      const res = await api(ctx)
        .patch(`/api/v1/repairs/${repairId}`)
        .set(auth(ctx))
        .send({ items: [{ targetProduct: 'SHIRT', quantity: 3 }] })
        .expect(200);
      const items = res.body.data.items as RepairItemBody[];
      expect(items).toHaveLength(1);
      expect(items[0].targetProduct).toBe('SHIRT');
      expect(items[0].units.map((u) => u.unitNo)).toEqual([1, 2, 3]);
    });

    it('진행이 시작된 품목은 지우거나 바꿀 수 없다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id, [
        { targetProduct: 'JACKET', quantity: 2 },
      ]);
      await requestAndReturnAll(repairId);

      const changed = await api(ctx)
        .patch(`/api/v1/repairs/${repairId}`)
        .set(auth(ctx))
        .send({ items: [{ targetProduct: 'SHIRT', quantity: 2 }] })
        .expect(409);
      expect(changed.body.error.code).toBe('REPAIR_ITEM_IN_PROGRESS');

      // 이미 움직인 벌 아래로는 수량도 줄일 수 없다.
      const shrunk = await api(ctx)
        .patch(`/api/v1/repairs/${repairId}`)
        .set(auth(ctx))
        .send({ items: [{ targetProduct: 'JACKET', quantity: 1 }] })
        .expect(409);
      expect(shrunk.body.error.code).toBe('REPAIR_ITEM_IN_PROGRESS');

      const removed = await api(ctx)
        .patch(`/api/v1/repairs/${repairId}`)
        .set(auth(ctx))
        .send({ items: [] })
        .expect(400);
      expect(removed.body.error.code).toBe('VALIDATION_ERROR');
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
    it("'고객 연락' 전이에만 연락 제안이 실린다", async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const repairId = await createGeneralRepair(customer.id);
      await requestAndReturnAll(repairId);

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

      // 연락을 되돌리는 전이에는 제안이 실리지 않는다.
      const back = await api(ctx)
        .post(`/api/v1/repairs/${repairId}/status-events`)
        .set(auth(ctx))
        .send({ newStatus: 'RETURNED_TO_SHOP' })
        .expect(201);
      expect(back.body.data.suggestedNotification).toBeNull();
    });
  });

  /** 개발설계서 05 G-07 — 설계 PDF 1페이지 "수선 물품 방문" 대응 */
  describe('접수·출고 방식', () => {
    it('방문 수거/배송이면 주소를 요구하고, 저장 후 응답에 담긴다', async () => {
      const { customer } = await seedRepairCustomer(ctx.prisma);
      const items = [{ targetProduct: 'TROUSERS', quantity: 1 }];

      const missing = await api(ctx)
        .post('/api/v1/repairs')
        .set(auth(ctx))
        .send({
          customerId: customer.id,
          repairType: 'GENERAL',
          requestDate: '2026-07-21',
          description: '바지 기장',
          items,
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
          items,
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
          items: [{ targetProduct: 'JACKET', quantity: 1 }],
        })
        .expect(201);
      expect(res.body.data.receiptMethod).toBeNull();
      expect(res.body.data.releaseMethod).toBeNull();
    });
  });
});
