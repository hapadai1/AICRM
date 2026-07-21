import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import {
  ChangeStageDto,
  CloseJourneyDto,
  CreateJourneyDto,
  ListJourneysQueryDto,
  ListStagesQueryDto,
  NotificationOutcomeDto,
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

  /** 단계별 연락 문구 매핑 변경 (관리자) */
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

  /** 단계 변경 — 응답의 suggestedNotification이 발송 확인창의 재료가 된다. */
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
