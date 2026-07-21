import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateSharedMemoDto, UpdateSharedMemoDto } from './dashboard.dto';

const MEMO_INCLUDE = {
  author: { select: { id: true, displayName: true } },
  targetUser: { select: { id: true, displayName: true } },
} as const;

/** 대시보드 공유 메모(인수인계). 물리 삭제 대신 status=DELETED 소프트 삭제한다. */
@Injectable()
export class SharedMemosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.sharedNote.findMany({
      where: { status: { not: 'DELETED' } },
      include: MEMO_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(dto: CreateSharedMemoDto, actor: AuthUser) {
    if (dto.targetUserId) {
      const target = await this.prisma.user.findUnique({ where: { id: dto.targetUserId } });
      if (!target)
        throw new BusinessException('VALIDATION_ERROR', '대상 사용자가 없습니다.', [
          { field: 'targetUserId', reason: 'UNKNOWN_USER' },
        ]);
    }
    const memo = await this.prisma.sharedNote.create({
      data: {
        id: randomUUID(),
        content: dto.content,
        targetUserId: dto.targetUserId ?? null,
        authorId: actor.id,
        status: 'ACTIVE',
      },
      include: MEMO_INCLUDE,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'SHARED_NOTE',
      entityId: memo.id,
      after: { content: memo.content, targetUserId: memo.targetUserId, status: memo.status },
    });
    return memo;
  }

  async update(id: string, dto: UpdateSharedMemoDto, actor: AuthUser) {
    const before = await this.findActive(id);
    const memo = await this.prisma.sharedNote.update({
      where: { id },
      data: {
        ...(dto.content !== undefined ? { content: dto.content } : {}),
        ...(dto.status ? { status: dto.status } : {}),
      },
      include: MEMO_INCLUDE,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'SHARED_NOTE',
      entityId: id,
      before: { content: before.content, status: before.status },
      after: { content: memo.content, status: memo.status },
    });
    return memo;
  }

  async remove(id: string, actor: AuthUser) {
    const before = await this.findActive(id);
    const memo = await this.prisma.sharedNote.update({
      where: { id },
      data: { status: 'DELETED', deletedAt: new Date() },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'DELETE',
      entityType: 'SHARED_NOTE',
      entityId: id,
      before: { content: before.content, status: before.status },
      after: { status: memo.status, deletedAt: memo.deletedAt },
    });
    return { id: memo.id, status: memo.status, deletedAt: memo.deletedAt };
  }

  private async findActive(id: string) {
    const memo = await this.prisma.sharedNote.findUnique({ where: { id } });
    if (!memo || memo.status === 'DELETED') throw new NotFoundException('공유 메모가 없습니다.');
    return memo;
  }
}
