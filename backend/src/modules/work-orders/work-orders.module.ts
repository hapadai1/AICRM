import { Module } from '@nestjs/common';
import { WorkOrdersController } from './work-orders.controller';
import { WorkOrdersService } from './work-orders.service';

/**
 * 작업지시서 도메인: Excel 출력·버전·스냅샷 (통합설계서 §10, 데이터모델 §10·§15.4).
 * PrismaModule·AuditModule은 전역 모듈이라 별도 import가 필요 없다.
 */
@Module({
  controllers: [WorkOrdersController],
  providers: [WorkOrdersService],
})
export class WorkOrdersModule {}
