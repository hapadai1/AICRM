import type { ReactNode } from 'react';
import { useAuthStore } from '../app/auth-store';

interface CanProps {
  permission: string;
  children: ReactNode;
}

/** 지정한 권한 코드를 보유한 경우에만 children을 렌더링한다. */
export function Can({ permission, children }: CanProps) {
  const allowed = useAuthStore((s) => s.user?.permissions.includes(permission) ?? false);
  if (!allowed) return null;
  return <>{children}</>;
}
