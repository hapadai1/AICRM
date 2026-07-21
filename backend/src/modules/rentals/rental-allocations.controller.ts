import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import { RentalAllocationsService } from './rental-allocations.service';
import {
  AllocationListQueryDto,
  ChangeItemDto,
  CheckoutDto,
  CreateAllocationDto,
  RentalOrderComponentsQueryDto,
  ReturnDto,
} from './rentals.dto';

@Controller()
export class RentalAllocationsController {
  constructor(private readonly service: RentalAllocationsService) {}

  /** 출고·반납 대상 목록 뷰 (RENT-004) */
  @Get('rental-allocations')
  @RequirePermission('RENTAL_VIEW')
  list(@Query() query: AllocationListQueryDto) {
    return this.service.list(query);
  }

  /** 배정 대상 렌탈 구성품 + 현재 배정 목록 (RENT-003) */
  @Get('rental-orders/components')
  @RequirePermission('RENTAL_VIEW')
  orderComponents(@Query() query: RentalOrderComponentsQueryDto) {
    return this.service.orderComponents(query);
  }

  @Post('rental-orders/:orderId/allocations')
  @RequirePermission('RENTAL_ALLOCATE')
  allocate(@Param('orderId') orderId: string, @Body() dto: CreateAllocationDto, @CurrentUser() actor: AuthUser) {
    return this.service.allocate(orderId, dto, actor);
  }

  @Post('rental-allocations/:id/change-item')
  @RequirePermission('RENTAL_ALLOCATE')
  changeItem(@Param('id') id: string, @Body() dto: ChangeItemDto, @CurrentUser() actor: AuthUser) {
    return this.service.changeItem(id, dto, actor);
  }

  @Post('rental-allocations/:id/checkout')
  @RequirePermission('RENTAL_CHECKOUT')
  checkout(@Param('id') id: string, @Body() dto: CheckoutDto, @CurrentUser() actor: AuthUser) {
    return this.service.checkout(id, dto, actor);
  }

  @Post('rental-allocations/:id/return')
  @RequirePermission('RENTAL_RETURN')
  return(@Param('id') id: string, @Body() dto: ReturnDto, @CurrentUser() actor: AuthUser) {
    return this.service.return(id, dto, actor);
  }
}
