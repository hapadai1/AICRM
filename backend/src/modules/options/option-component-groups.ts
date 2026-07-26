/**
 * 맞춤 옵션 부위(구성품) 그룹 (v2 D5 / 설계서 04 §2.3).
 * 품목 카테고리 → 부위 그룹 목록. 옵션 세션의 부위별 원단·컬러·패턴 입력과
 * 옵션세트 단계의 componentGroup 축을 공유한다.
 */
export const OPTION_COMPONENT_GROUPS: Record<string, string[]> = {
  SUIT: ['JACKET', 'TROUSERS', 'VEST'],
  SHIRT: ['SHIRT'],
  SHOES: ['SHOES'],
};

/** 부위 그룹 코드 → 한글 라벨 */
export const COMPONENT_GROUP_LABELS: Record<string, string> = {
  JACKET: '상의(자켓)',
  TROUSERS: '하의(바지)',
  VEST: '베스트',
  SHIRT: '셔츠',
  SHOES: '구두',
};

/** 유효한 부위 그룹 코드 전체 (DTO 검증·마이그레이션 백필용) */
export const COMPONENT_GROUP_CODES = ['JACKET', 'TROUSERS', 'VEST', 'SHIRT', 'SHOES'];

/** 카테고리의 부위 그룹 목록 (미지정 카테고리는 빈 배열) */
export function componentGroupsFor(category: string): string[] {
  return OPTION_COMPONENT_GROUPS[category] ?? [];
}
