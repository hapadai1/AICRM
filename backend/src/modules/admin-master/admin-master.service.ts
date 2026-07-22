import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateMasterItemDto, UpdateMasterItemDto } from './admin-master.dto';

/**
 * 기준정보 관리 (화면·API 정의서 13.8 ADMIN-001).
 * type별로 전용 테이블에 위임한다. 코드/표시명/정렬/사용여부만 다루며 스키마가 동일하다.
 * - appointment-purposes → appointment_purposes
 * - payment-method       → payment_methods
 */
interface MasterRow {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  active: boolean;
}

/** 공통 CRUD 시그니처만 추린 Prisma 델리게이트 형태 */
interface MasterDelegate {
  findMany(args: unknown): Promise<MasterRow[]>;
  findUnique(args: unknown): Promise<MasterRow | null>;
  create(args: unknown): Promise<MasterRow>;
  update(args: unknown): Promise<MasterRow>;
}

@Injectable()
export class AdminMasterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** type → { 델리게이트, 감사 entityType }. 미지원 type이면 400. */
  private resolve(type: string): { delegate: MasterDelegate; entityType: string } {
    switch (type) {
      case 'appointment-purposes':
        return {
          delegate: this.prisma.appointmentPurpose as unknown as MasterDelegate,
          entityType: 'APPOINTMENT_PURPOSE',
        };
      case 'payment-method':
        return {
          delegate: this.prisma.paymentMethod as unknown as MasterDelegate,
          entityType: 'PAYMENT_METHOD',
        };
      default:
        throw new BusinessException('VALIDATION_ERROR', `지원하지 않는 기준정보 유형입니다: ${type}`, [
          { field: 'type', reason: 'UNSUPPORTED' },
        ]);
    }
  }

  list(type: string) {
    const { delegate } = this.resolve(type);
    return delegate.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] });
  }

  async create(type: string, dto: CreateMasterItemDto, actor: AuthUser) {
    const { delegate, entityType } = this.resolve(type);
    const exists = await delegate.findUnique({ where: { code: dto.code } });
    if (exists)
      throw new BusinessException('VALIDATION_ERROR', '이미 존재하는 코드입니다.', [
        { field: 'code', reason: 'DUPLICATE' },
      ]);
    const item = await delegate.create({
      data: {
        id: randomUUID(),
        code: dto.code,
        name: dto.name.trim(),
        sortOrder: dto.sortOrder ?? 0,
        active: dto.active ?? true,
      },
    });
    await this.audit.log({ userId: actor.id, action: 'CREATE', entityType, entityId: item.id, after: item });
    return item;
  }

  /** 표시명·정렬·사용 여부만 수정한다. code는 변경 불가. */
  async update(type: string, id: string, dto: UpdateMasterItemDto, actor: AuthUser) {
    const { delegate, entityType } = this.resolve(type);
    const before = await this.findOne(delegate, id);
    const item = await delegate.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
    });
    await this.audit.log({ userId: actor.id, action: 'UPDATE', entityType, entityId: id, before, after: item });
    return item;
  }

  /** 사용 중지: 삭제 대신 active=false (구현표준 1.7). */
  async retire(type: string, id: string, actor: AuthUser) {
    const { delegate, entityType } = this.resolve(type);
    const before = await this.findOne(delegate, id);
    if (!before.active)
      throw new BusinessException('INVALID_STATUS_TRANSITION', '이미 사용 중지된 항목입니다.');
    const item = await delegate.update({ where: { id }, data: { active: false } });
    await this.audit.log({
      userId: actor.id,
      action: 'STATUS_CHANGE',
      entityType,
      entityId: id,
      before,
      after: item,
      reason: '기준정보 사용 중지',
    });
    return item;
  }

  private async findOne(delegate: MasterDelegate, id: string): Promise<MasterRow> {
    const item = await delegate.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('기준정보 항목이 없습니다.');
    return item;
  }
}
