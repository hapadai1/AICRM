import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  CloneContractTypeDto,
  ContractTypeLineDto,
  CreateContractTypeDto,
  UpdateContractTypeDto,
} from './contract-types.dto';

const TYPE_INCLUDE = {
  lines: { orderBy: { sortOrder: 'asc' as const } },
} as const;

@Injectable()
export class ContractTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(activeOnly: boolean) {
    return this.prisma.contractType.findMany({
      where: activeOnly ? { active: true } : undefined,
      include: TYPE_INCLUDE,
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
  }

  async create(dto: CreateContractTypeDto, actor: AuthUser) {
    await this.assertCodeAvailable(dto.code);
    const created = await this.prisma.contractType.create({
      data: {
        id: randomUUID(),
        code: dto.code.trim(),
        name: dto.name.trim(),
        description: dto.description ?? null,
        sortOrder: dto.sortOrder ?? 0,
        active: true,
        lines: { create: (dto.lines ?? []).map((l, i) => this.toLineData(l, i)) },
      },
      include: TYPE_INCLUDE,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'CONTRACT_TYPE',
      entityId: created.id,
      after: created,
    });
    return created;
  }

  async update(id: string, dto: UpdateContractTypeDto, actor: AuthUser) {
    const before = await this.findOrThrow(id);
    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.lines) {
        // 계약서는 라인을 복사해 저장하므로 마스터 라인 교체는 기존 계약에 영향을 주지 않는다.
        await tx.contractTypeLine.deleteMany({ where: { contractTypeId: id } });
        await tx.contractTypeLine.createMany({
          data: dto.lines.map((l, i) => ({ ...this.toLineData(l, i), contractTypeId: id })),
        });
      }
      return tx.contractType.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
        },
        include: TYPE_INCLUDE,
      });
    });
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'CONTRACT_TYPE',
      entityId: id,
      before,
      after: updated,
    });
    return updated;
  }

  /** 기존 계약 구분을 라인 포함 복제해 새 코드로 등록한다. */
  async clone(id: string, dto: CloneContractTypeDto, actor: AuthUser) {
    const source = await this.findOrThrow(id);
    await this.assertCodeAvailable(dto.code);
    const created = await this.prisma.contractType.create({
      data: {
        id: randomUUID(),
        code: dto.code.trim(),
        name: (dto.name ?? `${source.name} (복사)`).trim(),
        description: source.description,
        sortOrder: source.sortOrder,
        active: true,
        lines: {
          create: source.lines.map((l) => ({
            id: randomUUID(),
            transactionType: l.transactionType,
            productCategory: l.productCategory,
            defaultQuantity: l.defaultQuantity,
            sortOrder: l.sortOrder,
            active: l.active,
          })),
        },
      },
      include: TYPE_INCLUDE,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'CONTRACT_TYPE',
      entityId: created.id,
      after: created,
      reason: `clone of ${source.code}`,
    });
    return created;
  }

  /** 사용 중지: 물리 삭제 대신 active=false. 기존 계약에는 영향 없음. */
  async retire(id: string, actor: AuthUser) {
    const before = await this.findOrThrow(id);
    const updated = await this.prisma.contractType.update({
      where: { id },
      data: { active: false },
      include: TYPE_INCLUDE,
    });
    await this.audit.log({
      userId: actor.id,
      action: 'STATUS_CHANGE',
      entityType: 'CONTRACT_TYPE',
      entityId: id,
      before: { active: before.active },
      after: { active: false },
    });
    return updated;
  }

  private async findOrThrow(id: string) {
    const found = await this.prisma.contractType.findUnique({ where: { id }, include: TYPE_INCLUDE });
    if (!found) throw new NotFoundException('계약 구분이 없습니다.');
    return found;
  }

  private async assertCodeAvailable(code: string): Promise<void> {
    const exists = await this.prisma.contractType.findUnique({ where: { code: code.trim() } });
    if (exists)
      throw new BusinessException('VALIDATION_ERROR', '이미 사용 중인 계약 구분 코드입니다.', [
        { field: 'code', reason: 'DUPLICATE' },
      ]);
  }

  private toLineData(line: ContractTypeLineDto, index: number) {
    return {
      id: randomUUID(),
      transactionType: line.transactionType,
      productCategory: line.productCategory,
      defaultQuantity: line.defaultQuantity ?? 1,
      sortOrder: line.sortOrder ?? index + 1,
      active: line.active ?? true,
    };
  }
}
