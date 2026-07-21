import { Module } from '@nestjs/common';
import { RentalAllocationsController } from './rental-allocations.controller';
import { RentalAllocationsService } from './rental-allocations.service';
import { RentalInventoryController } from './rental-inventory.controller';
import { RentalInventoryService } from './rental-inventory.service';

/** 렌탈 실물 재고·기간 배정·출고·반납 (Phase 5) */
@Module({
  controllers: [RentalInventoryController, RentalAllocationsController],
  providers: [RentalInventoryService, RentalAllocationsService],
})
export class RentalsModule {}
