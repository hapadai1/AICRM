import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { seedJourneyStages } from '../../backend/prisma/journey-stage-seed';
import { AppModule } from '../../backend/src/app.module';
import { PrismaService } from '../../backend/src/prisma/prisma.service';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  adminToken: string;
}

/**
 * Nest 앱을 테스트 DB(aicrm_test)로 기동하고 admin 토큰을 발급받는다.
 * 아직 AppModule에 등록되지 않은 개발 중 모듈은 extraModules로 주입해 테스트한다.
 */
export async function createTestContext(extraModules: unknown[] = []): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, ...(extraModules as never[])],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();

  const prisma = app.get(PrismaService);
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ loginId: 'admin', password: 'admin1234!' });
  if (!res.body?.data?.accessToken) {
    throw new Error(`admin 로그인 실패: ${JSON.stringify(res.body)}`);
  }
  return { app, prisma, adminToken: res.body.data.accessToken };
}

export function api(ctx: TestContext) {
  return request(ctx.app.getHttpServer());
}

export function auth(ctx: TestContext): { Authorization: string } {
  return { Authorization: `Bearer ${ctx.adminToken}` };
}

/** 1×1 투명 PNG dataURL — 서명 픽스처 */
export const SIGN_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * 계약을 실제 흐름대로 완료시켜 주문·주문품목을 만든다 (현업 확정 2026-07-30).
 *
 * 작성중 → **컨설팅 전 품목 확정** → 서명(서명완료) → 계약완료(주문 물리화).
 * 예전에는 `POST /contracts/:id/confirm` 한 번으로 주문이 생겼지만, 등록 단계가 없어져
 * 주문을 얻으려면 이 순서를 밟아야 한다. 컨설팅 확정은 픽스처 편의를 위해 세션을 직접
 * CONFIRMED로 만든다(옵션 선택 화면 흐름 자체는 options.spec 이 검증한다).
 *
 * @returns 계약완료 응답(생성된 주문 목록 포함)
 */
export async function signAndCompleteContract(
  ctx: TestContext,
  contractId: string,
): Promise<{ orders: { id: string; orderNo: string; tradeType: string }[]; versionNo: number }> {
  const items = await ctx.prisma.contractItem.findMany({
    where: { contractId, status: { not: 'CANCELLED' } },
  });
  const adminId = (await ctx.prisma.user.findFirstOrThrow({ where: { loginId: 'admin' } })).id;

  for (const item of items) {
    const existing =
      item.transactionType === 'RENTAL'
        ? await ctx.prisma.rentalSelectionSession.findFirst({
            where: { contractItemId: item.id, isCurrent: true, status: 'CONFIRMED' },
          })
        : await ctx.prisma.optionSelectionSession.findFirst({
            where: { contractItemId: item.id, isCurrent: true, status: 'CONFIRMED' },
          });
    if (existing) continue;

    if (item.transactionType === 'RENTAL') {
      await ctx.prisma.rentalSelectionSession.create({
        data: {
          id: randomUUID(),
          contractItemId: item.id,
          status: 'CONFIRMED',
          confirmedAt: new Date(),
          isCurrent: true,
        },
      });
      continue;
    }
    // 맞춤 품목: 해당 카테고리의 ACTIVE 옵션 버전이 있어야 세션을 만들 수 있다.
    const optionSet = await ctx.prisma.optionSet.findUniqueOrThrow({
      where: { productCategory: item.productCategory },
    });
    let versionId = optionSet.activeVersionId;
    if (!versionId) {
      versionId = randomUUID();
      await ctx.prisma.optionSetVersion.create({
        data: {
          id: versionId,
          optionSetId: optionSet.id,
          versionNo: 1,
          status: 'ACTIVE',
          createdBy: adminId,
        },
      });
      await ctx.prisma.optionSet.update({
        where: { id: optionSet.id },
        data: { activeVersionId: versionId },
      });
    }
    await ctx.prisma.optionSelectionSession.create({
      data: {
        id: randomUUID(),
        contractItemId: item.id,
        optionSetVersionId: versionId,
        selectionVersionNo: 1,
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        isCurrent: true,
      },
    });
  }

  const contract = await ctx.prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
  const signRes = await request(ctx.app.getHttpServer())
    .post(`/api/v1/contracts/${contractId}/versions/${contract.currentVersionId}/signature`)
    .set(auth(ctx))
    .send({ imageDataUrl: SIGN_PNG, signerName: '테스트서명' });
  if (signRes.status !== 201 && signRes.status !== 200)
    throw new Error(`서명 실패(${signRes.status}): ${JSON.stringify(signRes.body)}`);

  const after = await ctx.prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
  const completeRes = await request(ctx.app.getHttpServer())
    .post(`/api/v1/contracts/${contractId}/complete`)
    .set(auth(ctx))
    .send({ version: after.rowVersion });
  if (completeRes.status !== 200)
    throw new Error(`계약완료 실패(${completeRes.status}): ${JSON.stringify(completeRes.body)}`);
  return completeRes.body.data;
}

