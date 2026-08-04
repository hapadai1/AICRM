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
 * - rental-colors        → rental_colors (v2 D3)
 * - rental-sizes         → rental_sizes  (v2 D3)
 *
 * 렌탈 컬러·사이즈만 componentTypes(적용 품목)를, 렌탈 컬러만 tone(색 계열)을 추가로 갖는다 —
 * 다른 유형에는 컬럼이 없어 resolve()가 알려주는 경우에만 쓰기 데이터에 싣는다.
 */
interface MasterRow {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  active: boolean;
  componentTypes?: string[];
  tone?: string;
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
  private resolve(type: string): {
    delegate: MasterDelegate;
    entityType: string;
    hasComponentTypes: boolean;
    hasTone: boolean;
    /** 코드를 서버가 채번하는 유형이면 접두어. 없으면 코드는 필수 입력이다. */
    autoCodePrefix?: string;
  } {
    switch (type) {
      case 'appointment-purposes':
        return {
          delegate: this.prisma.appointmentPurpose as unknown as MasterDelegate,
          entityType: 'APPOINTMENT_PURPOSE',
          hasComponentTypes: false,
          hasTone: false,
        };
      case 'rental-colors':
        return {
          delegate: this.prisma.rentalColor as unknown as MasterDelegate,
          entityType: 'RENTAL_COLOR',
          hasComponentTypes: true,
          hasTone: true,
          // 컬러 코드는 시스템이 실물 관리코드에 쓰는 값이라 사람이 정할 이유가 없다.
          // 화면은 표시명만 받고, 코드는 여기서 붙인다.
          autoCodePrefix: 'COLOR',
        };
      case 'rental-sizes':
        return {
          delegate: this.prisma.rentalSize as unknown as MasterDelegate,
          entityType: 'RENTAL_SIZE',
          hasComponentTypes: true,
          hasTone: false,
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
    const { delegate, entityType, hasComponentTypes, hasTone, autoCodePrefix } = this.resolve(type);
    const code = dto.code ?? (autoCodePrefix ? await this.nextCode(delegate, autoCodePrefix) : undefined);
    if (!code)
      throw new BusinessException('VALIDATION_ERROR', '코드는 필수입니다.', [
        { field: 'code', reason: 'REQUIRED' },
      ]);
    const exists = await delegate.findUnique({ where: { code } });
    if (exists)
      throw new BusinessException('VALIDATION_ERROR', '이미 존재하는 코드입니다.', [
        { field: 'code', reason: 'DUPLICATE' },
      ]);
    const item = await delegate.create({
      data: {
        id: randomUUID(),
        code,
        name: dto.name.trim(),
        ...(hasComponentTypes ? { componentTypes: dto.componentTypes ?? [] } : {}),
        // 새 색은 블랙 타입으로 들어온다 — 밝은색은 세탁일이 길어 잘못 잡으면 재고가 묶인다.
        ...(hasTone ? { tone: dto.tone ?? 'DARK' } : {}),
        // 정렬을 안 주면 맨 뒤에 붙인다. 0으로 두면 새 항목이 기존 목록 위로 올라온다.
        sortOrder: dto.sortOrder ?? (await this.nextSortOrder(delegate)),
        active: dto.active ?? true,
      },
    });
    await this.audit.log({ userId: actor.id, action: 'CREATE', entityType, entityId: item.id, after: item });
    return item;
  }

  /** 표시명·색 계열·정렬·사용 여부만 수정한다. code는 변경 불가. */
  async update(type: string, id: string, dto: UpdateMasterItemDto, actor: AuthUser) {
    const { delegate, entityType, hasComponentTypes, hasTone } = this.resolve(type);
    const before = await this.findOne(delegate, id);
    const item = await delegate.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(hasComponentTypes && dto.componentTypes !== undefined
          ? { componentTypes: dto.componentTypes }
          : {}),
        ...(hasTone && dto.tone !== undefined ? { tone: dto.tone } : {}),
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

  /**
   * `COLOR_1`, `COLOR_2` … 다음 번호. 사용 중지·폐기된 코드도 세어 두 번 쓰지 않는다 —
   * 코드는 실물 관리코드에 그대로 박히므로 재사용하면 옛 실물과 새 실물이 같은 코드를 갖는다.
   */
  private async nextCode(delegate: MasterDelegate, prefix: string): Promise<string> {
    const rows = await delegate.findMany({ select: { code: true } });
    const used = new Set(rows.map((r) => r.code));
    for (let n = rows.length + 1; ; n += 1) {
      const candidate = `${prefix}_${n}`;
      if (!used.has(candidate)) return candidate;
    }
  }

  /** 목록 맨 뒤 순번 */
  private async nextSortOrder(delegate: MasterDelegate): Promise<number> {
    const rows = await delegate.findMany({ select: { sortOrder: true } });
    return rows.reduce((max, r) => Math.max(max, r.sortOrder), 0) + 1;
  }

  private async findOne(delegate: MasterDelegate, id: string): Promise<MasterRow> {
    const item = await delegate.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('기준정보 항목이 없습니다.');
    return item;
  }
}
