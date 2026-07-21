import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import { CreateUserDto, UpdateRolePermissionsDto, UpdateUserDto } from './users.dto';
import { UsersService } from './users.service';

@Controller()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('users')
  @RequirePermission('USER_ADMIN')
  listUsers() {
    return this.usersService.list();
  }

  @Post('users')
  @RequirePermission('USER_ADMIN')
  createUser(@Body() dto: CreateUserDto, @CurrentUser() actor: AuthUser) {
    return this.usersService.create(dto, actor);
  }

  @Patch('users/:id')
  @RequirePermission('USER_ADMIN')
  updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() actor: AuthUser) {
    return this.usersService.update(id, dto, actor);
  }

  @Post('users/:id/deactivate')
  @RequirePermission('USER_ADMIN')
  deactivateUser(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.usersService.deactivate(id, actor);
  }

  @Get('roles')
  @RequirePermission('ROLE_ADMIN')
  listRoles() {
    return this.usersService.listRoles();
  }

  @Get('permissions')
  @RequirePermission('ROLE_ADMIN')
  listPermissions() {
    return this.usersService.listPermissions();
  }

  @Put('roles/:id/permissions')
  @RequirePermission('ROLE_ADMIN')
  updateRolePermissions(
    @Param('id') id: string,
    @Body() dto: UpdateRolePermissionsDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.usersService.updateRolePermissions(id, dto, actor);
  }
}
