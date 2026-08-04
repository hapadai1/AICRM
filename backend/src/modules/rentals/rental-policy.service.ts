import { Injectable } from '@nestjs/common';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { UpdateRentalReturnPolicyDto } from './rentals.dto';
import {
  addDaysToDateOnly,
  DEFAULT_RETURN_POLICY,
  RENTAL_RETURN_POLICY_ID,
} from './rentals.constants';

export interface RentalReturnPolicyView {
  lightCleaningDays: number;
  darkCleaningDays: number;
  autoRelease: boolean;
  updatedAt: Date | null;
}

/**
 * 렌탈 반납 후 정비(세탁) 기준 (ADMIN-001 "렌탈 정비 기준").
 *
 * 반납한 옷은 세탁 여부를 확인해야 해서 바로 다시 빌려줄 수 없다. 며칠을 잡을지는
 * 색 계열(rental_colors.tone)로 갈린다 — 화이트·베이지 계열은 오염이 그대로 보여 더 길게.
 * 화면이 "오늘+2일"을 박아 두던 것을 여기로 옮겼다.
 */
@Injectable()
export class RentalPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 정책 단건. 행이 없으면(구 DB·테스트) 기본값으로 만들어 준다 — 항상 한 행만 존재한다. */
  async get(): Promise<RentalReturnPolicyView> {
    const row = await this.prisma.rentalReturnPolicy.findUnique({
      where: { id: RENTAL_RETURN_POLICY_ID },
    });
    if (row)
      return {
        lightCleaningDays: row.lightCleaningDays,
        darkCleaningDays: row.darkCleaningDays,
        autoRelease: row.autoRelease,
        updatedAt: row.updatedAt,
      };
    const created = await this.prisma.rentalReturnPolicy.create({
      data: { id: RENTAL_RETURN_POLICY_ID, ...DEFAULT_RETURN_POLICY },
    });
    return {
      lightCleaningDays: created.lightCleaningDays,
      darkCleaningDays: created.darkCleaningDays,
      autoRelease: created.autoRelease,
      updatedAt: created.updatedAt,
    };
  }

  async update(dto: UpdateRentalReturnPolicyDto, actor: AuthUser): Promise<RentalReturnPolicyView> {
    const before = await this.get();
    const updated = await this.prisma.rentalReturnPolicy.update({
      where: { id: RENTAL_RETURN_POLICY_ID },
      data: {
        ...(dto.lightCleaningDays !== undefined ? { lightCleaningDays: dto.lightCleaningDays } : {}),
        ...(dto.darkCleaningDays !== undefined ? { darkCleaningDays: dto.darkCleaningDays } : {}),
        ...(dto.autoRelease !== undefined ? { autoRelease: dto.autoRelease } : {}),
        updatedBy: actor.id,
      },
    });
    const after: RentalReturnPolicyView = {
      lightCleaningDays: updated.lightCleaningDays,
      darkCleaningDays: updated.darkCleaningDays,
      autoRelease: updated.autoRelease,
      updatedAt: updated.updatedAt,
    };
    await this.audit.log({
      userId: actor.id,
      action: 'UPDATE',
      entityType: 'RENTAL_RETURN_POLICY',
      entityId: RENTAL_RETURN_POLICY_ID,
      before,
      after,
    });
    return after;
  }

  /**
   * 색 코드 → 정비 소요일. 기준정보에 없는 색(폐기·수기 입력)은 짧은 쪽(DARK)으로 본다 —
   * 모르는 색 때문에 재고를 더 오래 묶어 두는 편이 운영에는 더 나쁘다.
   */
  async cleaningDaysByColor(colorCodes: string[]): Promise<Map<string, number>> {
    const policy = await this.get();
    const unique = [...new Set(colorCodes)];
    const colors = unique.length
      ? await this.prisma.rentalColor.findMany({
          where: { code: { in: unique } },
          select: { code: true, tone: true },
        })
      : [];
    const toneOf = new Map(colors.map((c) => [c.code, c.tone]));
    return new Map(
      unique.map((code) => [
        code,
        toneOf.get(code) === 'LIGHT' ? policy.lightCleaningDays : policy.darkCleaningDays,
      ]),
    );
  }

  /** 색 하나에 대한 정비 소요일 */
  async cleaningDaysFor(colorCode: string): Promise<number> {
    return (await this.cleaningDaysByColor([colorCode])).get(colorCode) ?? DEFAULT_RETURN_POLICY.darkCleaningDays;
  }

  /** 반납일 + 정비 소요일 = 대여 가능 예정일 */
  async suggestAvailableFrom(colorCode: string, returnDate: string): Promise<string> {
    return addDaysToDateOnly(returnDate, await this.cleaningDaysFor(colorCode));
  }
}
