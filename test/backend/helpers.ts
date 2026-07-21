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
    'payments',
    'repair_status_events',
    'repair_requests',
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
