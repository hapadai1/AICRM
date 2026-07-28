import { Controller, Get } from '@nestjs/common';
import { Public } from './decorators';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 운영 헬스체크 (ops/ 배포 구성에서 사용).
 *
 * 인증 없이 열어 두는 유일한 조회 엔드포인트다 — 배포 스크립트·systemd·nginx가
 * 기동 성공을 판정해야 하는데, 그러자고 운영 계정 자격증명을 스크립트에 둘 수는 없다.
 * 업무 데이터는 일절 노출하지 않고 앱 기동 여부와 DB 연결만 알린다.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** 앱 기동 확인 (DB 미확인 — 로드밸런서 liveness용) */
  @Public()
  @Get()
  live() {
    return { status: 'ok' };
  }

  /** DB까지 확인 (배포 후 점검·readiness용). 연결 실패 시 500으로 떨어진다. */
  @Public()
  @Get('ready')
  async ready() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', database: 'ok' };
  }
}
