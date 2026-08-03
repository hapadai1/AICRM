import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import {
  CreateRepairDto,
  CreateRepairStatusEventDto,
  ListRepairsQueryDto,
  RepairProgressDto,
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

  /** 건 단위 상태 변경 — 고객 연락(과 되돌리기)만 여기로 온다. */
  @Post(':id/status-events')
  @RequirePermission('REPAIR_EDIT')
  createStatusEvent(
    @Param('id') id: string,
    @Body() dto: CreateRepairStatusEventDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.repairsService.createStatusEvent(id, dto, actor);
  }

  /** 수선요청 완료 (접수 줄 단위) */
  @Post(':id/items/:itemId/request')
  @RequirePermission('REPAIR_EDIT')
  requestItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: RepairProgressDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.repairsService.requestItem(id, itemId, dto, actor);
  }

  @Delete(':id/items/:itemId/request')
  @RequirePermission('REPAIR_EDIT')
  revertItemRequest(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.repairsService.revertItemRequest(id, itemId, actor);
  }

  /** 입고 (벌 단위) */
  @Post(':id/units/:unitId/return')
  @RequirePermission('REPAIR_EDIT')
  returnUnit(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Body() dto: RepairProgressDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.repairsService.advanceUnit(id, unitId, 'RETURNED', dto, actor);
  }

  /** 출고 (벌 단위) — 입고된 벌은 건 전체가 끝나기 전에도 내줄 수 있다. */
  @Post(':id/units/:unitId/release')
  @RequirePermission('REPAIR_EDIT')
  releaseUnit(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Body() dto: RepairProgressDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.repairsService.advanceUnit(id, unitId, 'RELEASED', dto, actor);
  }

  /** 벌 진행 한 칸 되돌리기 (출고 완료→입고 완료→대기) */
  @Delete(':id/units/:unitId/status')
  @RequirePermission('REPAIR_EDIT')
  revertUnit(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.repairsService.revertUnit(id, unitId, actor);
  }
}
