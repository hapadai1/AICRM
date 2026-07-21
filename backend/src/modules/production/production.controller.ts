import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import {
  CreateFittingDto,
  CreateProductionEventDto,
  ProductionItemsQueryDto,
  ReceiveComponentDto,
  ReleaseComponentDto,
} from './production.dto';
import { ProductionService } from './production.service';

/** 제작·구성품 입출고·가봉 (화면·API 정의서 §13.5, PROD-001 / FIT-001) */
@Controller()
export class ProductionController {
  constructor(private readonly productionService: ProductionService) {}

  @Post('order-items/:id/production-events')
  @RequirePermission('PRODUCTION_EDIT')
  createItemEvent(
    @Param('id') id: string,
    @Body() dto: CreateProductionEventDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.productionService.createItemEvent(id, dto, actor);
  }

  @Post('components/:id/status-events')
  @RequirePermission('PRODUCTION_EDIT')
  createComponentEvent(
    @Param('id') id: string,
    @Body() dto: CreateProductionEventDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.productionService.createComponentEvent(id, dto, actor);
  }

  @Post('components/:id/receive')
  @RequirePermission('PRODUCTION_EDIT')
  receiveComponent(
    @Param('id') id: string,
    @Body() dto: ReceiveComponentDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.productionService.receiveComponent(id, dto, actor);
  }

  @Post('components/:id/release')
  @RequirePermission('PRODUCTION_EDIT')
  releaseComponent(
    @Param('id') id: string,
    @Body() dto: ReleaseComponentDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.productionService.releaseComponent(id, dto, actor);
  }

  @Get('orders/:id/production-history')
  @RequirePermission('PRODUCTION_VIEW')
  getOrderProductionHistory(@Param('id') id: string) {
    return this.productionService.getOrderProductionHistory(id);
  }

  @Get('production/items')
  @RequirePermission('PRODUCTION_VIEW')
  listProductionItems(@Query() query: ProductionItemsQueryDto) {
    return this.productionService.listProductionItems(query);
  }

  @Post('order-items/:id/fittings')
  @RequirePermission('FITTING_EDIT')
  createFitting(
    @Param('id') id: string,
    @Body() dto: CreateFittingDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.productionService.createFitting(id, dto, actor);
  }

  @Get('order-items/:id/fittings')
  @RequirePermission('FITTING_VIEW')
  listFittings(@Param('id') id: string) {
    return this.productionService.listFittings(id);
  }
}
