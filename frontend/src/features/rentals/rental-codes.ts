import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { fetchRentalColors, fetchRentalSizes, type RentalComponentType } from '../../api/rentals';

/**
 * 컬러·사이즈 코드 → 표시명 변환.
 *
 * 실물이 들고 다니는 값은 코드(BLACK, 46)라서 표에 그대로 뿌리면
 * 검색 드롭다운("블랙", "46호")과 다른 말이 화면 안에 같이 뜬다.
 * 기준정보를 한 번 받아 이름으로 바꿔 준다. 모르는 코드는 코드 그대로 보여
 * 기준정보에서 내려간 값도 화면이 비지 않게 한다.
 *
 * queryKey는 재고 화면의 필터 코드 조회와 같은 형태라, 품목 미선택 상태에서는
 * 같은 응답을 함께 쓴다(중복 호출 없음).
 */
export function useRentalCodeNames(componentType?: RentalComponentType) {
  const scope = componentType ?? 'ALL';
  const colorsQuery = useQuery({
    queryKey: ['rentals', 'filter-codes', 'colors', scope],
    queryFn: () => fetchRentalColors(componentType),
  });
  const sizesQuery = useQuery({
    queryKey: ['rentals', 'filter-codes', 'sizes', scope],
    queryFn: () => fetchRentalSizes(componentType),
  });

  const colorName = useMemo(() => {
    const map = new Map((colorsQuery.data ?? []).map((c) => [c.code, c.name]));
    return (code?: string | null) => (code ? (map.get(code) ?? code) : '-');
  }, [colorsQuery.data]);

  const sizeName = useMemo(() => {
    const map = new Map((sizesQuery.data ?? []).map((s) => [s.code, s.name]));
    return (code?: string | null) => (code ? (map.get(code) ?? code) : '-');
  }, [sizesQuery.data]);

  const colorOptions = useMemo(
    () => (colorsQuery.data ?? []).map((c) => ({ value: c.code, label: c.name })),
    [colorsQuery.data],
  );
  const sizeOptions = useMemo(
    () => (sizesQuery.data ?? []).map((s) => ({ value: s.code, label: s.name })),
    [sizesQuery.data],
  );

  return {
    colorName,
    sizeName,
    colorOptions,
    sizeOptions,
    isLoading: colorsQuery.isLoading || sizesQuery.isLoading,
  };
}
