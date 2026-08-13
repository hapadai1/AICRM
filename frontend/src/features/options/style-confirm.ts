/**
 * 스타일 확정 관련 공용 판정. 계약별 확정 집계(확정 수/분모)는 스타일 컨설팅 목록의
 * groupByContract 가 단일 소스이며, 계약 목록도 그 함수를 그대로 재사용한다.
 * 여기에는 두 곳이 공유하는 렌탈 선정 완료 판정만 둔다.
 */
import type { RentalProgressItem } from '../../api/rentals';

/**
 * 렌탈 선택 완료 판정 — 확정(CONFIRMED)이거나, 취소(베스트 제외) 안 된 모든 부위에
 * 실물이 지정된 경우. 서버 consultingReadiness의 렌탈 판정과 같은 기준이다.
 * (실물을 고르려면 대여 기간이 있어야 하므로 여기서는 기간을 따로 검사하지 않는다.)
 */
export function rentalSelectionDone(it: RentalProgressItem): boolean {
  if (it.status === 'CONFIRMED') return true;
  const active = it.components.filter((c) => !c.excluded);
  return active.length > 0 && active.every((c) => c.selectedInventoryItemId != null);
}
