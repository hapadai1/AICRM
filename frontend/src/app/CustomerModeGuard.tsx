/**
 * 고객모드 경로(/c/*) 가드. 설계서 01 §3.2·§7.
 *
 * 책임:
 *  1) 경로↔모드 동기화 — /c 서브트리에 있으면 mode=CUSTOMER로 맞춘다(새로고침·딥링크 대응).
 *  2) 선택 고객 컨텍스트 강제 — URL의 :customerId를 mode-store에 미러링한다.
 *     스토어가 비었거나 불일치하면 단건 조회로 채운다(타 고객 유입은 URL이 1차 진실).
 *  3) 유휴 타임아웃 — 무조작 N분 경과 시 선택 고객을 비우고 검색(/c)으로 복귀한다.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { fetchCustomer } from '../api/customers';
import { useModeStore } from './mode-store';

/** 유휴 타임아웃 (설계 §7 기본 5분, 미결 M1). */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** /c/:customerId(/...) 경로에서 customerId를 추출한다(없으면 검색 화면). */
function customerIdFromPath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean); // ['c', ':id', ...]
  if (parts[0] !== 'c') return null;
  return parts[1] ?? null;
}

export function CustomerModeGuard() {
  const location = useLocation();
  const navigate = useNavigate();
  const mode = useModeStore((s) => s.mode);
  const selectedCustomerId = useModeStore((s) => s.selectedCustomerId);
  const setMode = useModeStore((s) => s.setMode);
  const selectCustomer = useModeStore((s) => s.selectCustomer);
  const clearSelectedCustomer = useModeStore((s) => s.clearSelectedCustomer);

  const routeCustomerId = customerIdFromPath(location.pathname);

  // 1) 경로에 있으면 항상 고객모드로 맞춘다.
  useEffect(() => {
    if (mode !== 'CUSTOMER') setMode('CUSTOMER');
  }, [mode, setMode]);

  // 2) URL의 :customerId가 스토어와 다르면 단건 조회로 컨텍스트를 채운다.
  const needsSync = !!routeCustomerId && routeCustomerId !== selectedCustomerId;
  const { data } = useQuery({
    queryKey: ['customer-mode', 'customer', routeCustomerId],
    queryFn: () => fetchCustomer(routeCustomerId as string),
    enabled: needsSync,
  });
  useEffect(() => {
    if (needsSync && data) {
      selectCustomer({
        id: data.customer.id,
        name: data.customer.name,
        phone: data.customer.phone,
      });
    }
  }, [needsSync, data, selectCustomer]);

  // 3) 유휴 타임아웃 — 고객이 선택된 동안에만 동작. 터치·키 입력 시 리셋.
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!selectedCustomerId) return;
    const reset = () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        clearSelectedCustomer();
        navigate('/c', { replace: true });
      }, IDLE_TIMEOUT_MS);
    };
    const events: (keyof WindowEventMap)[] = ['mousedown', 'keydown', 'touchstart', 'pointerdown'];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [selectedCustomerId, clearSelectedCustomer, navigate]);

  return <Outlet />;
}
