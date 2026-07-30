/**
 * 코드 상수로 정의된 기준정보(품목·구성품·수선구분)의 코드 집합·표시명 중앙 관리 (ADMIN-001).
 *
 * 설계: 아래 맵·배열은 "공유 가변 객체"다. 모든 소비처가 이 객체 참조를 그대로 import 해 쓰고,
 * 로그인 후 /code-labels 를 받아 hydrateCodeLabels() 로 in-place 갱신하면 전 화면에 반영된다.
 * **단일 출처는 서버(admin-master/code-labels.constants)**이며, 여기 값은 하이드레이션 전 폴백이다.
 * 코드 집합·순서도 서버 응답을 그대로 따른다(서버에서 없어진 코드는 하이드레이션 시 제거된다).
 * 화면에서 코드 추가·삭제는 불가하고 표시명만 편집한다.
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
  GENERAL: '일반 수선',
};

/** 수선 구분 코드 집합·표시 순서 (공유 가변 배열) — 접수 화면 선택지의 출처 */
export const REPAIR_TYPE_CODES: string[] = Object.keys(REPAIR_TYPE_LABELS_MAP);

/** 구성품 코드 집합·표시 순서 (공유 가변 배열) — 수선 접수의 대상 품목 선택지 출처 */
export const COMPONENT_TYPE_CODES: string[] = Object.keys(COMPONENT_TYPE_LABELS);

const DOMAIN_MAPS: Record<CodeLabelDomain, Record<string, string>> = {
  'product-category': PRODUCT_CATEGORY_LABELS,
  'component-type': COMPONENT_TYPE_LABELS,
  'repair-type': REPAIR_TYPE_LABELS_MAP,
};

/** 코드 집합까지 서버를 따라야 하는 도메인 (선택지로 쓰이는 도메인만 둔다) */
const DOMAIN_CODES: Partial<Record<CodeLabelDomain, string[]>> = {
  'repair-type': REPAIR_TYPE_CODES,
  'component-type': COMPONENT_TYPE_CODES,
};

export interface CodeLabelItem {
  code: string;
  label: string;
}

export type CodeLabelsResponse = Record<CodeLabelDomain, CodeLabelItem[]>;

/**
 * 서버 코드 집합·표시명을 공유 객체에 in-place 반영한다.
 * 서버에서 사라진 코드는 맵·배열에서 제거해 폴백 잔재가 화면에 남지 않게 한다.
 */
export function hydrateCodeLabels(data: CodeLabelsResponse): void {
  (Object.keys(DOMAIN_MAPS) as CodeLabelDomain[]).forEach((domain) => {
    const items = data[domain];
    if (!items) return;
    const map = DOMAIN_MAPS[domain];
    Object.keys(map).forEach((code) => {
      if (!items.some((i) => i.code === code)) delete map[code];
    });
    items.forEach(({ code, label }) => {
      map[code] = label;
    });
    // 코드 집합·순서도 서버 응답으로 교체한다(참조는 유지해야 하므로 splice).
    DOMAIN_CODES[domain]?.splice(0, Infinity, ...items.map((i) => i.code));
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
