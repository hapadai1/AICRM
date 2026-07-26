/**
 * 실물 공장 양식(`docs/data/정장작업지시서 .xlsx` · 송파 시트) ↔ AICRM 데이터 매핑표.
 *
 * 양식은 셀 병합·인쇄영역·도식 이미지가 고정된 서식이라 새로 그리지 않고
 * `templates/suit-work-order.xlsx`(원본에서 송파 시트만 남긴 사본)를 **템플릿으로 열어
 * 값 칸만 채운다**. 좌표는 전부 병합 블록의 좌상단 셀이다.
 *
 * 여기서 매핑하지 않은 칸은 현재 DB에 대응 항목이 없어 **비워 둔다**(NOT_FILLABLE 참고).
 */

/** 값 칸 좌표 (병합 블록의 좌상단) */
export const CELL = {
  storeName: 'L1',
  customerName: 'AP1',
  bodySpec: 'J3', // 키/몸무게
  ageGroup: 'Y3',
  phone: 'AP3',

  orderDate: 'H6',
  fittingDate: 'O6',
  fittingDeliveryDate: 'W6',
  completionDate: 'AE6',
  jacketQty: 'AN6',
  trousersQty: 'AV6',
  vestQty: 'BE6',

  upperGaugeSize: 'K11',
  upperFabricName: 'AD12',
  upperFabricCode: 'AL12',
  upperFabricColor: 'AX12',
  upperFabricPattern: 'BE12',

  // 상의 옵션
  button: 'AA20',
  lining: 'AG20',
  uncon: 'AN20',
  hoshi: 'AU20', // 호시(스티치)
  sleeveSeppa: 'BA20',
  lapelSeppa: 'BF20',
  hakgo: 'AO23',
  armShape: 'AV23',
  lapelWidth: 'AB24',
  lapelShape: 'AB26',
  extraCollar: 'AB28',
  singleButtonCount: 'AA31',
  doubleButtonCount: 'AD31',
  pocketFlap: 'AB35',
  pocketOut: 'AE35',
  pocketJetted: 'AB37', // 입술
  pocketMini: 'AE37',
  shoulderShape: 'BE25',
  sleeveButtonCount: 'BF29',
  sleeveButtonStyle: 'BF32',
  ventStyle: 'BE37',
  upperNote: 'AA41',

  vestSize: 'K44',

  // 하의
  lowerGaugeSize: 'K51',
  lowerFabricName: 'AD52',
  lowerFabricCode: 'AL52',
  lowerFabricColor: 'AX52',
  lowerFabricPattern: 'BE52',
  lowerPattern: 'I55',
  obiWidth: 'AD55',
  legShape: 'AV55',
  legBodyType: 'BE55',
  toeShape: 'AA60',
  bijoLength: 'AD60',
  pleatCount: 'BE60',
  beltLoop: 'AA64',
  backPocketButton: 'BE64',
  frontPocketShape: 'AA68',
  cabra: 'BE68',
  cabraWidth: 'BF70',
  sideAdjustLabel: 'AA71',
  lowerNote: 'AA75',
} as const;

/** 채촌 표: 코드 → 행 번호. 값은 '신체' 열(F)에 쓴다(채촌=신체 치수). */
export const BODY_COLUMN = 'F';

export const UPPER_MEASUREMENT_ROWS: ReadonlyArray<readonly [string, number]> = [
  ['JACKET_LENGTH', 21],
  ['SHOULDER', 23],
  ['FRONT_WIDTH', 25],
  ['BACK_WIDTH', 27],
  ['CHEST_UPPER', 29],
  ['CHEST_MID', 31],
  ['CHEST_LOW', 33],
  ['SLEEVE_LEFT', 35],
  ['SLEEVE_RIGHT', 37],
  ['SLEEVE_WIDTH', 39],
  ['SLEEVE_OPENING', 41],
];

export const LOWER_MEASUREMENT_ROWS: ReadonlyArray<readonly [string, number]> = [
  ['WAIST', 61],
  ['HIP', 63],
  ['THIGH', 65],
  ['FRONT_RISE', 67],
  ['BACK_RISE', 69],
  ['KNEE', 71],
  ['PANTS_OPENING', 73],
  ['PANTS_LENGTH', 75],
];

export const MEASUREMENT_ROW_MAP: ReadonlyMap<string, number> = new Map([
  ...UPPER_MEASUREMENT_ROWS,
  ...LOWER_MEASUREMENT_ROWS,
]);

