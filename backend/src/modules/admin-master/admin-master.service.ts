import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateMasterItemDto, UpdateMasterItemDto } from './admin-master.dto';

/**
 * 기준정보 관리 (화면·API 정의서 13.8 ADMIN-001).
 * MVP에서는 type=appointment-purposes(예약 목적)만 실동작한다.
 * 그 외 type(결제수단 등)은 전용 테이블이 없어 400 VALIDATION_ERROR를 반환한다.
 */
const SUPPORTED_TYPE = 'appointment-purposes';

@Injectable()
export class AdminMasterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(type: string) {
    this.assertType(type);
    return this.prisma.appointmentPurpose.findMany({
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
  }

  async create(type: string, dto: CreateMasterItemDto, actor: AuthUser) {
    this.assertType(type);
    const exists = await this.prisma.appointmentPurpose.findUnique({ where: { code: dto.code } });
    if (exists)
      throw new BusinessException('VALIDATION_ERROR', '이미 존재하는 코드입니다.', [
        { field: 'code', reason: 'DUPLICATE' },
      ]);
    const item = await this.prisma.appointmentPurpose.create({
      data: {
        id: randomUUID(),
        code: dto.code,
        name: dto.name.trim(),
        sortOrder: dto.sortOrder ?? 0,
        active: dto.active ?? true,
      },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'CREATE',
      entityType: 'APPOINTMENT_PURPOSE',
      entityId: item.id,
      after: item,
    });
    return item;
  }

  /** 표시명·정렬·사용 여부만 수정한다. code는 변경 불가. */
  async update(type: string, id: string, dto: UpdateMasterItemDto, actor: AuthUser) {
    this.assertType(type);
    const before = await this.findOne(id);
    const item = await this.prisma.appointmentPurpose.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'APPOINTMENT_PURPOSE',
      entityId: id,
      before,
      after: item,
    });
    return item;
  }

  /** 사용 중지: 삭제 대신 active=false (구현표준 1.7). */
  async retire(type: string, id: string, actor: AuthUser) {
    this.assertType(type);
    const before = await this.findOne(id);
    if (!before.active)
      throw new BusinessException('INVALID_STATUS_TRANSITION', '이미 사용 중지된 항목입니다.');
    const item = await this.prisma.appointmentPurpose.update({ where: { id }, data: { active: false } });
    await this.audit.log({
      userId: actor.id,
      action: 'STATUS_CHANGE',
      entityType: 'APPOINTMENT_PURPOSE',
      entityId: id,
      before,
      after: item,
      reason: '기준정보 사용 중지',
    });
    return item;
  }

  private assertType(type: string): void {
    if (type !== SUPPORTED_TYPE)
      throw new BusinessException('VALIDATION_ERROR', `지원하지 않는 기준정보 유형입니다: ${type}`, [
        { field: 'type', reason: 'UNSUPPORTED' },
      ]);
  }

  private async findOne(id: string) {
    const item = await this.prisma.appointmentPurpose.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('기준정보 항목이 없습니다.');
    return item;
  }
}
