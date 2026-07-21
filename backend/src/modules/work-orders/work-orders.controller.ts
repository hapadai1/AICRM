import { Body, Controller, Get, Headers, Param, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import { IssueWorkOrderVersionDto, WorkOrderListQueryDto } from './work-orders.dto';
import { WorkOrdersService } from './work-orders.service';

@Controller()
export class WorkOrdersController {
  constructor(private readonly workOrdersService: WorkOrdersService) {}

  /** WO-001 작업지시서 목록·상태 (미주문/재출력 필요/최신 판정 포함) */
  @Get('work-orders')
  @RequirePermission('WORK_ORDER_VIEW')
  list(@Query() query: WorkOrderListQueryDto) {
    return this.workOrdersService.list(query);
  }

  /** WO-001 작업지시서 상세 */
  @Get('work-orders/:id')
  @RequirePermission('WORK_ORDER_VIEW')
  detail(@Param('id') id: string) {
    return this.workOrdersService.detail(id);
  }

  /** WO-002 출력 이력 */
  @Get('work-orders/:id/versions')
  @RequirePermission('WORK_ORDER_VIEW')
  versions(@Param('id') id: string) {
    return this.workOrdersService.versions(id);
  }

  /**
   * WO-002 작업지시서 미리보기 (확정 옵션·채촌 표 데이터).
   * measurementSessionId를 주면 해당 채촌 버전으로 미리본다.
   */
  @Get('order-items/:id/work-order/preview')
  @RequirePermission('WORK_ORDER_VIEW')
  preview(
    @Param('id') orderItemId: string,
    @Query('measurementSessionId') measurementSessionId?: string,
  ) {
    return this.workOrdersService.preview(orderItemId, measurementSessionId || undefined);
  }

  /** WO-002 Excel 출력·버전 생성 (Idempotency-Key 지원) */
  @Post('order-items/:id/work-order-versions')
  @RequirePermission('WORK_ORDER_ISSUE')
  issue(
    @Param('id') orderItemId: string,
    @Body() dto: IssueWorkOrderVersionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.workOrdersService.issue(orderItemId, dto, idempotencyKey, actor);
  }

  /** 저장된 Excel 다운로드 (스트리밍) */
  @Get('work-order-versions/:id/file')
  @RequirePermission('WORK_ORDER_VIEW')
  downloadFile(@Param('id') versionId: string, @Res() res: Response) {
    return this.workOrdersService.streamFile(versionId, res);
  }
}
