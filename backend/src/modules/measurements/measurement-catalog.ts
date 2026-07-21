/**
 * 채촌 항목 코드 초기값 (데이터모델설계서 §9.4).
 * 코드는 자유 수용하되, 알려진 코드는 분류·화면명·정렬 순서를 자동 보완한다.
 */
export type BodySection = 'UPPER' | 'LOWER' | 'SHOES';

export interface MeasurementItemDef {
  code: string;
  label: string;
  bodySection: BodySection;
  /** NUMERIC=cm 치수, TEXT=문자 사이즈, ANY=둘 다 허용 */
  valueType: 'NUMERIC' | 'TEXT' | 'ANY';
  sortOrder: number;
}

export const MEASUREMENT_ITEMS: MeasurementItemDef[] = [
  // 상의
  { code: 'NECK', label: '목둘레', bodySection: 'UPPER', valueType: 'NUMERIC', sortOrder: 10 },
  { code: 'SHOULDER', label: '어깨너비', bodySection: 'UPPER', valueType: 'NUMERIC', sortOrder: 20 },
  { code: 'CHEST', label: '가슴둘레', bodySection: 'UPPER', valueType: 'NUMERIC', sortOrder: 30 },
  { code: 'SLEEVE', label: '소매길이', bodySection: 'UPPER', valueType: 'NUMERIC', sortOrder: 40 },
  { code: 'BODY_LENGTH', label: '몸통길이', bodySection: 'UPPER', valueType: 'NUMERIC', sortOrder: 50 },
  { code: 'WRIST', label: '손목둘레', bodySection: 'UPPER', valueType: 'NUMERIC', sortOrder: 60 },
  { code: 'UPPER_SIZE', label: '상의 사이즈', bodySection: 'UPPER', valueType: 'TEXT', sortOrder: 70 },
  // 하의
  { code: 'WAIST', label: '허리둘레', bodySection: 'LOWER', valueType: 'NUMERIC', sortOrder: 110 },
  { code: 'HIP', label: '엉덩이둘레', bodySection: 'LOWER', valueType: 'NUMERIC', sortOrder: 120 },
  { code: 'RISE', label: '밑위길이', bodySection: 'LOWER', valueType: 'NUMERIC', sortOrder: 130 },
  { code: 'PANTS_LENGTH', label: '바지길이', bodySection: 'LOWER', valueType: 'NUMERIC', sortOrder: 140 },
  { code: 'THIGH', label: '허벅지둘레', bodySection: 'LOWER', valueType: 'NUMERIC', sortOrder: 150 },
  { code: 'CALF', label: '종아리둘레', bodySection: 'LOWER', valueType: 'NUMERIC', sortOrder: 160 },
  { code: 'LOWER_SIZE', label: '하의 사이즈', bodySection: 'LOWER', valueType: 'TEXT', sortOrder: 170 },
  // 구두
  { code: 'SHOE_SIZE', label: '신발 사이즈', bodySection: 'SHOES', valueType: 'ANY', sortOrder: 210 },
];

export const MEASUREMENT_ITEM_MAP: ReadonlyMap<string, MeasurementItemDef> = new Map(
  MEASUREMENT_ITEMS.map((item) => [item.code, item]),
);