/**
 * 신체열(F)에 넣지 않고 **하의 추가요청사항**(AA75=CELL.lowerNote)에 라벨과 함께 쓰는
 * 채촌 코드 (설계서 05 §2.2). 앞마다/뒷마다는 신체 치수 행이 아니라 하의 요청사항 칸에
 * "앞: n / 뒤: n" 형태로 명시 출력한다.
 *
 * TODO(설계서 05 M1): cm/inch 완성(인치) 열 좌표(FINISH_INCH_COLUMN)는 템플릿 실측 미확정이라
 * 이번 범위에서 제외한다. 완성인치 매핑은 좌표 확정 후 별도 반영.
 */
export const LOWER_NOTE_MEASUREMENTS: ReadonlyArray<readonly [string, string]> = [
  ['FRONT_MADA', '앞'],
  ['BACK_MADA', '뒤'],
];
export const LOWER_NOTE_MEASUREMENT_MAP: ReadonlyMap<string, string> = new Map(
  LOWER_NOTE_MEASUREMENTS,
);

/**
 * 양식에 **값이 이미 인쇄돼 있어 건드리지 않는** 칸 (현업 확인 2026-07-23).
 * 채우지 못하는 칸이 아니라 "그대로 두는 것이 맞는" 칸이다.
 */
export const PREPRINTED_FIELDS: ReadonlyArray<{ section: string; label: string; printed: string }> = [
  { section: '기본', label: '매장명', printed: '슈트에이전시(강남본점)' },
  { section: '상의', label: '패턴선택', printed: 'sj2 신패턴' },
  { section: '상의', label: '어깨 특이사항', printed: '일반 / 보카시 / 카마치아' },
  { section: '상의', label: '소매세빠·라펠세빠', printed: '양식 인쇄값' },
  { section: '상의', label: '학고', printed: '바르카' },
  { section: '상의', label: '어깨모양', printed: '일반' },
  { section: '상의', label: '소매단추 개수', printed: '4개' },
  { section: '하의', label: '앞코모양', printed: '삼각' },
  { section: '하의', label: '뒷주머니단추', printed: '양쪽' },
  { section: '하의', label: '앞주머니모양', printed: '사선' },
];

/**
 * 양식에 빈칸이 있는데 대응 데이터가 없어 **공란으로 나가는** 항목.
 * 공장에 넘기기 전 손으로 채워야 한다. (docs/dev/12 §3과 동일 목록)
 */
export const NOT_FILLABLE_FIELDS: ReadonlyArray<{ section: string; label: string; reason: string }> = [
  { section: '기본', label: '키/몸무게', reason: 'Customer에 신장·체중 필드 없음' },
  { section: '기본', label: '연령대', reason: 'Customer에 생년월일·연령대 필드 없음' },
  { section: '기본', label: '가봉납품일', reason: '가봉 납품일 데이터 없음(FittingSession은 가봉일만 보유)' },
  { section: '기본', label: '게이지복 호(상의·하의)', reason: '게이지복 호수 관리 없음' },
  { section: '원단', label: '품번·색상·무늬(상의·하의)', reason: '원단이 자유입력 문자열(fabricName) 하나뿐 — 원단 마스터 없음' },
  { section: '상의', label: '총장', reason: '총장 데이터 없음' },
  { section: '상의', label: '패드(노패드~8MM)', reason: '옵션 세트에 패드 단계 없음' },
  { section: '상의', label: '덧카라', reason: '옵션 세트에 덧카라 단계 없음' },
  { section: '상의', label: '팔모양', reason: '체형 보정 항목 데이터 없음' },
  { section: '상의', label: '라펠 폭', reason: '라펠 단계는 모양(노치드/피크드/숄카라)만 보유' },
  { section: '상의', label: '싱글/더블 버튼 개수', reason: '단추 단계는 싱글/더블 구분만 보유(개수 없음)' },
  { section: '상의', label: '주머니 미니', reason: '포켓 단계에 미니 선택지 없음' },
  { section: '조끼', label: '조끼 상동·중동·조끼장', reason: '채촌 항목 카탈로그에 조끼 치수 없음' },
  { section: '하의', label: '패턴선택', reason: '하의 패턴 데이터 없음' },
  { section: '하의', label: '오비폭', reason: '옵션 세트에 오비폭 단계 없음' },
  { section: '하의', label: '비조길이', reason: '옵션 세트에 비조 단계 없음' },
  { section: '하의', label: '다리모양·다리체형', reason: '체형 보정 항목 데이터 없음' },
  { section: '하의', label: '카브라 폭', reason: '밑단 단계는 카브라 유무만 보유' },
  { section: '하의', label: '바지기장 앞/뒤', reason: '채촌은 PANTS_LENGTH 단일 값만 보유' },
  { section: '채촌', label: '수정·완성(인치)·완성(센치) 열', reason: '채촌은 신체 치수만 저장 — 수정치·완성치 데이터 없음' },
];