/**
 * 계약 품목 + 주문품목을 한 쌍으로 만든다 (픽스처 공용).
 *
 * 계약 품목(ContractItem)은 **계약 소유**이고 컨설팅(옵션·렌탈 선택)의 앵커다.
 * 주문품목(OrderItem)은 계약완료 시 그 품목을 물리화한 결과이며 sourceContractItemId로 되짚는다.
 * 실제 흐름(계약완료)을 거치지 않고 진행 단계 데이터를 바로 만들 때 쓴다.
 */
export async function seedItemPair(
  prisma: PrismaService,
  args: {
    contractId: string;
    orderId: string;
    /** 계약 라인 참조(있으면 연결) */
    lineId?: string | null;
    transactionType?: 'CUSTOM' | 'RENTAL';
    productCategory: string;
    sequenceNo?: number;
    displayName: string;
    /** 주문품목 상태 (계약 품목은 항상 CREATED) */
    status?: string;
    /** 만들 구성품 코드 — 주문품목·계약품목 양쪽에 같은 축으로 만든다 */
    components?: string[];
  },
): Promise<{ contractItemId: string; orderItemId: string; componentIds: string[] }> {
  const sequenceNo = args.sequenceNo ?? 1;
  const contractItemId = randomUUID();
  const componentIds: string[] = [];
  await prisma.contractItem.create({
    data: {
      id: contractItemId,
      contractId: args.contractId,
      sourceContractLineId: args.lineId ?? null,
      transactionType: args.transactionType ?? 'CUSTOM',
      productCategory: args.productCategory,
      sequenceNo,
      displayName: args.displayName,
      components: {
        create: (args.components ?? []).map((componentType) => ({
          id: randomUUID(),
          componentType,
          sequenceNo: 1,
        })),
      },
    },
  });
  const orderItemId = randomUUID();
  await prisma.orderItem.create({
    data: {
      id: orderItemId,
      orderId: args.orderId,
      sourceContractItemId: contractItemId,
      productCategory: args.productCategory,
      sequenceNo,
      displayName: args.displayName,
      ...(args.status ? { status: args.status } : {}),
      components: {
        create: (args.components ?? []).map((componentType) => {
          const id = randomUUID();
          componentIds.push(id);
          return { id, componentType, sequenceNo: 1 };
        }),
      },
    },
  });
  return { contractItemId, orderItemId, componentIds };
}

/**
 * 업무 데이터 전체 삭제 (시드 데이터는 유지: users/roles/permissions,
 * appointment_purposes, option_sets, contract_types, contract_type_lines).
 * 각 스위트 beforeAll에서 호출해 스위트 간 간섭을 없앤다. (maxWorkers=1 전제)
 */
export async function truncateBusinessData(prisma: PrismaService): Promise<void> {
  const tables = [
    'audit_logs',
    'idempotency_keys',
    'dashboard_task_actions',
    'shared_notes',
    // 진행 단계: journey_stages는 시드이므로 지우지 않고, 거래 데이터만 비운다.
    // 다만 notification_templates TRUNCATE CASCADE가 journey_stages까지 훑으므로
    // 아래에서 seedJourneyStages로 복원한다.
    'journey_events',
    'customer_journeys',
    'notification_history',
    'notification_rules',
    'notification_templates',
    'repair_status_events',
    'repair_requests',
    'rental_selection_lines',
    'rental_selection_sessions',
    'rental_allocation_events',
    'rental_allocations',
    'rental_inventory_status_events',
    'rental_inventory_items',
    'rental_skus',
    'fitting_adjustments',
    'fitting_sessions',
    'production_events',
    'work_order_versions',
    'work_orders',
    'order_item_measurements',
    'measurement_values',
    'measurement_sessions',
    'option_selection_component_attrs',
    'option_selection_values',
    'option_selection_sessions',
    'option_choices',
    'option_stages',
    'option_set_versions',
    'order_item_components',
    'order_items',
    'orders',
    'contract_lines',
    'contract_versions',
    'contracts',
    'consultations',
    'appointments',
    'customers',
    'entity_files',
    'files',
  ];
  // option_sets.active_version_id → option_set_versions 참조 해제 후 삭제
  await prisma.$executeRawUnsafe(`UPDATE option_sets SET active_version_id = NULL`);
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.join(', ')} CASCADE`);
  // CASCADE가 option_set_versions를 참조하는 option_sets(시드)까지 비우므로 복원한다.
  const optionSets: Array<[string, string]> = [
    ['SUIT', '정장 옵션'],
    ['SHIRT', '셔츠 옵션'],
    ['SHOES', '구두 옵션'],
  ];
  for (const [productCategory, name] of optionSets) {
    await prisma.optionSet.upsert({
      where: { productCategory },
      update: { activeVersionId: null },
      create: { id: randomUUID(), productCategory, name },
    });
  }
  // notification_templates CASCADE로 함께 지워진 진행 단계 마스터를 복원한다.
  await seedJourneyStages(prisma);
}
