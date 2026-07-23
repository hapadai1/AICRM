/**
 * 코드 상수로 정의된 기준정보(품목·구성품·수선구분)의 표시명 중앙 관리 (ADMIN-001).
 *
 * 설계: 아래 맵들은 "공유 가변 객체"다. 모든 소비처가 이 객체 참조를 그대로 import 해 쓰고,
 * 로그인 후 /code-labels 를 받아 hydrateCodeLabels() 로 in-place 갱신하면 전 화면에 반영된다.
 * 기본값은 서버 code-labels.constants 와 일치해야 하며, 하이드레이션 전까지의 폴백이다.
 * 코드 집합은 고정 — 화면에서 추가·삭제는 불가하고 표시명만 편집한다.
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { request } from './client';

export type CodeLabelDomain = 'product-category' | 'component-type' | 'repair-type';

/** 품목 대분류 표시명 (공유 가변 맵) */
export const PRODUCT_CATEGORY_LABELS: Record<string, string> = {
  SUIT: '정장',
  SHIRT: '셔츠',
  SHOES: '구두',
};

/** 구성품 표시명 (공유 가변 맵) — 계약·주문·제작·수선·렌탈·고객 화면 공통 */
export const COMPONENT_TYPE_LABELS: Record<string, string> = {
  JACKET: '상의(자켓)',
  TROUSERS: '하의(바지)',
  VEST: '베스트',
  SHIRT: '셔츠',
  SHOES: '구두',
};

/** 수선 구분 표시명 (공유 가변 맵) */
export const REPAIR_TYPE_LABELS_MAP: Record<string, string> = {
  CUSTOM_DURING: '제작 중 수선',
  AFTER_SALE: '사후 수선',
  RENTAL_PRE: '렌탈 출고 전',
  RENTAL_POST: '렌탈 반납 후',
  GENERAL: '일반 수선',
};

const DOMAIN_MAPS: Record<CodeLabelDomain, Record<string, string>> = {
  'product-category': PRODUCT_CATEGORY_LABELS,
  'component-type': COMPONENT_TYPE_LABELS,
  'repair-type': REPAIR_TYPE_LABELS_MAP,
};

export interface CodeLabelItem {
  code: string;
  label: string;
}

export type CodeLabelsResponse = Record<CodeLabelDomain, CodeLabelItem[]>;

/** 서버 표시명을 공유 맵에 in-place 반영한다. */
export function hydrateCodeLabels(data: CodeLabelsResponse): void {
  (Object.keys(DOMAIN_MAPS) as CodeLabelDomain[]).forEach((domain) => {
    const items = data[domain];
    if (!items) return;
    items.forEach(({ code, label }) => {
      DOMAIN_MAPS[domain][code] = label;
    });
  });
}

export function fetchCodeLabels(): Promise<CodeLabelsResponse> {
  return request<CodeLabelsResponse>({ url: '/code-labels' });
}

export function updateCodeLabel(
  domain: CodeLabelDomain,
  code: string,
  label: string,
): Promise<CodeLabelItem> {
  return request<CodeLabelItem>({
    url: `/admin/code-labels/${domain}/${code}`,
    method: 'PUT',
    data: { label },
  });
}

export const CODE_LABELS_QUERY_KEY = ['code-labels'] as const;

/** 관리자 화면·하이드레이션 공용 조회. 표시명이 자주 바뀌지 않으므로 오래 캐시한다. */
export function useCodeLabelsQuery() {
  return useQuery({
    queryKey: CODE_LABELS_QUERY_KEY,
    queryFn: fetchCodeLabels,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * 앱 진입 시 표시명을 받아 공유 맵을 갱신한다(AppLayout 등 상위에서 1회 호출).
 * 관리자가 표시명을 저장하면 이 쿼리가 무효화되며 재조회 → 재하이드레이션되어 전 화면에 반영된다.
 */
export function useHydrateCodeLabels(): void {
  const { data } = useCodeLabelsQuery();
  useEffect(() => {
    if (data) hydrateCodeLabels(data);
  }, [data]);
}
