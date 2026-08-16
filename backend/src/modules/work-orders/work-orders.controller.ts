import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import { UploadedMulterFile } from '../files/files.service';
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

  /*
    출력 이력(GET /work-orders/:id/versions)은 없앴다 (현업 확정 2026-08-05) —
    작업지시서는 품목당 파일 하나이고 다시 뽑으면 덮어쓴다. 이력은 감사로그에 남는다.
  */

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

  /**
   * WO-002 양식 미리보기 (HTML) — 출력 전 실제 양식 모습 확인.
   * 버전·파일을 만들지 않으므로 몇 번을 봐도 이력이 늘지 않는다.
   */
  @Get('order-items/:id/work-order/form-preview')
  @RequirePermission('WORK_ORDER_VIEW')
  formPreview(
    @Param('id') orderItemId: string,
    @Query('measurementSessionId') measurementSessionId?: string,
  ) {
    return this.workOrdersService.formPreview(orderItemId, measurementSessionId || undefined);
  }

  /** WO-002 Excel 출력 — 품목당 파일 하나를 만들고, 다시 뽑으면 덮어쓴다 (Idempotency-Key 지원) */
  @Post('order-items/:id/work-order')
  @RequirePermission('WORK_ORDER_ISSUE')
  issue(
    @Param('id') orderItemId: string,
    @Body() dto: IssueWorkOrderVersionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.workOrdersService.issue(orderItemId, dto, idempotencyKey, actor);
  }

  /**
   * 작업지시서 파일 다운로드 (스트리밍). variant로 어느 파일인지 명시한다.
   * - variant=output: 시스템 출력본, variant=final: 수기 최종본, 미지정: 최종본 우선(구버전 호환)
   */
  @Get('work-orders/:id/file')
  @RequirePermission('WORK_ORDER_VIEW')
  downloadFile(
    @Param('id') workOrderId: string,
    @Res() res: Response,
    @Query('variant') variant?: string,
  ) {
    const v = variant === 'output' || variant === 'final' ? variant : undefined;
    return this.workOrdersService.streamFile(workOrderId, res, v);
  }

  /**
   * 시스템 작업지시서 다운로드 — 품목 id로 받는다.
   * 발주 전이면 그 시점 값으로 즉석 생성해 주고, 발주 후면 고정 출력본을 준다.
   */
  @Get('order-items/:id/work-order/file')
  @RequirePermission('WORK_ORDER_VIEW')
  downloadSystemFile(@Param('id') orderItemId: string, @Res() res: Response) {
    return this.workOrdersService.streamSystemFile(orderItemId, res);
  }

  /** 최종 작업지시서(업로드본) 팝업 미리보기 HTML. xlsx만 그리고, 아니면 renderable:false. */
  @Get('work-orders/:id/uploaded-preview')
  @RequirePermission('WORK_ORDER_VIEW')
  uploadedPreview(@Param('id') workOrderId: string) {
    return this.workOrdersService.uploadedPreview(workOrderId);
  }

  /**
   * 수기 최종본 올리기 (현업 확정 2026-08-05).
   * 시스템 출력본을 손으로 고쳐 공장에 보낸 파일을 **보관만** 한다 — 열어서 값을 꺼내지 않는다.
   */
  @Post('work-orders/:id/upload')
  @RequirePermission('WORK_ORDER_ISSUE')
  @UseInterceptors(FileInterceptor('file'))
  uploadFinalFile(
    @Param('id') workOrderId: string,
    @UploadedFile() file: UploadedMulterFile | undefined,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.workOrdersService.uploadFinalFile(workOrderId, file, actor);
  }

  /** 잘못 올린 최종본 내리기 */
  @Delete('work-orders/:id/upload')
  @RequirePermission('WORK_ORDER_ISSUE')
  removeFinalFile(@Param('id') workOrderId: string, @CurrentUser() actor: AuthUser) {
    return this.workOrdersService.removeFinalFile(workOrderId, actor);
  }
}
