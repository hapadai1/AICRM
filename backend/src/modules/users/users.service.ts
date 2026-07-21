import { Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateUserDto, UpdateRolePermissionsDto, UpdateUserDto } from './users.dto';

const USER_SELECT = {
  id: true,
  loginId: true,
  displayName: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  userRoles: { select: { role: { select: { code: true, name: true } } } },
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.user.findMany({ select: USER_SELECT, orderBy: { createdAt: 'asc' } });
  }

  async create(dto: CreateUserDto, actor: AuthUser) {
    const exists = await this.prisma.user.findUnique({ where: { loginId: dto.loginId } });
    if (exists)
      throw new BusinessException('VALIDATION_ERROR', '이미 사용 중인 아이디입니다.', [
        { field: 'loginId', reason: 'DUPLICATE' },
      ]);

    const roles = await this.findRoles(dto.roleCodes);
    const user = await this.prisma.user.create({
      data: {
        id: randomUUID(),
        loginId: dto.loginId.trim(),
        displayName: dto.displayName.trim(),
        passwordHash: await bcrypt.hash(dto.password, 10),
        status: 'ACTIVE',
        userRoles: { create: roles.map((r) => ({ roleId: r.id })) },
      },
      select: USER_SELECT,
    });
    await this.audit.log({ userId: actor.id, action: 'CREATE', entityType: 'USER', entityId: user.id, after: user });
    return user;
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthUser) {
    const before = await this.prisma.user.findUnique({ where: { id }, select: USER_SELECT });
    if (!before) throw new NotFoundException('사용자가 없습니다.');

    const user = await this.prisma.$transaction(async (tx) => {
      if (dto.roleCodes) {
        const roles = await this.findRoles(dto.roleCodes);
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({ data: roles.map((r) => ({ userId: id, roleId: r.id })) });
      }
      return tx.user.update({
        where: { id },
        data: {
          ...(dto.displayName ? { displayName: dto.displayName.trim() } : {}),
          ...(dto.status ? { status: dto.status } : {}),
          ...(dto.password ? { passwordHash: await bcrypt.hash(dto.password, 10) } : {}),
        },
        select: USER_SELECT,
      });
    });
    await this.audit.log({ userId: actor.id, action: 'UPDATE', entityType: 'USER', entityId: id, before, after: user });
    return user;
  }

  /** 퇴사 처리: 삭제 대신 INACTIVE. 본인 계정은 비활성화할 수 없다. */
  async deactivate(id: string, actor: AuthUser) {
    if (id === actor.id)
      throw new BusinessException('VALIDATION_ERROR', '본인 계정은 비활성화할 수 없습니다.');
    const before = await this.prisma.user.findUnique({ where: { id }, select: USER_SELECT });
    if (!before) throw new NotFoundException('사용자가 없습니다.');

    const user = await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      return tx.user.update({ where: { id }, data: { status: 'INACTIVE' }, select: USER_SELECT });
    });
    await this.audit.log({ userId: actor.id, action: 'STATUS_CHANGE', entityType: 'USER', entityId: id, before, after: user });
    return user;
  }

  listRoles() {
    return this.prisma.role.findMany({
      include: { rolePermissions: { select: { permission: { select: { code: true, name: true } } } } },
      orderBy: { code: 'asc' },
    });
  }

  listPermissions() {
    return this.prisma.permission.findMany({ orderBy: { code: 'asc' } });
  }

  async updateRolePermissions(roleId: string, dto: UpdateRolePermissionsDto, actor: AuthUser) {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: { rolePermissions: { include: { permission: true } } },
    });
    if (!role) throw new NotFoundException('역할이 없습니다.');

    const permissions = await this.prisma.permission.findMany({ where: { code: { in: dto.permissionCodes } } });
    if (permissions.length !== dto.permissionCodes.length)
      throw new BusinessException('VALIDATION_ERROR', '존재하지 않는 권한 코드가 포함되어 있습니다.');

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId } });
      await tx.rolePermission.createMany({ data: permissions.map((p) => ({ roleId, permissionId: p.id })) });
      return tx.role.findUniqueOrThrow({
        where: { id: roleId },
        include: { rolePermissions: { select: { permission: { select: { code: true } } } } },
      });
    });
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'ROLE_PERMISSION',
      entityId: roleId,
      before: { permissions: role.rolePermissions.map((rp) => rp.permission.code) },
      after: { permissions: dto.permissionCodes },
    });
    return updated;
  }

  private async findRoles(codes: string[]) {
    const roles = await this.prisma.role.findMany({ where: { code: { in: codes } } });
    if (roles.length !== codes.length)
      throw new BusinessException('VALIDATION_ERROR', '존재하지 않는 역할 코드가 포함되어 있습니다.', [
        { field: 'roleCodes', reason: 'UNKNOWN_ROLE' },
      ]);
    return roles;
  }
}
