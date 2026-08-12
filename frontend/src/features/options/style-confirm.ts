/**
 * 스타일 확정 집계 — 스타일 컨설팅 목록의 "스타일 확정" 열과 계약 목록이 **같은 값**을 쓰도록
 * 한곳에서 계산한다. 맞춤은 옵션 확정(CONFIRMED), 렌탈은 실물 선정 완료를 확정으로 센다.
 * 분모는 계약의 전체 품목 수(맞춤 + 렌탈)이고, 확정 = 확정 수가 분모와 같을 때다
 * (현업 확정 2026-07-31·2026-08-11).
 */
import type { OptionProgressItem } from '../../api/options';
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

/** 계약 하나의 스타일 확정 집계 — 확정 품목 수와 분모(전체 품목 수). */
export interface StyleConfirm {
  /** 확정 품목 수 — 맞춤은 옵션 확정, 렌탈은 실물 선정 확정 */
  confirmed: number;
  /** 분모 = 계약의 전체 품목 수(맞춤 + 렌탈) */
  total: number;
}

/**
 * 계약별 스타일 확정 집계를 만든다. 맞춤은 옵션 확정, 렌탈은 실물 선정(컬러·사이즈가 지정된
 * 재고 선택) 완료를 각각 확정으로 센다. 스타일 컨설팅 목록은 맞춤 없는(렌탈뿐인) 계약을 빼지만
 * (컨설팅할 옵션이 없으므로), 계약 목록은 렌탈의 선정 완료도 스타일 확정으로 보여야 하므로
 * 렌탈로도 행을 세운다 — 렌탈만 있는 계약이 "대기"로 남지 않는다.
 */
export function styleConfirmByContract(
  items: OptionProgressItem[],
  rentals: RentalProgressItem[],
): Map<string, StyleConfirm> {
  const map = new Map<string, StyleConfirm>();
  for (const it of items) {
    const row = map.get(it.contractId) ?? { confirmed: 0, total: 0 };
    row.total += 1;
    if (it.status === 'CONFIRMED') row.confirmed += 1;
    map.set(it.contractId, row);
  }
  for (const it of rentals) {
    const row = map.get(it.contractId) ?? { confirmed: 0, total: 0 };
    row.total += 1;
    if (rentalSelectionDone(it)) row.confirmed += 1;
    map.set(it.contractId, row);
  }
  return map;
}
