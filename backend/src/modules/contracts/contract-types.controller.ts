import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import {
  CloneContractTypeDto,
  ContractTypeListQueryDto,
  CreateContractTypeDto,
  UpdateContractTypeDto,
} from './contract-types.dto';
import { ContractTypesService } from './contract-types.service';

@Controller('contract-types')
export class ContractTypesController {
  constructor(private readonly contractTypes: ContractTypesService) {}

  @Get()
  @RequirePermission('CONTRACT_VIEW')
  list(@Query() query: ContractTypeListQueryDto) {
    return this.contractTypes.list(query.active === 'true');
  }

  @Post()
  @RequirePermission('CONTRACT_TYPE_EDIT')
  create(@Body() dto: CreateContractTypeDto, @CurrentUser() actor: AuthUser) {
    return this.contractTypes.create(dto, actor);
  }

  @Patch(':id')
  @RequirePermission('CONTRACT_TYPE_EDIT')
  update(@Param('id') id: string, @Body() dto: UpdateContractTypeDto, @CurrentUser() actor: AuthUser) {
    return this.contractTypes.update(id, dto, actor);
  }

  @Post(':id/clone')
  @RequirePermission('CONTRACT_TYPE_EDIT')
  clone(@Param('id') id: string, @Body() dto: CloneContractTypeDto, @CurrentUser() actor: AuthUser) {
    return this.contractTypes.clone(id, dto, actor);
  }

  @Post(':id/retire')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('CONTRACT_TYPE_EDIT')
  retire(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.contractTypes.retire(id, actor);
  }
}
