import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import {
  CancelContractDto,
  ConfirmContractDto,
  ConfirmRevisionDto,
  ContractListQueryDto,
  CreateContractDto,
  CreateRevisionDto,
  SaveSignatureDto,
  UpdateContractDto,
} from './contracts.dto';
import { ContractsService } from './contracts.service';

@Controller('contracts')
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Post()
  @RequirePermission('CONTRACT_CREATE')
  create(@Body() dto: CreateContractDto, @CurrentUser() actor: AuthUser) {
    return this.contracts.create(dto, actor);
  }

  @Get()
  @RequirePermission('CONTRACT_VIEW')
  list(@Query() query: ContractListQueryDto) {
    return this.contracts.list(query);
  }

  @Get(':id')
  @RequirePermission('CONTRACT_VIEW')
  detail(@Param('id') id: string) {
    return this.contracts.getDetail(id);
  }

  @Patch(':id')
  @RequirePermission('CONTRACT_EDIT')
  update(@Param('id') id: string, @Body() dto: UpdateContractDto, @CurrentUser() actor: AuthUser) {
    return this.contracts.update(id, dto, actor);
  }

  @Get(':id/versions')
  @RequirePermission('CONTRACT_VIEW')
  versions(@Param('id') id: string) {
    return this.contracts.getVersions(id);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('CONTRACT_CONFIRM')
  confirm(
    @Param('id') id: string,
    @Body() dto: ConfirmContractDto,
    @CurrentUser() actor: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.contracts.confirm(id, dto, actor, idempotencyKey);
  }

  @Post(':id/revisions')
  @RequirePermission('CONTRACT_REVISE')
  createRevision(@Param('id') id: string, @Body() dto: CreateRevisionDto, @CurrentUser() actor: AuthUser) {
    return this.contracts.createRevision(id, dto, actor);
  }

  @Post(':id/revisions/:revisionId/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('CONTRACT_REVISE')
  confirmRevision(
    @Param('id') id: string,
    @Param('revisionId') revisionId: string,
    @Body() dto: ConfirmRevisionDto,
    @CurrentUser() actor: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.contracts.confirmRevision(id, revisionId, dto, actor, idempotencyKey);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('CONTRACT_CANCEL')
  cancel(@Param('id') id: string, @Body() dto: CancelContractDto, @CurrentUser() actor: AuthUser) {
    return this.contracts.cancel(id, dto, actor);
  }

  @Get(':id/document')
  @RequirePermission('CONTRACT_VIEW')
  document(@Param('id') id: string) {
    return this.contracts.getDocument(id);
  }

  // --- v2 전자서명 (설계서 03 §3) ---

  /** 계약 버전 서명 저장/교체 (DRAFT 한정). PNG dataURL. */
  @Post(':id/versions/:versionId/signature')
  @RequirePermission('CONTRACT_SIGN')
  saveSignature(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() dto: SaveSignatureDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.contracts.saveSignature(id, versionId, dto, actor);
  }

  /** 서명 제거 (다시 받기용, DRAFT 한정) */
  @Delete(':id/versions/:versionId/signature')
  @RequirePermission('CONTRACT_SIGN')
  removeSignature(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.contracts.removeSignature(id, versionId, actor);
  }

  /** 서명 이미지 메타 조회 */
  @Get(':id/versions/:versionId/signature')
  @RequirePermission('CONTRACT_VIEW')
  getSignature(@Param('id') id: string, @Param('versionId') versionId: string) {
    return this.contracts.getSignature(id, versionId);
  }

  // --- v2 계약서 엑셀 출력 (설계서 03 §8) ---

  /** 계약서 엑셀 즉석 생성·다운로드 (서명 이미지 포함, 총액만) */
  @Get(':id/excel')
  @RequirePermission('CONTRACT_VIEW')
  async downloadExcel(
    @Param('id') id: string,
    @CurrentUser() actor: AuthUser,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, fileName } = await this.contracts.buildContractDocumentExcel(id, actor);
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
}
