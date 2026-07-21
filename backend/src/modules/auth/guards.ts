import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { BusinessException } from '../../common/business.exception';
import { AuthUser, IS_PUBLIC_KEY, PERMISSION_KEY } from '../../common/decorators';

/** 전역 인증 가드. @Public() 표시 엔드포인트만 통과시킨다. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}

/** 전역 권한 가드. @RequirePermission 코드가 있으면 사용자 권한을 검사한다. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const user: AuthUser | undefined = context.switchToHttp().getRequest().user;
    if (!user?.permissions.includes(required)) {
      throw new BusinessException('PERMISSION_DENIED', '해당 기능에 대한 권한이 없습니다.', undefined, {
        requiredPermission: required,
      });
    }
    return true;
  }
}
