import {
  RENTAL_COMPONENT_TYPE_LABELS,
  RENTAL_ITEM_STATUS_META,
  type RentalComponentType,
  type RentalItemStatus,
} from '../../api/rentals';
import { metaOf } from '../../shared/status-meta';

/** 디자인·컬러 데모 기준값 (관리자 기준정보 연동 전) */
export const DESIGN_OPTIONS = [
  { value: '클래식A', label: '클래식A' },
  { value: '모던B', label: '모던B' },
];

export const COLOR_OPTIONS = [
  { value: 'BLACK', label: 'BLACK' },
  { value: 'NAVY', label: 'NAVY' },
];

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
