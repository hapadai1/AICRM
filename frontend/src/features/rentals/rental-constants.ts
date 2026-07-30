import {
  RENTAL_COMPONENT_TYPE_LABELS,
  RENTAL_ITEM_STATUS_META,
  type RentalComponentType,
  type RentalItemStatus,
  type RentalMasterCode,
} from '../../api/rentals';
import { metaOf } from '../../shared/status-meta';

// 디자인 축은 폐기했다 — 실물은 구분 + 컬러 + 사이즈로만 식별한다.
// 컬러·사이즈 선택지는 하드코딩하지 않고 품목별로 기준정보에서 받아온다
// (fetchRentalColors/fetchRentalSizes에 componentType 전달).

/**
 * 한 화면이 여러 부위를 한꺼번에 그릴 때(스타일 컨설팅·렌탈 선택) 쓰는 부위별 필터.
 * 부위마다 API를 다시 부르지 않고 전체 코드를 한 번 받아 행 단위로 걸러 낸다.
 * componentTypes가 빈 코드는 품목을 가리지 않는 공통 코드다.
 */
export function codesFor(
  codes: RentalMasterCode[] | undefined,
  componentType?: string,
): RentalMasterCode[] {
  return (codes ?? []).filter(
    (c) =>
      !componentType ||
      c.componentTypes.length === 0 ||
      c.componentTypes.includes(componentType as RentalComponentType),
  );
}

export const componentTypeOptions = (
  Object.keys(RENTAL_COMPONENT_TYPE_LABELS) as RentalComponentType[]
).map((c) => ({
  value: c,
  label: RENTAL_COMPONENT_TYPE_LABELS[c],
}));

export const statusOptions = (Object.keys(RENTAL_ITEM_STATUS_META) as RentalItemStatus[]).map((s) => ({
  value: s,
  label: metaOf(RENTAL_ITEM_STATUS_META, s).label,
}));

/**
 * 폐기를 뺀 상태 선택지 — 재고 목록 검색바용.
 * 폐기는 '폐기만 보기' 체크박스가 맡는 축이라, 상태 드롭다운에도 두면
 * "상태=폐기인데 체크는 안 함" 같은 모순된 조합이 생긴다.
 */
export const liveStatusOptions = statusOptions.filter((o) => o.value !== 'RETIRED');
