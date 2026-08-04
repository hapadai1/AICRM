import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { RentalAllocationsController } from './rental-allocations.controller';
import { RentalAllocationsService } from './rental-allocations.service';
import { RentalInventoryController } from './rental-inventory.controller';
import { RentalInventoryService } from './rental-inventory.service';
import { RentalNotesService } from './rental-notes.service';
import { RentalPolicyController } from './rental-policy.controller';
import { RentalPolicyService } from './rental-policy.service';
import { RentalReleaseScheduler } from './rental-release.scheduler';
import { RentalSelectionController } from './rental-selection.controller';
import { RentalSelectionService } from './rental-selection.service';

/** 렌탈 실물 재고·기간 배정·출고·반납·스타일 선택 (Phase 5 / v2 D3) */
@Module({
  // 고객 연락 문구 제안을 함께 쓴다 (진행 단계·수선과 같은 경로).
  imports: [NotificationsModule],
  controllers: [
    RentalInventoryController,
    RentalAllocationsController,
    RentalSelectionController,
    RentalPolicyController,
  ],
  providers: [
    RentalInventoryService,
    RentalAllocationsService,
    RentalSelectionService,
    RentalPolicyService,
    RentalNotesService,
    RentalReleaseScheduler,
  ],
})
export class RentalsModule {}
