import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, Public } from '../../common/decorators';
import { AuthService } from './auth.service';
import { LoginDto, RefreshDto } from './auth.dto';

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
