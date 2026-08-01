import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import { RentalInventoryService } from './rental-inventory.service';
import {
  AvailabilityCalendarQueryDto,
  AvailabilityQueryDto,
  CreateInventoryDto,
  CreateStatusEventDto,
  ImportInventoryDto,
  InventoryListQueryDto,
  RetireInventoryDto,
  RetireQuantityDto,
  StatusQuantityDto,
  UpdateInventoryDto,
} from './rentals.dto';

@Controller('rental-inventory')
export class RentalInventoryController {
  constructor(private readonly service: RentalInventoryService) {}

  /** :id 라우트보다 먼저 선언해야 한다. */
  @Get('availability')
  @RequirePermission('RENTAL_ALLOCATE')
  availability(@Query() query: AvailabilityQueryDto) {
    return this.service.availability(query);
  }

  /** 렌탈예약 달력 — 기간 내 일자별 가용 집계 (설계서 06 §4). :id 라우트보다 먼저 선언. */
  @Get('availability-calendar')
  @RequirePermission('RENTAL_VIEW')
  availabilityCalendar(@Query() query: AvailabilityCalendarQueryDto) {
    return this.service.availabilityCalendar(query);
  }

  /** 품목 대분류별 건수 (재고 화면 상단 버튼). ':id'보다 먼저 선언해야 경로가 안 먹힌다. */
  @Get('summary')
  @RequirePermission('RENTAL_VIEW')
  summary(@Query() query: InventoryListQueryDto) {
    return this.service.summary(query);
  }

  /** SKU별 수량 집계 (재고 화면 기본 뷰). ':id'보다 먼저 선언해야 경로가 안 먹힌다. */
  @Get('sku-summary')
  @RequirePermission('RENTAL_VIEW')
  skuSummary(@Query() query: InventoryListQueryDto) {
    return this.service.skuSummary(query);
  }

  /** SKU 단위 수량 폐기·상태 변경. ':id'보다 먼저 선언해야 경로가 안 먹힌다. */
  @Post('retire-quantity')
  @RequirePermission('RENTAL_EDIT')
  retireQuantity(@Body() dto: RetireQuantityDto, @CurrentUser() actor: AuthUser) {
    return this.service.retireQuantity(dto, actor);
  }

  @Post('status-quantity')
  @RequirePermission('RENTAL_EDIT')
  changeStatusQuantity(@Body() dto: StatusQuantityDto, @CurrentUser() actor: AuthUser) {
    return this.service.changeStatusQuantity(dto, actor);
  }

  @Get()
  @RequirePermission('RENTAL_VIEW')
  list(@Query() query: InventoryListQueryDto) {
    return this.service.list(query);
  }

  @Post()
  @RequirePermission('RENTAL_EDIT')
  create(@Body() dto: CreateInventoryDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor);
  }

  @Post('import')
  @RequirePermission('RENTAL_EDIT')
  import(@Body() dto: ImportInventoryDto, @CurrentUser() actor: AuthUser) {
    return this.service.import(dto, actor);
  }

  @Get(':id')
  @RequirePermission('RENTAL_VIEW')
  detail(@Param('id') id: string) {
    return this.service.detail(id);
  }

  @Patch(':id')
  @RequirePermission('RENTAL_EDIT')
  update(@Param('id') id: string, @Body() dto: UpdateInventoryDto, @CurrentUser() actor: AuthUser) {
    return this.service.update(id, dto, actor);
  }

  @Post(':id/status-events')
  @RequirePermission('RENTAL_STATUS_EDIT')
  createStatusEvent(@Param('id') id: string, @Body() dto: CreateStatusEventDto, @CurrentUser() actor: AuthUser) {
    return this.service.createStatusEvent(id, dto, actor);
  }

  @Post(':id/retire')
  @RequirePermission('RENTAL_EDIT')
  retire(@Param('id') id: string, @Body() dto: RetireInventoryDto, @CurrentUser() actor: AuthUser) {
    return this.service.retire(id, dto, actor);
  }
}
