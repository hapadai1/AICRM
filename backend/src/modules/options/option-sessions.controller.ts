import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import { OptionSessionsService } from './option-sessions.service';
import {
  ConfirmSessionDto,
  CopySessionDto,
  PauseSessionDto,
  SaveStageSelectionDto,
  StartOptionSessionDto,
} from './options.dto';

/** 옵션 선택 세션 (OPT-001~003, 화면·API 정의서 §13.4) */
@Controller()
@RequirePermission('OPTION_SELECT')
export class OptionSessionsController {
  constructor(private readonly service: OptionSessionsService) {}

  /** 맞춤 품목별 옵션 진행 현황 (:id 라우트와 세그먼트 수가 달라 충돌 없음). contractId 지정 시 해당 계약으로 한정 */
  @Get('order-items/option-progress')
  progress(@Query('contractId') contractId?: string) {
    return this.service.progress(contractId);
  }

  /** 품목의 현재(is_current) 옵션 세션 상세 — 없으면 { session: null } */
  @Get('order-items/:id/option-session')
  currentSession(@Param('id') orderItemId: string) {
    return this.service.currentSession(orderItemId);
  }

  @Post('order-items/:id/option-sessions')
  start(
    @Param('id') orderItemId: string,
    @Body() dto: StartOptionSessionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.start(orderItemId, dto, actor);
  }

  @Get('option-sessions/:id')
  detail(@Param('id') id: string) {
    return this.service.detail(id);
  }

  @Get('option-sessions/:id/resume')
  resume(@Param('id') id: string) {
    return this.service.resume(id);
  }

  @Put('option-sessions/:id/stages/:stageId')
  saveStage(
    @Param('id') id: string,
    @Param('stageId') stageId: string,
    @Body() dto: SaveStageSelectionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.saveStage(id, stageId, dto, actor);
  }

  @Post('option-sessions/:id/pause')
  @HttpCode(HttpStatus.OK)
  pause(@Param('id') id: string, @Body() dto: PauseSessionDto) {
    return this.service.pause(id, dto);
  }

  @Get('option-sessions/:id/review')
  review(@Param('id') id: string) {
    return this.service.review(id);
  }

  @Post('option-sessions/:id/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(@Param('id') id: string, @Body() dto: ConfirmSessionDto, @CurrentUser() actor: AuthUser) {
    return this.service.confirm(id, dto, actor);
  }

  /** 옵션 추가금액과 계약금액 차액 조회 */
  @Get('option-sessions/:id/surcharge')
  surcharge(@Param('id') id: string) {
    return this.service.surcharge(id);
  }

  /** 미반영 차액을 계약 현재 버전 금액에 반영 (계약 버전은 올리지 않는다) */
  @Post('option-sessions/:id/surcharge/apply')
  @HttpCode(HttpStatus.OK)
  applySurcharge(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.service.applySurcharge(id, actor);
  }

  @Post('option-sessions/:id/copy')
  copy(@Param('id') id: string, @Body() dto: CopySessionDto, @CurrentUser() actor: AuthUser) {
    return this.service.copy(id, dto, actor);
  }
}
