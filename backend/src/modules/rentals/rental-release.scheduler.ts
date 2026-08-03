import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RentalPolicyService } from './rental-policy.service';
import { parseDateOnly, todayDateOnly } from './rentals.constants';

/**
 * 정비가 끝난 렌탈 실물을 대여 가능으로 되돌린다 (현업 확정 2026-08-01).
 *
 * 반납 처리는 실물을 RETURNED_HOLD로 두고 정비 소요일만큼 뒤로 available_from을 잡는다.
 * 그날이 지나도 아무도 상태를 올려 주지 않으면 옷은 창고에 있는데 재고에는 안 잡힌다 —
 * 예전에는 직원이 재고 화면에서 한 벌씩 손으로 올려야 했다.
 *
 * 대상은 RETURNED_HOLD(세탁 대기)뿐이다. ALTERATION(수선)·UNAVAILABLE(파손 등)은
 * 사람이 끝났다고 판단해야 풀린다 — 날짜만 보고 올리면 수선 중인 옷이 배정된다.
 */
@Injectable()
export class RentalReleaseScheduler implements OnModuleInit {
  private readonly logger = new Logger(RentalReleaseScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: RentalPolicyService,
  ) {}

  /**
   * 기동 시 한 번 — 서버가 꺼져 있던 동안 지나간 정비일을 따라잡는다.
   * 매일 새벽만 돌면 주말에 껐다 켠 월요일 아침 재고가 비어 보인다.
   */
  async onModuleInit(): Promise<void> {
    await this.releaseDueItems('기동');
  }

  /** 매일 00:05 — 자정 직후 그날 가용해지는 옷을 한 번에 올린다. */
  @Cron('5 0 * * *')
  async runDaily(): Promise<void> {
    await this.releaseDueItems('일배치');
  }

  /** available_from이 지난 반납 대기 실물을 AVAILABLE로. 전환 건수를 돌려준다. */
  async releaseDueItems(trigger: string): Promise<number> {
    const { autoRelease } = await this.policy.get();
    if (!autoRelease) return 0;

    const today = parseDateOnly(todayDateOnly());
    const due = await this.prisma.rentalInventoryItem.findMany({
      where: {
        active: true,
        status: 'RETURNED_HOLD',
        availableFrom: { not: null, lte: today },
      },
      select: { id: true, managementCode: true, availableFrom: true },
    });
    if (due.length === 0) return 0;

    // 상태 이벤트의 actor는 NOT NULL이다. 사람이 한 일이 아니므로 시스템 계정(SUPER_ADMIN)을
    // 빌려 쓰고, reason으로 자동 전환임을 남긴다.
    const systemActorId = await this.systemActorId();
    if (!systemActorId) {
      this.logger.warn(`자동 가용 전환 대상 ${due.length}건을 건너뜁니다 — 시스템 계정을 찾지 못했습니다.`);
      return 0;
    }

    for (const item of due) {
      await this.prisma.$transaction(async (tx) => {
        await tx.rentalInventoryItem.update({
          where: { id: item.id },
          data: { status: 'AVAILABLE', rowVersion: { increment: 1 } },
        });
        await tx.rentalInventoryStatusEvent.create({
          data: {
            id: randomUUID(),
            rentalInventoryItemId: item.id,
            previousStatus: 'RETURNED_HOLD',
            newStatus: 'AVAILABLE',
            availableFrom: item.availableFrom,
            reason: '정비 완료 자동 가용 전환',
            actorId: systemActorId,
          },
        });
      });
    }
    this.logger.log(`렌탈 자동 가용 전환 ${due.length}건 (${trigger})`);
    return due.length;
  }

  /** 시스템 액터 = 가장 먼저 만들어진 SUPER_ADMIN 계정. 없으면 null. */
  private async systemActorId(): Promise<string | null> {
    const user = await this.prisma.user.findFirst({
      where: { status: 'ACTIVE', userRoles: { some: { role: { code: 'SUPER_ADMIN' } } } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return user?.id ?? null;
  }
}
