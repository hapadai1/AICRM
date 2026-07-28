/**
 * 헤더 제목 오버라이드 (UI 정리 Phase 1).
 *
 * 기본 헤더 제목은 AppLayout 이 현재 메뉴명으로 채운다("고객", "계약 관리" …).
 * 그런데 상세 화면도 같은 메뉴에 속해 헤더가 "고객"인 채로 남아, 헤더만 봐서는
 * 목록인지 상세인지 알 수 없었다. 상세 화면이 이 스토어에 제목을 넣으면
 * 그 화면에 머무는 동안만 헤더가 바뀐다(언마운트 시 자동 복원 — usePageTitle).
 */
import { useEffect } from 'react';
import { create } from 'zustand';

interface PageTitleState {
  /** 현재 화면이 지정한 제목. null 이면 메뉴명을 그대로 쓴다. */
  title: string | null;
  /** 제목 아래(옆)에 붙는 보조 설명 — 계약번호·전화번호 등 */
  subtitle: string | null;
  set: (title: string | null, subtitle?: string | null) => void;
}

export const usePageTitleStore = create<PageTitleState>((set) => ({
  title: null,
  subtitle: null,
  set: (title, subtitle = null) => set({ title, subtitle }),
}));

/**
 * 상세 화면에서 헤더 제목을 지정한다.
 * 데이터 로딩 중이면 undefined 를 넘겨 두면 되고, 값이 들어오는 순간 헤더가 바뀐다.
 */
export function usePageTitle(title?: string | null, subtitle?: string | null): void {
  const set = usePageTitleStore((s) => s.set);
  useEffect(() => {
    set(title ?? null, subtitle ?? null);
    return () => set(null, null);
  }, [title, subtitle, set]);
}
