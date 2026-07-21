import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { IsISO8601, IsOptional, IsString } from 'class-validator';
import { RequirePermission } from '../../common/decorators';
import { PageQueryDto, Paginated } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';

class AuditQueryDto extends PageQueryDto {
  @IsOptional() @IsString() entityType?: string;
  @IsOptional() @IsString() entityId?: string;
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermission('AUDIT_LOG_VIEW')
  async list(@Query() query: AuditQueryDto) {
    const where = {
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.size,
        include: { user: { select: { loginId: true, displayName: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return new Paginated(rows, query.page, query.size, total);
  }

  @Get(':id')
  @RequirePermission('AUDIT_LOG_VIEW')
  async detail(@Param('id') id: string) {
    const row = await this.prisma.auditLog.findUnique({
      where: { id },
      include: { user: { select: { loginId: true, displayName: true } } },
    });
    if (!row) throw new NotFoundException('감사로그가 없습니다.');
    return row;
  }
}
