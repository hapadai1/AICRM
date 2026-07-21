import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import { CreateMasterItemDto, UpdateMasterItemDto } from './admin-master.dto';
import { AdminMasterService } from './admin-master.service';

@Controller('admin/master')
export class AdminMasterController {
  constructor(private readonly adminMasterService: AdminMasterService) {}

  @Get(':type')
  @RequirePermission('ADMIN_MASTER_EDIT')
  list(@Param('type') type: string) {
    return this.adminMasterService.list(type);
  }

  @Post(':type')
  @RequirePermission('ADMIN_MASTER_EDIT')
  create(@Param('type') type: string, @Body() dto: CreateMasterItemDto, @CurrentUser() actor: AuthUser) {
    return this.adminMasterService.create(type, dto, actor);
  }

  @Patch(':type/:id')
  @RequirePermission('ADMIN_MASTER_EDIT')
  update(
    @Param('type') type: string,
    @Param('id') id: string,
    @Body() dto: UpdateMasterItemDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.adminMasterService.update(type, id, dto, actor);
  }

  @Post(':type/:id/retire')
  @RequirePermission('ADMIN_MASTER_EDIT')
  retire(@Param('type') type: string, @Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.adminMasterService.retire(type, id, actor);
  }
}
