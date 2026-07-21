import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import { RentalInventoryService } from './rental-inventory.service';
import {
  AvailabilityQueryDto,
  CreateInventoryDto,
  CreateStatusEventDto,
  ImportInventoryDto,
  InventoryListQueryDto,
  RetireInventoryDto,
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
