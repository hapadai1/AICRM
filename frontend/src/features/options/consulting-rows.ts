/**
 * 스타일 컨설팅 화면의 행 모델 (2026-08-05 ContractOptionsPage에서 분리).
 * 맞춤·렌탈 품목을 부위(상의/하의/베스트) 단위 행으로 펴는 순수 계산만 둔다 — 화면 상태 없음.
 */
import type { OptionProgressItem } from '../../api/options';
import type { RentalProgressItem } from '../../api/rentals';

/** 맞춤 부위 행의 수기 입력 초안 (원단·컬러·패턴·비고를 한 벌로 들고 있다) */
export interface AttrDraft {
  fabricName: string;
  colorName: string;
  patternName: string;
  notes: string;
}
export const EMPTY_ATTR: AttrDraft = { fabricName: '', colorName: '', patternName: '', notes: '' };

/** 렌탈 부위 행의 초안 */
export interface RentalDraft {
  colorCode: string | null;
  sizeCode: string | null;
  notes: string;
}
export const EMPTY_RENTAL: RentalDraft = { colorCode: null, sizeCode: null, notes: '' };

/** 목록의 한 행 = 품목 × 부위 하나. 품목 정보는 첫 행에만 rowSpan으로 붙인다. */
export interface ComponentRow {
  key: string;
  kind: 'CUSTOM' | 'RENTAL';
  contractItemId: string;
  displayName: string;
  status: string;
  /** 품목 셀 rowSpan — 그 품목의 첫 행만 부위 수, 나머지는 0 */
  itemRowSpan: number;
  /** 부위 코드 (맞춤 componentGroup / 렌탈 componentType) */
  group: string;
  /** 베스트 부위가 이 벌에서 빠졌는가 — [베스트 제외] 체크 상태 (현업 확정 2026-08-01) */
  vestExcluded?: boolean;
  /** 제작 진행 중 품목 — 계약이 작성중이어도 편집 잠금 (맞춤 행만 내려온다) */
  inProduction?: boolean;
  // 맞춤
  sessionId?: string | null;
  completedStages?: number;
  totalStages?: number;
  // 렌탈
  contractItemComponentId?: string;
  colorName?: string | null;
  sizeName?: string | null;
  selectedItemCode?: string | null;
  rentalVersion?: number;
}

/**
 * 품목의 옵션 선택이 끝났는가 — 확인서 버튼 활성 기준.
 * 백엔드는 모든 활성 단계가 채워지면 세션을 REVIEW(이후 CONFIRMED)로 올리므로
 * 단계 수 비교와 상태 둘 중 하나만 맞아도 완료로 본다.
 */
export function isOptionDone(item: OptionProgressItem): boolean {
  if (!item.sessionId) return false;
  if (item.status === 'REVIEW' || item.status === 'CONFIRMED') return true;
  return item.totalStages > 0 && item.completedStages >= item.totalStages;
}

/** 맞춤 → 렌탈 순서로 품목을 이어 붙이고, 품목마다 부위 행으로 펼친다. */
export function buildComponentRows(
  customItems: OptionProgressItem[],
  rentalItems: RentalProgressItem[],
): ComponentRow[] {
  const out: ComponentRow[] = [];
  for (const item of customItems) {
    // 부위 슬롯이 비는 카테고리라도 품목이 목록에서 사라지면 안 된다 — 부위 없는 한 행으로 둔다.
    const groups =
      item.components.length > 0
        ? item.components
        : [
            {
              componentGroup: '',
              fabricName: null,
              colorName: null,
              patternName: null,
              notes: null,
              completedStages: item.completedStages,
              totalStages: item.totalStages,
            },
          ];
    groups.forEach((c, i) => {
      out.push({
        key: `${item.contractItemId}:${c.componentGroup}`,
        kind: 'CUSTOM',
        contractItemId: item.contractItemId,
        displayName: item.displayName,
        status: item.status,
        itemRowSpan: i === 0 ? groups.length : 0,
        group: c.componentGroup,
        vestExcluded: 'excluded' in c ? (c as { excluded?: boolean }).excluded : undefined,
        inProduction: item.inProduction,
        sessionId: item.sessionId,
        completedStages: c.completedStages,
        totalStages: c.totalStages,
      });
    });
  }
  for (const item of rentalItems) {
    // 구성품이 아직 없는 렌탈 품목도 목록에는 보여야 한다(주문에서 구성품을 추가하면 채워진다).
    if (item.components.length === 0) {
      out.push({
        key: `${item.contractItemId}:none`,
        kind: 'RENTAL',
        contractItemId: item.contractItemId,
        displayName: item.displayName,
        status: item.status,
        itemRowSpan: 1,
        group: '',
        sessionId: item.sessionId,
        rentalVersion: item.version,
      });
      continue;
    }
    item.components.forEach((c, i) => {
      out.push({
        key: `${item.contractItemId}:${c.contractItemComponentId}`,
        kind: 'RENTAL',
        contractItemId: item.contractItemId,
        displayName: item.displayName,
        status: item.status,
        itemRowSpan: i === 0 ? item.components.length : 0,
        group: c.componentType,
        vestExcluded: c.excluded,
        sessionId: item.sessionId,
        contractItemComponentId: c.contractItemComponentId,
        colorName: c.colorName,
        sizeName: c.sizeName,
        selectedItemCode: c.selectedItemCode,
        rentalVersion: item.version,
      });
    });
  }
  return out;
}
