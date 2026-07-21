import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { BusinessException } from '../../common/business.exception';
import { PrismaService } from '../../prisma/prisma.service';

const MAX_LOGIN_FAILURES = 5;

@Injectable()
export class AuthService {
  /** 온프레미스 단일 인스턴스 전제의 로그인 실패 카운터 (설계서 4.1: 5회 실패 시 잠금) */
  private readonly loginFailures = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(loginId: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { loginId },
      include: {
        userRoles: {
          include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
        },
      },
    });
    if (!user) throw new BusinessException('AUTH_INVALID_CREDENTIALS', '아이디 또는 비밀번호가 올바르지 않습니다.');
    if (user.status === 'LOCKED')
      throw new BusinessException('AUTH_ACCOUNT_LOCKED', '로그인 실패 누적으로 잠긴 계정입니다. 관리자에게 문의하세요.');
    if (user.status !== 'ACTIVE')
      throw new BusinessException('AUTH_ACCOUNT_INACTIVE', '비활성화된 계정입니다.');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      const failures = (this.loginFailures.get(loginId) ?? 0) + 1;
      this.loginFailures.set(loginId, failures);
      if (failures >= MAX_LOGIN_FAILURES) {
        await this.prisma.user.update({ where: { id: user.id }, data: { status: 'LOCKED' } });
        this.loginFailures.delete(loginId);
        throw new BusinessException('AUTH_ACCOUNT_LOCKED', '로그인 5회 실패로 계정이 잠겼습니다. 관리자에게 문의하세요.');
      }
      throw new BusinessException('AUTH_INVALID_CREDENTIALS', '아이디 또는 비밀번호가 올바르지 않습니다.');
    }

    this.loginFailures.delete(loginId);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const permissions = [
      ...new Set(user.userRoles.flatMap((ur) => ur.role.rolePermissions.map((rp) => rp.permission.code))),
    ];
    const tokens = await this.issueTokens(user.id, user.loginId);
    return {
      ...tokens,
      user: { id: user.id, loginId: user.loginId, displayName: user.displayName, permissions },
    };
  }

  /** refresh token 회전: 기존 토큰 폐기 후 신규 발급 */
  async refresh(refreshToken: string) {
    const tokenHash = this.hash(refreshToken);
    const stored = await this.prisma.refreshToken.findFirst({
      where: { tokenHash },
      include: { user: true },
    });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date() || stored.user.status !== 'ACTIVE') {
      throw new BusinessException('AUTH_REFRESH_INVALID', '다시 로그인해 주세요.');
    }
    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    return this.issueTokens(stored.user.id, stored.user.loginId);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hash(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issueTokens(userId: string, loginId: string) {
    const accessToken = await this.jwt.signAsync({ sub: userId, loginId });
    const refreshToken = randomBytes(48).toString('hex');
    const days = Number(this.config.get('REFRESH_TOKEN_DAYS', '14'));
    await this.prisma.refreshToken.create({
      data: {
        id: randomUUID(),
        userId,
        tokenHash: this.hash(refreshToken),
        expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
      },
    });
    return { accessToken, refreshToken };
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
