import { create } from 'zustand';

/**
 * 앱 UI 모드 상태 (고객모드 아키텍처 설계서 01 §2).
 *
 * auth-store와 분리해 "모드는 세션·토큰과 무관한 휘발성 UI 상태"임을 코드로 드러낸다.
 * **persist 하지 않는다(인메모리).** 새로고침·탭 재오픈 시 항상 ADMIN·고객 미선택으로
 * 복귀해, 태블릿을 방치·재로딩해도 직전 고객 컨텍스트가 되살아나지 않게 한다(설계 §2.1·§7).
 */
export type AppMode = 'ADMIN' | 'CUSTOMER';

interface ModeState {
  /** 기본 ADMIN */
  mode: AppMode;
  /** 고객모드에서 검색해 선택한 고객 1명 (URL이 1차 진실, 여기는 표시·가드용 미러) */
  selectedCustomerId: string | null;
  selectedCustomerName: string | null;
  selectedCustomerPhone: string | null;

  /** 모드만 전환한다(고객 선택은 유지). 고객모드 진입은 비밀번호 불필요(설계 D1). */
  setMode: (mode: AppMode) => void;
  /** 검색·홈에서 고객 1명을 선택한다. */
  selectCustomer: (c: { id: string; name: string; phone?: string | null }) => void;
  /** 선택 고객만 비운다(검색 화면 복귀·유휴 타임아웃). 모드는 유지한다(설계 §7). */
  clearSelectedCustomer: () => void;
  /** 전체 초기화: ADMIN·고객 미선택. 로그아웃·관리자 복귀 시 사용(설계 §7). */
  clear: () => void;
}

export const useModeStore = create<ModeState>((set) => ({
  mode: 'ADMIN',
  selectedCustomerId: null,
  selectedCustomerName: null,
  selectedCustomerPhone: null,
  setMode: (mode) => set({ mode }),
  selectCustomer: (c) =>
    set({
      selectedCustomerId: c.id,
      selectedCustomerName: c.name,
      selectedCustomerPhone: c.phone ?? null,
    }),
  clearSelectedCustomer: () =>
    set({ selectedCustomerId: null, selectedCustomerName: null, selectedCustomerPhone: null }),
  clear: () =>
    set({
      mode: 'ADMIN',
      selectedCustomerId: null,
      selectedCustomerName: null,
      selectedCustomerPhone: null,
    }),
}));

/** 전화번호 마스킹 표시 (010-****-9012). 고객모드 화면 공용(설계 §4.1·§7). */
export function maskPhone(phone?: string | null): string {
  if (!phone) return '-';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return phone;
  const head = digits.slice(0, 3);
  const tail = digits.slice(-4);
  return `${head}-****-${tail}`;
}
