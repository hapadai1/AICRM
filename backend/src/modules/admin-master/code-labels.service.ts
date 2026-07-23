import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CODE_LABEL_DOMAINS, CodeLabelDomain, isCodeLabelDomain } from './code-labels.constants';

export interface CodeLabelItem {
  code: string;
  label: string;
}

/**
 * 코드 상수 기준정보(품목·구성품·수선구분)의 표시명 관리.
 * 코드 집합·기본 표시명은 code-labels.constants 가 원본이고,
 * master_code_labels 테이블은 관리자가 바꾼 표시명 오버라이드만 저장한다.
 */
@Injectable()
export class CodeLabelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 전체 도메인의 표시명(기본값 + 오버라이드 병합). 앱 전역 하이드레이션·관리자 화면 공용. */
  async listAll(): Promise<Record<CodeLabelDomain, CodeLabelItem[]>> {
    const rows = await this.prisma.masterCodeLabel.findMany();
    const overrides = new Map(rows.map((r) => [`${r.domain}:${r.code}`, r.label]));
    const result = {} as Record<CodeLabelDomain, CodeLabelItem[]>;
    for (const domain of Object.keys(CODE_LABEL_DOMAINS) as CodeLabelDomain[]) {
      result[domain] = CODE_LABEL_DOMAINS[domain].map((d) => ({
        code: d.code,
        label: overrides.get(`${domain}:${d.code}`) ?? d.label,
      }));
    }
    return result;
  }

  /** 표시명만 수정한다. 도메인·코드는 코드 상수에 존재해야 하며 추가·삭제는 불가하다. */
  async update(domain: string, code: string, label: string, actor: AuthUser): Promise<CodeLabelItem> {
    if (!isCodeLabelDomain(domain))
      throw new BusinessException('VALIDATION_ERROR', `지원하지 않는 기준정보 유형입니다: ${domain}`, [
        { field: 'domain', reason: 'UNSUPPORTED' },
      ]);
    const def = CODE_LABEL_DOMAINS[domain].find((d) => d.code === code);
    if (!def)
      throw new BusinessException('VALIDATION_ERROR', `존재하지 않는 코드입니다: ${code}`, [
        { field: 'code', reason: 'NOT_FOUND' },
      ]);
    const trimmed = label.trim();
    if (!trimmed)
      throw new BusinessException('VALIDATION_ERROR', '표시명을 입력해 주세요.', [
        { field: 'label', reason: 'REQUIRED' },
      ]);

    const existing = await this.prisma.masterCodeLabel.findUnique({
      where: { domain_code: { domain, code } },
    });
    const before = existing?.label ?? def.label;
    const row = await this.prisma.masterCodeLabel.upsert({
      where: { domain_code: { domain, code } },
      update: { label: trimmed },
      create: { id: randomUUID(), domain, code, label: trimmed },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'MASTER_CODE_LABEL',
      entityId: `${domain}:${code}`,
      before: { label: before },
      after: { label: row.label },
    });
    return { code: row.code, label: row.label };
  }
}
