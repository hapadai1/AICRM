import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import {
  CreateRepairDto,
  CreateRepairStatusEventDto,
  ListRepairsQueryDto,
  UpdateRepairDto,
} from './repairs.dto';
import { RepairsService } from './repairs.service';

/** 수선 접수·진행 (화면·API 정의서 §13.7, REPAIR-001) */
@Controller('repairs')
export class RepairsController {
  constructor(private readonly repairsService: RepairsService) {}

  @Get()
  @RequirePermission('REPAIR_VIEW')
  list(@Query() query: ListRepairsQueryDto) {
    return this.repairsService.list(query);
  }

  @Post()
  @RequirePermission('REPAIR_EDIT')
  create(@Body() dto: CreateRepairDto, @CurrentUser() actor: AuthUser) {
    return this.repairsService.create(dto, actor);
  }

  @Get(':id')
  @RequirePermission('REPAIR_VIEW')
  get(@Param('id') id: string) {
    return this.repairsService.get(id);
  }

  @Patch(':id')
  @RequirePermission('REPAIR_EDIT')
  update(@Param('id') id: string, @Body() dto: UpdateRepairDto, @CurrentUser() actor: AuthUser) {
    return this.repairsService.update(id, dto, actor);
  }

  @Post(':id/status-events')
  @RequirePermission('REPAIR_EDIT')
  createStatusEvent(
    @Param('id') id: string,
    @Body() dto: CreateRepairStatusEventDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.repairsService.createStatusEvent(id, dto, actor);
  }
}
