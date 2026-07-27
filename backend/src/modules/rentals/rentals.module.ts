import { Module } from '@nestjs/common';
import { RentalAllocationsController } from './rental-allocations.controller';
import { RentalAllocationsService } from './rental-allocations.service';
import { RentalInventoryController } from './rental-inventory.controller';
import { RentalInventoryService } from './rental-inventory.service';
import { RentalSelectionController } from './rental-selection.controller';
import { RentalSelectionService } from './rental-selection.service';

/** 렌탈 실물 재고·기간 배정·출고·반납·스타일 선택 (Phase 5 / v2 D3) */
@Module({
  controllers: [
    RentalInventoryController,
    RentalAllocationsController,
    RentalSelectionController,
  ],
  providers: [RentalInventoryService, RentalAllocationsService, RentalSelectionService],
})
export class RentalsModule {}
