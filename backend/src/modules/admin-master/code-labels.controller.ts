import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import { UpdateCodeLabelDto } from './code-labels.dto';
import { CodeLabelsService } from './code-labels.service';

@Controller()
export class CodeLabelsController {
  constructor(private readonly codeLabelsService: CodeLabelsService) {}

  /** 앱 전역 표시명 하이드레이션용 — 인증된 사용자 누구나 조회 가능. */
  @Get('code-labels')
  listAll() {
    return this.codeLabelsService.listAll();
  }

  /** 표시명 수정 (코드 상수 기준정보) — 기준정보 편집 권한 필요. */
  @Put('admin/code-labels/:domain/:code')
  @RequirePermission('ADMIN_MASTER_EDIT')
  update(
    @Param('domain') domain: string,
    @Param('code') code: string,
    @Body() dto: UpdateCodeLabelDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.codeLabelsService.update(domain, code, dto.label, actor);
  }
}
