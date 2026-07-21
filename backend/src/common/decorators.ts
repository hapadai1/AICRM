import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/** 인증 없이 접근 가능한 엔드포인트 표시 (로그인·토큰 갱신 등) */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const PERMISSION_KEY = 'requiredPermission';
/** 기능 권한 코드 요구 (화면·API 정의서 부록 B) */
export const RequirePermission = (code: string) => SetMetadata(PERMISSION_KEY, code);

export interface AuthUser {
  id: string;
  loginId: string;
  displayName: string;
  permissions: string[];
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
