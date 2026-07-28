import {
  Body,
  Controller,
  Delete,
  Get,
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
import {
  CreateFittingDto,
  CreateProductionEventDto,
  ProductionItemsQueryDto,
  ReceiveComponentDto,
  ReleaseComponentDto,
} from './production.dto';
import { ProductionService } from './production.service';

/** 제작·구성품 입출고·가봉 (화면·API 정의서 §13.5, PROD-001 / FIT-001) */
@Controller()
export class ProductionController {
  constructor(private readonly productionService: ProductionService) {}

  @Post('order-items/:id/production-events')
  @RequirePermission('PRODUCTION_EDIT')
  createItemEvent(
    @Param('id') id: string,
    @Body() dto: CreateProductionEventDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.productionService.createItemEvent(id, dto, actor);
  }

  @Post('components/:id/status-events')
  @RequirePermission('PRODUCTION_EDIT')
  createComponentEvent(
    @Param('id') id: string,
    @Body() dto: CreateProductionEventDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.productionService.createComponentEvent(id, dto, actor);
  }

  @Post('components/:id/receive')
  @RequirePermission('PRODUCTION_EDIT')
  receiveComponent(
    @Param('id') id: string,
    @Body() dto: ReceiveComponentDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.productionService.receiveComponent(id, dto, actor);
  }

  @Post('components/:id/release')
  @RequirePermission('PRODUCTION_EDIT')
  releaseComponent(
    @Param('id') id: string,
    @Body() dto: ReleaseComponentDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.productionService.releaseComponent(id, dto, actor);
  }

  @Get('orders/:id/production-history')
  @RequirePermission('PRODUCTION_VIEW')
  getOrderProductionHistory(@Param('id') id: string) {
    return this.productionService.getOrderProductionHistory(id);
  }

  @Get('production/items')
  @RequirePermission('PRODUCTION_VIEW')
  listProductionItems(@Query() query: ProductionItemsQueryDto) {
    return this.productionService.listProductionItems(query);
  }

  @Post('order-items/:id/fittings')
  @RequirePermission('FITTING_EDIT')
  createFitting(
    @Param('id') id: string,
    @Body() dto: CreateFittingDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.productionService.createFitting(id, dto, actor);
  }

  @Get('order-items/:id/fittings')
  @RequirePermission('FITTING_VIEW')
  listFittings(@Param('id') id: string) {
    return this.productionService.listFittings(id);
  }

  /**
   * 가봉 수정지시서 Excel 다운로드 (개발설계서 05 G-04).
   * 공장 전달은 이메일 수동 발송이므로 파일만 만들어 준다.
   */
  @Get('fittings/:id/sheet')
  @RequirePermission('FITTING_VIEW')
  async downloadFittingSheet(
    @Param('id') id: string,
    @CurrentUser() actor: AuthUser,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, fileName } = await this.productionService.buildFittingSheet(id, actor);
    const encodedName = encodeURIComponent(fileName);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`,
    );
    res.end(buffer);
  }

  /**
   * 가봉 세션 파일 첨부 (설계서 06 §5.4) — 공장에 보낸 가봉 작업지시서 보관.
   * EntityFile(entityType='FITTING_SESSION', purpose='FACTORY_SENT')로 연결한다.
   */
  @Post('fittings/:id/files')
  @RequirePermission('FITTING_EDIT')
  @UseInterceptors(FileInterceptor('file'))
  uploadFittingFile(
    @Param('id') id: string,
    @UploadedFile() file: UploadedMulterFile | undefined,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.productionService.uploadFittingFile(id, file, actor);
  }

  @Get('fittings/:id/files')
  @RequirePermission('FITTING_VIEW')
  listFittingFiles(@Param('id') id: string) {
    return this.productionService.listFittingFiles(id);
  }

  @Delete('fittings/:id/files/:fileId')
  @RequirePermission('FITTING_EDIT')
  removeFittingFile(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.productionService.removeFittingFile(id, fileId, actor);
  }
}
