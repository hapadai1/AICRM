import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import {
  CancelContractDto,
  ConfirmContractDto,
  ConfirmRevisionDto,
  ContractListQueryDto,
  CreateContractDto,
  CreateRevisionDto,
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
}
