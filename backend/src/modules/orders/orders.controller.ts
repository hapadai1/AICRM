import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import { AddComponentDto, UpdateComponentDto } from './orders.dto';
import { OrdersService } from './orders.service';

/**
 * 주문 조회·구성품 관리 엔드포인트.
 * 품목 수량을 변경하는 주문 경로 API는 제공하지 않는다 — 수량 증감은 계약 변경으로만 가능(ORDER_ITEM_COUNT_LOCKED).
 */
@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get('orders/:id')
  @RequirePermission('ORDER_VIEW')
  getOrder(@Param('id') id: string) {
    return this.orders.getOrder(id);
  }

  @Get('orders/:id/items')
  @RequirePermission('ORDER_VIEW')
  getItems(@Param('id') id: string) {
    return this.orders.getItems(id);
  }

  @Post('order-items/:id/components')
  @RequirePermission('ORDER_EDIT')
  addComponent(@Param('id') id: string, @Body() dto: AddComponentDto, @CurrentUser() actor: AuthUser) {
    return this.orders.addComponent(id, dto, actor);
  }

  @Patch('components/:id')
  @RequirePermission('ORDER_EDIT')
  updateComponent(@Param('id') id: string, @Body() dto: UpdateComponentDto, @CurrentUser() actor: AuthUser) {
    return this.orders.updateComponent(id, dto, actor);
  }
}
