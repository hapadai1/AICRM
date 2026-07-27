import { request } from './client';

/**
 * 관리자 재인증 (고객모드 → 관리자 복귀). 설계서 01 §6.
 * 토큰을 발급/회전하지 않고 현재 로그인 사용자의 비밀번호만 검증한다.
 * 실패 시 ApiError(AUTH_INVALID_CREDENTIALS), 5회 누적 시 AUTH_ACCOUNT_LOCKED.
 */
export function verifyPassword(password: string): Promise<{ verified: boolean }> {
  return request<{ verified: boolean }>({
    url: '/auth/verify-password',
    method: 'POST',
    data: { password },
  });
}
