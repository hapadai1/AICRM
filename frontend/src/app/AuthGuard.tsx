import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { request } from '../api/client';
import { type AuthUser, useAuthStore } from './auth-store';

export function AuthGuard({ children }: { children: ReactNode }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const setUser = useAuthStore((s) => s.setUser);
  const location = useLocation();

  // 로그인 응답으로 캐시된 권한은 세션 동안 갱신되지 않으므로, 진입 시 서버에서 최신
  // 사용자·권한을 다시 받아 동기화한다. 이렇게 하지 않으면 로그인 이후 역할·권한이
  // 바뀌어도 재로그인 전까지 버튼 노출 등 UI 권한 게이팅이 옛 값으로 남는다.
  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    request<AuthUser>({ url: '/auth/me' })
      .then((user) => {
        if (!cancelled) setUser(user);
      })
      .catch(() => {
        // 401 등 인증 오류는 client 인터셉터가 토큰 갱신/로그아웃으로 처리한다.
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, setUser]);

  if (!accessToken) {
    const redirect = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?redirect=${redirect}`} replace />;
  }
  return <>{children}</>;
}
