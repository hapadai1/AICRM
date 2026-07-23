/**
 * 채촌 항목 코드 초기값 (데이터모델설계서 §9.4).
 * 코드는 자유 수용하되, 알려진 코드는 분류·화면명·정렬 순서를 자동 보완한다.
 */
export type BodySection = 'UPPER' | 'LOWER' | 'SHIRT' | 'SHOES';

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
  { code: 'JACKET_LENGTH', label: '상의장', bodySection: 'UPPER', valueType: 'NUMERIC', sortOrder: 10 },
  { code: 'SHOULDER', label: '어깨', bodySection: 'UPPER', valueType: 'NUMERIC', sortOrder: 20 },
  { code: 'FRONT_WIDTH', label: '앞품', bodySection: 'UPPER', valueType: 'NUMERIC', sortOrder: 30 },
  { code: 'BACK_WIDTH', label: '뒤품', bodySection: 'UPPER', valueType: 'NUMERIC', sortOrder: 40 },
  { code: 'CHEST_UPPER', label: '상동', bodySection: 'UPPER', valueType: 'NUMERIC', sortOrder: 50 },
  { code: 'CHEST_MID', label: '중동', bodySection: 'UPPER', valueType: 'NUMERIC', sortOrder: 60 },
  { code: 'CHEST_LOW', label: '하동', bodySection: 'UPPER', valueType: 'NUMERIC', sortOrder: 70 },
  { code: 'SLEEVE_LEFT', label: '소매길이(좌)', bodySection: 'UPPER', valueType: 'NUMERIC', sortOrder: 80 },
  { code: 'SLEEVE_RIGHT', label: '소매길이(우)', bodySection: 'UPPER', valueType: 'NUMERIC', sortOrder: 90 },
  { code: 'SLEEVE_WIDTH', label: '소매통', bodySection: 'UPPER', valueType: 'NUMERIC', sortOrder: 100 },
  { code: 'SLEEVE_OPENING', label: '소매부리', bodySection: 'UPPER', valueType: 'NUMERIC', sortOrder: 110 },
  // 하의
  { code: 'WAIST', label: '허리', bodySection: 'LOWER', valueType: 'NUMERIC', sortOrder: 210 },
  { code: 'HIP', label: '엉덩이둘레', bodySection: 'LOWER', valueType: 'NUMERIC', sortOrder: 220 },
  { code: 'THIGH', label: '허벅둘레', bodySection: 'LOWER', valueType: 'NUMERIC', sortOrder: 230 },
  { code: 'FRONT_RISE', label: '앞밑윗길이', bodySection: 'LOWER', valueType: 'NUMERIC', sortOrder: 240 },
  { code: 'BACK_RISE', label: '뒤밑윗길이', bodySection: 'LOWER', valueType: 'NUMERIC', sortOrder: 250 },
  { code: 'KNEE', label: '무릎둘레', bodySection: 'LOWER', valueType: 'NUMERIC', sortOrder: 260 },
  { code: 'PANTS_OPENING', label: '바지부리', bodySection: 'LOWER', valueType: 'NUMERIC', sortOrder: 270 },
  { code: 'PANTS_LENGTH', label: '바지기장', bodySection: 'LOWER', valueType: 'NUMERIC', sortOrder: 280 },
  // 셔츠
  { code: 'SHIRT_NECK', label: '목', bodySection: 'SHIRT', valueType: 'NUMERIC', sortOrder: 300 },
  { code: 'SHIRT_SHOULDER', label: '어깨', bodySection: 'SHIRT', valueType: 'NUMERIC', sortOrder: 310 },
  { code: 'SHIRT_CHEST_UPPER', label: '상동', bodySection: 'SHIRT', valueType: 'NUMERIC', sortOrder: 320 },
  { code: 'SHIRT_CHEST_MID', label: '중동', bodySection: 'SHIRT', valueType: 'NUMERIC', sortOrder: 330 },
  { code: 'SHIRT_SLEEVE', label: '소매', bodySection: 'SHIRT', valueType: 'NUMERIC', sortOrder: 340 },
  { code: 'SHIRT_LENGTH', label: '기장', bodySection: 'SHIRT', valueType: 'NUMERIC', sortOrder: 350 },
  { code: 'SHIRT_CUFF', label: '카우스', bodySection: 'SHIRT', valueType: 'NUMERIC', sortOrder: 360 },
  { code: 'SHIRT_ARM', label: '팔통', bodySection: 'SHIRT', valueType: 'NUMERIC', sortOrder: 370 },
  // 구두
  { code: 'SHOE_SIZE', label: '신발 사이즈', bodySection: 'SHOES', valueType: 'ANY', sortOrder: 410 },
];

export const MEASUREMENT_ITEM_MAP: ReadonlyMap<string, MeasurementItemDef> = new Map(
  MEASUREMENT_ITEMS.map((item) => [item.code, item]),
);
