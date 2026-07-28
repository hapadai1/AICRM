import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import { OptionMasterService } from './option-master.service';
import {
  ActivateOptionSetVersionDto,
  ActiveOptionSetQueryDto,
  CreateOptionSetVersionDto,
  SaveOptionStagesDto,
  UpdateOptionChoicePriceDto,
} from './options.dto';

/** 옵션 마스터 관리 (ADMIN-002, 화면·API 정의서 §13.8) */
@Controller()
export class OptionMasterController {
  constructor(private readonly service: OptionMasterService) {}

  /** 활성 옵션 세트 조회는 선택 화면(OPT-002)에서 사용 → OPTION_SELECT (§13.4) */
  @Get('option-sets/active')
  @RequirePermission('OPTION_SELECT')
  getActive(@Query() query: ActiveOptionSetQueryDto) {
    return this.service.getActiveSet(query.category);
  }

  @Get('option-sets')
  @RequirePermission('OPTION_MASTER_EDIT')
  listSets() {
    return this.service.listSets();
  }

  @Post('option-sets/:id/versions')
  @RequirePermission('OPTION_MASTER_EDIT')
  createVersion(
    @Param('id') id: string,
    @Body() dto: CreateOptionSetVersionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.createVersion(id, dto, actor);
  }

  @Get('option-set-versions/:id')
  @RequirePermission('OPTION_MASTER_EDIT')
  getVersion(@Param('id') id: string) {
    return this.service.getVersionDetail(id);
  }

  @Put('option-set-versions/:id/stages')
  @RequirePermission('OPTION_MASTER_EDIT')
  saveStages(
    @Param('id') id: string,
    @Body() dto: SaveOptionStagesDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.saveStages(id, dto, actor);
  }

  @Post('option-set-versions/:id/activate')
  @RequirePermission('OPTION_MASTER_EDIT')
  activate(
    @Param('id') id: string,
    @Body() dto: ActivateOptionSetVersionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.activate(id, dto, actor);
  }

  /**
   * 선택지 추가금액만 수정 — 사용중 버전에서도 허용한다(새 버전 강제하지 않음).
   * 확정된 계약은 선택 시점 스냅샷을 쓰므로 소급 변경되지 않고, 이력은 감사로그에 남는다.
   */
  @Patch('option-choices/:id/price')
  @RequirePermission('OPTION_MASTER_EDIT')
  updateChoicePrice(
    @Param('id') id: string,
    @Body() dto: UpdateOptionChoicePriceDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.updateChoicePrice(id, dto, actor);
  }
}
