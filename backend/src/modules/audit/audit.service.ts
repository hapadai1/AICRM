import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditEntry {
  userId?: string | null;
  action: string; // CREATE / UPDATE / DELETE / CONFIRM / CANCEL / EXPORT / STATUS_CHANGE ...
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  ipAddress?: string;
}

/** 민감 필드는 감사로그 전후값에서 제거한다. */
const SENSITIVE_KEYS = ['password', 'passwordHash', 'tokenHash', 'accessToken', 'refreshToken'];

function sanitize(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of SENSITIVE_KEYS) delete copy[key];
  return copy;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** 주요 CUD·확정·상태 변경 시 서비스 계층에서 명시적으로 호출한다. 실패해도 업무 처리를 막지 않는다. */
  async log(entry: AuditEntry, tx?: Pick<PrismaService, 'auditLog'>): Promise<void> {
    const client = tx ?? this.prisma;
    try {
      await client.auditLog.create({
        data: {
          id: randomUUID(),
          userId: entry.userId ?? null,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          beforeJson: entry.before === undefined ? undefined : (sanitize(entry.before) as object),
          afterJson: entry.after === undefined ? undefined : (sanitize(entry.after) as object),
          reason: entry.reason,
          ipAddress: entry.ipAddress,
        },
      });
    } catch {
      // 감사로그 실패가 업무 트랜잭션 밖에서 발생한 경우 무시 (트랜잭션 내 호출이면 함께 롤백됨)
    }
  }
}
