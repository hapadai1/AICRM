import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AppointmentsService } from './appointments.service';

/**
 * 네이버 예약 주기 수집 (설계서 16.1).
 *
 * 고정 크론을 쓰지 않는다 — 매시 정각처럼 규칙적인 접속은 기계로 판정되기 쉽다.
 * 매 실행마다 "기본 간격 + 0~지터" 를 새로 뽑아 다음 실행을 예약하므로 시·분·초가 모두 흩어진다.
 * 영업시간 밖에는 돌지 않는다 (새벽 무인 반복 = 봇 신호, 그 시간 예약 변동도 사실상 없다).
 *
 * 실패해도 재시도를 몰아치지 않는다. 로그인 만료·차단 가능성이 있는 상황에서 연타하면
 * 상황을 악화시키므로, 연속 실패 시 간격을 늘려 물러난다.
 */
@Injectable()
export class NaverSyncScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NaverSyncScheduler.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private consecutiveFailures = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly appointments: AppointmentsService,
  ) {}

  private get enabled(): boolean {
    return this.config.get('NAVER_BOOKING_SYNC_ENABLED') === 'true';
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('네이버 예약 자동 수집 비활성 (NAVER_BOOKING_SYNC_ENABLED)');
      return;
    }
    // 기동 직후 바로 긁지 않는다 — 재배포 때마다 같은 순간에 접속하는 패턴을 만들지 않기 위해
    this.scheduleNext(this.jitterMs(2, 10));
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** 다음 실행 예약 — 지연시간(ms)을 받아 타이머를 건다. */
  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const at = new Date(Date.now() + delayMs);
    this.logger.log(`다음 네이버 예약 수집: ${at.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);
    this.timer = setTimeout(() => void this.runOnce(), delayMs);
    this.timer.unref?.();
  }

  /** min~max 분 사이의 임의 지연(ms) — 초 단위까지 흩뜨린다. */
  private jitterMs(minMinutes: number, maxMinutes: number): number {
    const min = minMinutes * 60_000;
    const max = maxMinutes * 60_000;
    return Math.floor(min + Math.random() * Math.max(0, max - min));
  }

  /** 기본 간격 + 0~지터 (연속 실패 시 배수로 물러난다). */
  private nextDelayMs(): number {
    const base = Number(this.config.get('NAVER_BOOKING_SYNC_INTERVAL_MIN') ?? 180);
    const jitter = Number(this.config.get('NAVER_BOOKING_SYNC_JITTER_MIN') ?? 45);
    const backoff = Math.min(2 ** this.consecutiveFailures, 8); // 최대 8배까지만
    return this.jitterMs(base * backoff, (base + jitter) * backoff);
  }

  /** 영업시간(기본 10~20시, Asia/Seoul) 안인지. */
  private withinBusinessHours(now = new Date()): boolean {
    const range = String(this.config.get('NAVER_BOOKING_SYNC_HOURS') ?? '10-20');
    const [from, to] = range.split('-').map((v) => Number(v.trim()));
    if (!Number.isFinite(from) || !Number.isFinite(to)) return true;
    const hour = Number(
      // hourCycle h23 — hour12:false 만 쓰면 자정이 24 로 나오는 환경이 있다
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Seoul',
        hour: 'numeric',
        hourCycle: 'h23',
      }).format(now),
    );
    return hour >= from && hour < to;
  }

  /** 수집 1회 실행 후 다음 실행을 다시 예약한다. */
  async runOnce(): Promise<void> {
    if (this.stopped) return;

    if (!this.withinBusinessHours()) {
      // 영업시간 밖 — 긁지 않고 다음 창을 노린다
      this.scheduleNext(this.jitterMs(30, 60));
      return;
    }

    try {
      const actor = await this.systemActor();
      if (!actor) {
        this.logger.warn('시스템 계정을 찾지 못해 네이버 예약 수집을 건너뛴다');
      } else {
        const result = await this.appointments.syncNaverReservations(actor);
        this.logger.log(
          `네이버 예약 수집 완료 — 조회 ${result.fetched} / 신규 ${result.created} / 변경 ${result.updated} / ` +
            `취소 ${result.cancelled} / 충돌 ${result.conflicts} / 실패 ${result.failed}` +
            (result.firstLoad ? ' (첫 적재: 과거·미래 30일)' : ''),
        );
        for (const f of result.failures) {
          this.logger.warn(`네이버 예약 ${f.externalId} 적재 실패: ${f.reason}`);
        }
      }
      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures += 1;
      this.logger.error(
        `네이버 예약 수집 실패 (연속 ${this.consecutiveFailures}회) — 간격을 늘려 재시도한다: ${
          e instanceof Error ? e.message : e
        }`,
      );
    } finally {
      this.scheduleNext(this.nextDelayMs());
    }
  }

  /** 감사 로그 주체로 쓸 시스템 계정 = 가장 먼저 만들어진 SUPER_ADMIN. */
  private async systemActor(): Promise<AuthUser | null> {
    const user = await this.prisma.user.findFirst({
      where: { status: 'ACTIVE', userRoles: { some: { role: { code: 'SUPER_ADMIN' } } } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, loginId: true, displayName: true },
    });
    return user ? { ...user, permissions: [] } : null;
  }
}
