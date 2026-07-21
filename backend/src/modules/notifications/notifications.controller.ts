import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import {
  CreateTemplateDto,
  PreviewNotificationDto,
  SendNotificationDto,
  UpdateRuleDto,
  UpdateTemplateDto,
} from './notifications.dto';
import { NotificationsService } from './notifications.service';

/** 알림톡/SMS 템플릿·발송 API — 화면·API 정의서 13.7 (MSG-001) */
@Controller()
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get('notification-templates')
  // 목록 조회는 발송 화면에서도 필요하므로 조회 권한만 요구한다(마스터 편집은 생성·수정에만).
  @RequirePermission('NOTIFICATION_VIEW')
  listTemplates() {
    return this.notificationsService.listTemplates();
  }

  @Post('notification-templates')
  @RequirePermission('ADMIN_MASTER_EDIT')
  createTemplate(@Body() dto: CreateTemplateDto, @CurrentUser() actor: AuthUser) {
    return this.notificationsService.createTemplate(dto, actor);
  }

  @Patch('notification-templates/:id')
  @RequirePermission('ADMIN_MASTER_EDIT')
  updateTemplate(@Param('id') id: string, @Body() dto: UpdateTemplateDto, @CurrentUser() actor: AuthUser) {
    return this.notificationsService.updateTemplate(id, dto, actor);
  }

  /** 트리거별 문구 매핑 (수선 상태 등) */
  @Get('notification-rules')
  @RequirePermission('NOTIFICATION_VIEW')
  listRules() {
    return this.notificationsService.listRules();
  }

  @Patch('notification-rules/:id')
  @RequirePermission('ADMIN_MASTER_EDIT')
  updateRule(@Param('id') id: string, @Body() dto: UpdateRuleDto, @CurrentUser() actor: AuthUser) {
    return this.notificationsService.updateRule(id, dto, actor);
  }

  @Post('notifications/preview')
  @RequirePermission('NOTIFICATION_SEND')
  preview(@Body() dto: PreviewNotificationDto) {
    return this.notificationsService.preview(dto);
  }

  @Post('notifications/send')
  @RequirePermission('NOTIFICATION_SEND')
  send(@Body() dto: SendNotificationDto, @CurrentUser() actor: AuthUser) {
    return this.notificationsService.send(dto, actor);
  }

  @Post('notifications/:id/retry')
  @RequirePermission('NOTIFICATION_SEND')
  retry(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.notificationsService.retry(id, actor);
  }

  @Get('customers/:id/notifications')
  @RequirePermission('NOTIFICATION_VIEW')
  listByCustomer(@Param('id') customerId: string) {
    return this.notificationsService.listByCustomer(customerId);
  }
}
