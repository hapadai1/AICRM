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
  /** 대상 통합 검색: 엔티티 유형·엔티티 ID·액션에 대해 부분 일치 */
  @IsOptional() @IsString() query?: string;
}

/**
 * 조회 종료 시각. `YYYY-MM-DD`(날짜만)면 그날을 포함하도록 다음 날 00:00으로 올린다.
 * 시각까지 준 경우에는 그 값을 그대로 상한으로 쓴다.
 */
function endOfRange(value: string): Date {
  const date = new Date(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) date.setDate(date.getDate() + 1);
  return date;
}

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermission('AUDIT_LOG_VIEW')
  async list(@Query() query: AuditQueryDto) {
    const q = query.query?.trim();
    const where = {
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(q
        ? {
            // entity_id는 uuid 컬럼이라 부분검색 불가 — 완전한 UUID일 때만 정확 매칭한다.
            OR: [
              { entityType: { contains: q, mode: 'insensitive' as const } },
              { action: { contains: q, mode: 'insensitive' as const } },
              ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)
                ? [{ entityId: q }]
                : []),
            ],
          }
        : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              // `to`가 날짜만이면 그날 00:00이 되어 당일 로그가 통째로 빠진다 → 다음 날 00:00 미만으로 본다.
              ...(query.to ? { lt: endOfRange(query.to) } : {}),
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
