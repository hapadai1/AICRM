import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, Public } from '../../common/decorators';
import { AuthService } from './auth.service';
import { LoginDto, RefreshDto, VerifyPasswordDto } from './auth.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.loginId.trim(), dto.password);
  }

  /**
   * 현재 로그인 사용자와 최신 권한을 반환한다.
   * 권한은 JwtStrategy가 매 요청마다 DB에서 다시 읽으므로, 프론트가 진입 시 이 값으로
   * 재동기화하면 로그인 이후 역할·권한이 바뀌어도 재로그인 없이 UI에 반영된다.
   */
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  /**
   * 관리자 재인증 — 고객 모드에서 관리자 모드로 복귀할 때 현재 사용자의 비밀번호를 재확인한다.
   * (설계서 01 §6) 토큰을 발급/회전하지 않고 세션을 그대로 유지한다. @Public 미부착(로그인 필요).
   */
  @Post('verify-password')
  @HttpCode(200)
  verifyPassword(@CurrentUser() user: AuthUser, @Body() dto: VerifyPasswordDto) {
    return this.authService.verifyPassword(user, dto.password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(@Body() dto: RefreshDto) {
    await this.authService.logout(dto.refreshToken);
    return { success: true };
  }
}
