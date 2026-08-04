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
  CompleteContractDto,
  ContractListQueryDto,
  CreateContractDto,
  CreateRevisionDto,
  SaveSignatureDto,
  SetVestIncludedDto,
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

  /** 계약 삭제 (임시저장·취소 한정, 진행 이력 없을 때) */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('CONTRACT_DELETE')
  remove(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.contracts.remove(id, actor);
  }

  @Get(':id/versions')
  @RequirePermission('CONTRACT_VIEW')
  versions(@Param('id') id: string) {
    return this.contracts.getVersions(id);
  }

  /**
   * 베스트 포함/제외 — 스타일 컨설팅 화면 정장 베스트 행의 [베스트 제외] 체크박스
   * (현업 확정 2026-08-01). 계약서는 베스트를 다루지 않으므로 이 API가 유일한 경로다.
   * 체크(제외)와 해제(재포함)를 한 엔드포인트로 왕복한다. 작성중(DRAFT) 한정.
   *
   * 금액은 건드리지 않는다 — 베스트 값이 그때그때 달라 계약서에서 수기로 조정한다.
   * (이미 계약금액에 반영한 베스트 **옵션 추가금**은 제외 시 자동으로 되돌린다.)
   */
  @Post('items/:itemId/vest')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('CONTRACT_EDIT')
  setVest(
    @Param('itemId') itemId: string,
    @Body() dto: SetVestIncludedDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.contracts.setVestIncluded(itemId, dto.included, actor);
  }

  /**
   * 수정하기(버전업) — 완료된 계약서를 새 버전으로 복사하고 작성중으로 되돌린다.
   * 품목·컨설팅·주문·작업지시서·입출고는 계약에 매달려 있어 그대로 이어진다.
   */
  @Post(':id/revisions')
  @RequirePermission('CONTRACT_REVISE')
  createRevision(@Param('id') id: string, @Body() dto: CreateRevisionDto, @CurrentUser() actor: AuthUser) {
    return this.contracts.createRevision(id, dto, actor);
  }

  /**
   * 계약 완료 (현업 확정 2026-07-30). 서명완료 계약만 완료할 수 있다.
   * 여기서 주문·주문품목·고객 전환·진행단계를 물리화하고, 완료 시점 계약서 엑셀을 보관한다.
   */
  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('CONTRACT_CONFIRM')
  complete(
    @Param('id') id: string,
    @Body() dto: CompleteContractDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.contracts.complete(id, dto, actor);
  }

  /** 계약 흐름 게이팅 — 컨설팅 확정 여부·서명 여부·완료 가능 여부 */
  @Get(':id/flow')
  @RequirePermission('CONTRACT_VIEW')
  flow(@Param('id') id: string) {
    return this.contracts.getFlow(id);
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
