import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import {
  ChangeStageDto,
  CloseJourneyDto,
  CompleteItemDto,
  CreateJourneyDto,
  ListJourneysQueryDto,
  ListStagesQueryDto,
  NotificationOutcomeDto,
  PutStageMessageDto,
  UpdateStageTemplateDto,
} from './journeys.dto';
import { JourneysService } from './journeys.service';

/**
 * 고객 진행 단계 (개발설계서 05 G-11).
 * 조회는 CUSTOMER_VIEW, 변경은 JOURNEY_EDIT.
 */
@Controller()
export class JourneysController {
  constructor(private readonly journeysService: JourneysService) {}

  @Get('journey-stages')
  @RequirePermission('CUSTOMER_VIEW')
  listStages(@Query() query: ListStagesQueryDto) {
    return this.journeysService.listStages(query);
  }

  /** 그 시점에 보낼 문구를 쓴다 — 없으면 만들고, 있으면 고친다 (관리자) */
  @Put('journey-stages/:id/message')
  @RequirePermission('ADMIN_MASTER_EDIT')
  putStageMessage(
    @Param('id') id: string,
    @Body() dto: PutStageMessageDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.journeysService.putStageMessage(id, dto, actor);
  }

  /** 그 시점의 연락을 끈다 — 문구까지 지운다(발송 이력은 남는다) (관리자) */
  @Delete('journey-stages/:id/message')
  @RequirePermission('ADMIN_MASTER_EDIT')
  deleteStageMessage(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.journeysService.deleteStageMessage(id, actor);
  }

  /** 단계 ↔ 기존 문구 매핑 변경 (관리자). 화면은 위 message 경로를 쓴다. */
  @Patch('journey-stages/:id')
  @RequirePermission('ADMIN_MASTER_EDIT')
  updateStageTemplate(
    @Param('id') id: string,
    @Body() dto: UpdateStageTemplateDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.journeysService.updateStageTemplate(id, dto.templateId ?? null, actor);
  }

  @Get('journeys')
  @RequirePermission('CUSTOMER_VIEW')
  list(@Query() query: ListJourneysQueryDto) {
    return this.journeysService.list(query);
  }

  @Get('customers/:customerId/journeys')
  @RequirePermission('CUSTOMER_VIEW')
  listByCustomer(@Param('customerId') customerId: string) {
    return this.journeysService.listByCustomer(customerId);
  }

  @Post('customers/:customerId/journeys')
  @RequirePermission('JOURNEY_EDIT')
  create(
    @Param('customerId') customerId: string,
    @Body() dto: CreateJourneyDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.journeysService.create(customerId, dto, actor);
  }

  @Get('journeys/:id')
  @RequirePermission('CUSTOMER_VIEW')
  get(@Param('id') id: string) {
    return this.journeysService.get(id);
  }

  /** 단계 대상 품목 + 완료상태 + 게이팅 (v2) */
  @Get('journeys/:id/stages/:stageCode/items')
  @RequirePermission('CUSTOMER_VIEW')
  getStageItems(@Param('id') id: string, @Param('stageCode') stageCode: string) {
    return this.journeysService.getStageItems(id, stageCode);
  }

  /** 품목 완료(수동 버튼, 멱등) — 전 품목 완료 시 [전체 완료] 활성 (v2 D2) */
  @Post('journeys/:id/stages/:stageCode/items/:targetId/complete')
  @RequirePermission('JOURNEY_EDIT')
  completeItem(
    @Param('id') id: string,
    @Param('stageCode') stageCode: string,
    @Param('targetId') targetId: string,
    @Body() dto: CompleteItemDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.journeysService.completeItem(id, stageCode, targetId, dto, actor);
  }

  /** 품목 완료 취소 */
  @Post('journeys/:id/stages/:stageCode/items/:targetId/uncomplete')
  @RequirePermission('JOURNEY_EDIT')
  uncompleteItem(
    @Param('id') id: string,
    @Param('stageCode') stageCode: string,
    @Param('targetId') targetId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.journeysService.uncompleteItem(id, stageCode, targetId, actor);
  }

  /**
   * 단계 변경([전체 완료]) — GATED 단계는 전 품목 완료 시에만 전진 가능(422).
   * 응답의 suggestedNotification이 발송 확인창의 재료가 된다.
   */
  @Post('journeys/:id/stage')
  @RequirePermission('JOURNEY_EDIT')
  changeStage(
    @Param('id') id: string,
    @Body() dto: ChangeStageDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.journeysService.changeStage(id, dto, actor);
  }

  /** 발송 확인창 처리 결과 회신 (발송/나중에/안 보냄) */
  @Post('journeys/:id/events/:eventId/notification-outcome')
  @RequirePermission('JOURNEY_EDIT')
  setNotificationOutcome(
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @Body() dto: NotificationOutcomeDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.journeysService.setNotificationOutcome(id, eventId, dto, actor);
  }

  @Post('journeys/:id/complete')
  @RequirePermission('JOURNEY_EDIT')
  complete(@Param('id') id: string, @Body() dto: CloseJourneyDto, @CurrentUser() actor: AuthUser) {
    return this.journeysService.close(id, 'COMPLETED', dto, actor);
  }

  @Post('journeys/:id/cancel')
  @RequirePermission('JOURNEY_EDIT')
  cancel(@Param('id') id: string, @Body() dto: CloseJourneyDto, @CurrentUser() actor: AuthUser) {
    return this.journeysService.close(id, 'CANCELLED', dto, actor);
  }
}
