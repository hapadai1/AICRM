/**
 * AICRM 초기 시드 데이터
 * - 재실행 안전(upsert 기반)
 * - 실행: ts-node prisma/seed.ts (또는 prisma db seed 설정)
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { JOURNEY_STAGES, STAGE_TEMPLATES, seedJourneyStages } from './journey-stage-seed';

const prisma = new PrismaClient();

// -----------------------------------------------------------------------------
// 1) 권한 정의
// -----------------------------------------------------------------------------
const PERMISSIONS: Array<{ code: string; name: string; description: string }> = [
  { code: 'DASHBOARD_VIEW', name: '대시보드 조회', description: '대시보드 화면 조회' },
  { code: 'DASHBOARD_EDIT', name: '대시보드 처리', description: '대시보드 할 일 확인·보류·완료 처리 및 공유 메모 관리' },
  { code: 'STATS_VIEW', name: '통계 조회', description: '건수 통계 차트 조회' },
  { code: 'APPOINTMENT_VIEW', name: '예약 조회', description: '예약 캘린더·목록 조회' },
  { code: 'APPOINTMENT_EDIT', name: '예약 편집', description: '예약 등록·수정·취소' },
  { code: 'NAVER_SYNC', name: '네이버 동기화', description: '네이버 예약 수동 동기화 실행' },
  { code: 'CONSULTATION_EDIT', name: '상담 편집', description: '상담 기록 등록·수정' },
  { code: 'CUSTOMER_VIEW', name: '고객 조회', description: '고객 목록·상세 조회' },
  { code: 'CUSTOMER_EDIT', name: '고객 편집', description: '고객 정보 등록·수정' },
  { code: 'CUSTOMER_DEACTIVATE', name: '고객 비활성화', description: '고객 비활성 처리' },
  { code: 'CONTRACT_TYPE_EDIT', name: '계약 구분 편집', description: '계약 구분 마스터·기본 품목 관리' },
  { code: 'CONTRACT_VIEW', name: '계약 조회', description: '계약 목록·상세·버전 조회' },
  { code: 'CONTRACT_CREATE', name: '계약 작성', description: '신규 계약 초안 작성' },
  { code: 'CONTRACT_EDIT', name: '계약 편집', description: '계약 초안 수정' },
  { code: 'CONTRACT_CONFIRM', name: '계약 확정', description: '계약 버전 확정' },
  { code: 'CONTRACT_SIGN', name: '계약 서명', description: '계약 버전 전자서명 저장·제거' },
  { code: 'CONTRACT_REVISE', name: '계약 변경', description: '변경계약 버전 작성·확정' },
  { code: 'CONTRACT_CANCEL', name: '계약 취소', description: '계약 취소 처리' },
  { code: 'CONTRACT_DELETE', name: '계약 삭제', description: '임시저장·취소 계약 삭제 (진행 이력 없을 때)' },
  { code: 'OPTION_SELECT', name: '옵션 선택', description: '고객 옵션 선택·임시저장·확인서 확정' },
  { code: 'OPTION_MASTER_EDIT', name: '옵션 마스터 편집', description: '옵션 세트·버전·단계·선택지 관리' },
  { code: 'MEASUREMENT_VIEW', name: '채촌 조회', description: '채촌 세션·치수 조회·비교' },
  { code: 'MEASUREMENT_EDIT', name: '채촌 편집', description: '채촌 세션 등록·품목 연결' },
  { code: 'WORK_ORDER_VIEW', name: '작업지시서 조회', description: '작업지시서 버전·스냅샷 조회' },
  { code: 'WORK_ORDER_ISSUE', name: '작업지시서 출력', description: '작업지시서 Excel 출력·공장 전달 처리' },
  { code: 'PRODUCTION_VIEW', name: '제작 조회', description: '제작·입출고 상태 조회' },
  { code: 'PRODUCTION_EDIT', name: '제작 편집', description: '제작·가봉·입고·출고 상태 처리' },
  { code: 'FITTING_VIEW', name: '가봉 조회', description: '가봉 세션·보정 내용 조회' },
  { code: 'FITTING_EDIT', name: '가봉 편집', description: '가봉 세션·보정 지시 등록·수정' },
  { code: 'RENTAL_VIEW', name: '렌탈 조회', description: '렌탈 SKU·실물·배정 조회' },
  { code: 'RENTAL_EDIT', name: '렌탈 편집', description: '렌탈 SKU·실물 등록·수정' },
  { code: 'RENTAL_ALLOCATE', name: '렌탈 배정', description: '렌탈 실물 기간 배정·교체' },
  { code: 'RENTAL_CHECKOUT', name: '렌탈 출고', description: '렌탈 실물 출고 처리' },
  { code: 'RENTAL_RETURN', name: '렌탈 반납', description: '렌탈 실물 반납 처리' },
  { code: 'RENTAL_STATUS_EDIT', name: '렌탈 상태 편집', description: '렌탈 실물 상태·대여 가능일 변경' },
  { code: 'REPAIR_VIEW', name: '수선 조회', description: '수선 요청·이력 조회' },
  { code: 'REPAIR_EDIT', name: '수선 편집', description: '수선 접수·상태·비용 처리' },
  { code: 'NOTIFICATION_VIEW', name: '알림 조회', description: '알림 템플릿·발송 이력 조회' },
  { code: 'NOTIFICATION_SEND', name: '알림 발송', description: '알림톡/SMS 발송·규칙 관리' },
  { code: 'USER_ADMIN', name: '사용자 관리', description: '사용자 계정 등록·잠금·비활성화' },
  { code: 'ROLE_ADMIN', name: '역할 관리', description: '역할·권한 매핑 관리' },
  { code: 'ADMIN_MASTER_EDIT', name: '기준정보 관리', description: '예약 목적 등 기준정보 관리' },
  { code: 'AUDIT_LOG_VIEW', name: '감사로그 조회', description: '감사로그 조회' },
  { code: 'FILE_UPLOAD', name: '파일 업로드', description: '파일 업로드' },
  { code: 'FILE_DELETE', name: '파일 삭제', description: '파일 삭제·연결 해제' },
  { code: 'JOURNEY_EDIT', name: '진행 단계 변경', description: '고객 진행 단계 시작·전진·되돌리기·종료' },
];

// -----------------------------------------------------------------------------
// 2) 역할 정의
// -----------------------------------------------------------------------------
const ALL_CODES = PERMISSIONS.map((p) => p.code);

const ROLES: Array<{ code: string; name: string; description: string; permissionCodes: string[] }> = [
  {
    code: 'SUPER_ADMIN',
    name: '최고 관리자',
    description: '모든 권한 보유',
    permissionCodes: ALL_CODES,
  },
  {
    code: 'MANAGER',
    name: '매니저',
    description: '사용자·역할 관리를 제외한 전체 권한',
    permissionCodes: ALL_CODES.filter((c) => c !== 'USER_ADMIN' && c !== 'ROLE_ADMIN'),
  },
  {
    code: 'STAFF',
    name: '직원',
    description: '조회 전체와 예약·상담·고객·옵션·채촌·진행단계·파일 업로드 권한',
    permissionCodes: [
      ...ALL_CODES.filter((c) => c.endsWith('_VIEW')),
      'APPOINTMENT_EDIT',
      'CONSULTATION_EDIT',
      'CUSTOMER_EDIT',
      'OPTION_SELECT',
      'MEASUREMENT_EDIT',
      // 진행 단계 변경은 현장 담당자의 일상 업무다 (개발설계서 05 G-11)
      'JOURNEY_EDIT',
      'FILE_UPLOAD',
    ],
  },
];

// -----------------------------------------------------------------------------
// 4) 예약 목적 초기값
// -----------------------------------------------------------------------------
/**
 * 예약 목적 초기값 — v2 진행상태(journey-stage-seed `JOURNEY_STAGES`) 용어에 맞춘다.
 * 정렬은 트랙 순서(맞춤 → 렌탈 → 수선), 트랙 안에서는 단계 순서를 따른다.
 * 코드는 기존 예약이 참조하므로 바꾸지 않고 표시명·정렬만 맞춘다.
 */
const APPOINTMENT_PURPOSES: Array<{ code: string; name: string }> = [
  // 맞춤(CUSTOM 트랙)
  { code: 'INITIAL_CONSULTATION', name: '맞춤 상담' }, // CONSULT_RESERVED 상담 예약
  { code: 'STYLE_CONSULTING', name: '스타일 컨설팅' }, // STYLE_CONSULTING (맞춤·렌탈 공통 단계)
  { code: 'MEASUREMENT', name: '채촌' }, // 스타일 컨설팅 단계의 채촌 방문 (맞춤·렌탈 공통)
  { code: 'FITTING', name: '가봉 피팅' }, // FITTING_DONE
  { code: 'PICKUP', name: '완성복 출고' }, // RELEASED 완성복 출고/완료
  // 렌탈(RENTAL 트랙)
  { code: 'RENTAL_CONSULTATION', name: '렌탈 상담' }, // CONSULT_RESERVED 렌탈 상담 예약
  { code: 'RENTAL_PICKUP', name: '렌탈 수선 출고' }, // RENTAL_REPAIR_CHECKED_OUT
  { code: 'RENTAL_RETURN', name: '렌탈 반납' }, // RENTAL_RETURNED 렌탈 수선 반납/완료
  // 수선(REPAIR 트랙)
  { code: 'REPAIR_RECEIPT', name: '수선 접수' }, // REPAIR_RECEIVED
  { code: 'REPAIR_PICKUP', name: '수선 출고' }, // REPAIR_RELEASED 수선 출고/완료
];

/**
 * v2 정리로 은퇴하는 예약 목적 (물리삭제 금지 → active:false).
 * 기존 예약은 목적 관계를 그대로 두므로 화면 표시명도 유지된다.
 */
const RETIRED_APPOINTMENT_PURPOSES: Array<{ code: string; reason: string }> = [
  { code: 'RENTAL_MEASUREMENT', reason: '맞춤·렌탈 공통 MEASUREMENT(채촌)로 통합' },
  { code: 'REPAIR_PICKUP_VISIT', reason: '수선 접수 방식 receiptMethod=PICKUP과 중복' },
  { code: 'REPAIR_DELIVERY_VISIT', reason: '수선 출고 방식 releaseMethod=DELIVERY와 중복' },
];

// -----------------------------------------------------------------------------
// 5) 옵션 세트 초기값
// -----------------------------------------------------------------------------
const OPTION_SETS: Array<{ productCategory: string; name: string }> = [
  { productCategory: 'SUIT', name: '정장 옵션' },
  { productCategory: 'SHIRT', name: '셔츠 옵션' },
  { productCategory: 'SHOES', name: '구두 옵션' },
];

// -----------------------------------------------------------------------------
// 6) 계약 구분 초기값
// -----------------------------------------------------------------------------
const CONTRACT_TYPES: Array<{
  code: string;
  name: string;
  description: string;
  sortOrder: number;
  lines: Array<{ transactionType: string; productCategory: string; defaultQuantity: number; sortOrder: number }>;
}> = [
  {
    code: 'BUSINESS_SUIT_CUSTOM',
    name: '비즈니스 정장 맞춤',
    description: '비즈니스 정장 맞춤 제작 계약',
    sortOrder: 1,
    lines: [{ transactionType: 'CUSTOM', productCategory: 'SUIT', defaultQuantity: 1, sortOrder: 1 }],
  },
  {
    code: 'SHOES_CUSTOM',
    name: '구두 맞춤',
    description: '구두 맞춤 제작 계약',
    sortOrder: 2,
    lines: [{ transactionType: 'CUSTOM', productCategory: 'SHOES', defaultQuantity: 1, sortOrder: 1 }],
  },
  {
    code: 'SUIT_SHOES_CUSTOM',
    name: '정장·구두 맞춤',
    description: '정장과 구두를 함께 맞추는 계약',
    sortOrder: 3,
    lines: [
      { transactionType: 'CUSTOM', productCategory: 'SUIT', defaultQuantity: 1, sortOrder: 1 },
      { transactionType: 'CUSTOM', productCategory: 'SHOES', defaultQuantity: 1, sortOrder: 2 },
    ],
  },
  {
    code: 'WEDDING_PACKAGE_RENTAL',
    name: '웨딩패키지 렌탈',
    description: '웨딩 정장·구두 렌탈 패키지 계약',
    sortOrder: 4,
    lines: [
      { transactionType: 'RENTAL', productCategory: 'SUIT', defaultQuantity: 1, sortOrder: 1 },
      { transactionType: 'RENTAL', productCategory: 'SHOES', defaultQuantity: 1, sortOrder: 2 },
    ],
  },
];

async function seedPermissions(): Promise<Map<string, string>> {
  const idsByCode = new Map<string, string>();
  for (const p of PERMISSIONS) {
    const row = await prisma.permission.upsert({
      where: { code: p.code },
      update: { name: p.name, description: p.description },
      create: { id: randomUUID(), code: p.code, name: p.name, description: p.description },
    });
    idsByCode.set(row.code, row.id);
  }
  console.log(`permissions: ${idsByCode.size}건`);
  return idsByCode;
}

async function seedRoles(permissionIdsByCode: Map<string, string>): Promise<Map<string, string>> {
  const roleIdsByCode = new Map<string, string>();
  for (const r of ROLES) {
    const role = await prisma.role.upsert({
      where: { code: r.code },
      update: { name: r.name, description: r.description },
      create: { id: randomUUID(), code: r.code, name: r.name, description: r.description },
    });
    roleIdsByCode.set(role.code, role.id);

    for (const permCode of r.permissionCodes) {
      const permissionId = permissionIdsByCode.get(permCode);
      if (!permissionId) {
        throw new Error(`알 수 없는 권한 코드: ${permCode}`);
      }
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        update: {},
        create: { roleId: role.id, permissionId },
      });
    }
  }
  console.log(`roles: ${roleIdsByCode.size}건 (권한 매핑 포함)`);
  return roleIdsByCode;
}

async function seedAdminUser(roleIdsByCode: Map<string, string>): Promise<void> {
  const passwordHash = await bcrypt.hash('admin1234!', 10);
  const admin = await prisma.user.upsert({
    where: { loginId: 'admin' },
    update: { displayName: '관리자', status: 'ACTIVE' },
    create: {
      id: randomUUID(),
      loginId: 'admin',
      displayName: '관리자',
      passwordHash,
      status: 'ACTIVE',
    },
  });

  const superAdminRoleId = roleIdsByCode.get('SUPER_ADMIN');
  if (!superAdminRoleId) {
    throw new Error('SUPER_ADMIN 역할이 존재하지 않습니다.');
  }
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: admin.id, roleId: superAdminRoleId } },
    update: {},
    create: { userId: admin.id, roleId: superAdminRoleId },
  });
  console.log(`admin 계정: ${admin.loginId} (SUPER_ADMIN)`);
}

async function seedAppointmentPurposes(): Promise<void> {
  for (let i = 0; i < APPOINTMENT_PURPOSES.length; i += 1) {
    const p = APPOINTMENT_PURPOSES[i];
    await prisma.appointmentPurpose.upsert({
      where: { code: p.code },
      update: { name: p.name, sortOrder: i + 1, active: true },
      create: { id: randomUUID(), code: p.code, name: p.name, sortOrder: i + 1, active: true },
    });
  }
  const retired = await prisma.appointmentPurpose.updateMany({
    where: { code: { in: RETIRED_APPOINTMENT_PURPOSES.map((p) => p.code) }, active: true },
    data: { active: false },
  });
  console.log(`appointment_purposes: ${APPOINTMENT_PURPOSES.length}건 (은퇴 ${retired.count}건)`);
}

/*
 * 렌탈 기준정보 — 현업 확정본 (2026-07-29).
 *
 * 컬러 리스트의 "3피스 / 2피스 / 상의"는 색 이름이 아니라 그 색으로 몇 벌이 있는지다.
 *   3피스 → 상의·하의·베스트   2피스 → 상의·하의(베스트 없음)   상의 → 자켓만
 * 그래서 코드·이름에는 넣지 않고 componentTypes로만 표현한다. 코드는 색 그 자체다.
 *
 * 반대로 셔츠·구두의 SHIRT_/SHOE_ 접두어는 남긴다. 화이트·블랙·브라운이 정장 색과
 * 이름이 겹치는데 코드는 전역 유일이라, 어느 품목의 색인지 갈라 둬야 한다.
 */
const SUIT_3PC = ['JACKET', 'TROUSERS', 'VEST'];
const SUIT_2PC = ['JACKET', 'TROUSERS'];
const JACKET_ONLY = ['JACKET'];

/**
 * tone은 반납 후 정비(세탁) 소요일을 가른다 — LIGHT는 화이트·베이지 계열로 오염이 그대로
 * 보여 하루 더 잡는다(현업 확정 2026-08-01). 숄카라·스트라이프는 바탕색으로 판단하고,
 * 그레이·카키·하운투스는 블랙 타입으로 둔다. 소요일 자체는 rental_return_policies에 있다.
 */
const RENTAL_COLORS: Array<{ code: string; name: string; componentTypes: string[]; tone?: 'LIGHT' }> = [
  { code: 'BLACK', name: '블랙', componentTypes: SUIT_3PC },
  { code: 'CHARCOAL', name: '챠콜', componentTypes: SUIT_3PC },
  { code: 'NAVY', name: '네이비', componentTypes: SUIT_2PC },
  { code: 'GREY', name: '그레이', componentTypes: SUIT_3PC },
  { code: 'BROWN', name: '부라운', componentTypes: SUIT_3PC },
  { code: 'BEIGE', name: '베이지', componentTypes: SUIT_3PC, tone: 'LIGHT' },
  { code: 'KHAKI', name: '카키', componentTypes: SUIT_2PC },
  { code: 'WHITE', name: '화이트', componentTypes: SUIT_3PC, tone: 'LIGHT' },
  { code: 'WHITE_SHAWL', name: '화이트 숄카라', componentTypes: JACKET_ONLY, tone: 'LIGHT' },
  { code: 'VELVET', name: '벨벳', componentTypes: JACKET_ONLY },
  { code: 'BEIGE_STRIPE', name: '베이지 스트라이프', componentTypes: JACKET_ONLY, tone: 'LIGHT' },
  { code: 'HOUNDSTOOTH', name: '하운투스', componentTypes: JACKET_ONLY },
  // 셔츠·구두 전용 색
  { code: 'SHIRT_WHITE', name: '흰색', componentTypes: ['SHIRT'], tone: 'LIGHT' },
  { code: 'SHOE_BLACK', name: '검정', componentTypes: ['SHOES'] },
  { code: 'SHOE_BROWN', name: '브라운', componentTypes: ['SHOES'] },
];

/** 반납 후 정비 기준 — 한 행만 둔다. id는 백엔드 RENTAL_RETURN_POLICY_ID와 같아야 한다. */
const RENTAL_RETURN_POLICY = {
  id: '00000000-0000-4000-8000-00000000c1ea',
  lightCleaningDays: 2,
  darkCleaningDays: 1,
  autoRelease: true,
};

/*
 * 사이즈는 품목마다 체계가 다르다. 한 목록을 공유하면 상의 등록 화면에 구두 사이즈가 뜬다.
 *   상의·베스트 46~60(58 없음 — 현업 확정)  하의 80~104  셔츠 95~120  구두 250~280
 * 100은 하의와 셔츠가 함께 쓰므로 componentTypes에 둘 다 넣는다.
 */
const SUIT_TOP_SIZES = ['46', '48', '50', '52', '54', '56', '60'];
const TROUSER_SIZES = ['80', '84', '88', '92', '96', '100', '104'];
const SHIRT_SIZES = ['95', '100', '105', '110', '115', '120'];
const SHOE_SIZES = ['250', '255', '260', '265', '270', '275', '280'];

const RENTAL_SIZES: Array<{ code: string; name: string; componentTypes: string[] }> = (() => {
  const owners = new Map<string, string[]>();
  const claim = (codes: string[], types: string[]) => {
    for (const code of codes) owners.set(code, [...new Set([...(owners.get(code) ?? []), ...types])]);
  };
  claim(SUIT_TOP_SIZES, ['JACKET', 'VEST']);
  claim(TROUSER_SIZES, ['TROUSERS']);
  claim(SHIRT_SIZES, ['SHIRT']);
  claim(SHOE_SIZES, ['SHOES']);
  return [...owners.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([code, componentTypes]) => ({
      code,
      // 구두만 mm 체계다 — 정장 호수와 같이 "250호"로 부르면 화면에서 어색하다.
      name: componentTypes.includes('SHOES') ? `${code}mm` : `${code}호`,
      componentTypes,
    }));
})();

/**
 * 품목별 보유 수량 — 같은 컬러·사이즈로 몇 벌을 갖고 있는지 (현업 확정 2026-07-29).
 * 정장 3종은 조합마다 3벌, 셔츠·구두는 1벌씩이다.
 */
const STOCK_PER_SKU: Record<string, number> = {
  JACKET: 3,
  TROUSERS: 3,
  VEST: 3,
  SHIRT: 1,
  SHOES: 1,
};

/** 관리코드 접두어 — `{접두어}-{컬러}-{사이즈}-001`(수량만큼 연번) */
const CODE_PREFIX: Record<string, string> = {
  JACKET: 'JKT',
  TROUSERS: 'TRS',
  VEST: 'VST',
  SHIRT: 'SHT',
  SHOES: 'SHO',
};

async function seedRentalColors(): Promise<void> {
  for (let i = 0; i < RENTAL_COLORS.length; i += 1) {
    const c = RENTAL_COLORS[i];
    const data = {
      name: c.name,
      componentTypes: c.componentTypes,
      tone: c.tone ?? 'DARK',
      sortOrder: i + 1,
      active: true,
    };
    await prisma.rentalColor.upsert({
      where: { code: c.code },
      update: data,
      create: { id: randomUUID(), code: c.code, ...data },
    });
  }
  // 확정 목록에 없는 예전 색(블루·버건디 등)은 물리삭제하지 않고 비활성으로 내린다.
  const codes = RENTAL_COLORS.map((c) => c.code);
  const deactivated = await prisma.rentalColor.updateMany({
    where: { code: { notIn: codes }, active: true },
    data: { active: false },
  });
  console.log(`rental_colors: ${RENTAL_COLORS.length}건 (예전 색 ${deactivated.count}건 비활성)`);
}

/**
 * 렌탈 고객 연락 문구 — 픽업 안내·반납 독촉을 가르지 않고 하나만 둔다.
 * 상황에 따라 다르게 쓸 일은 담당자가 발송 확인창에서 그 자리에서 고친다
 * (현업 확정 2026-08-03). 운영 중 수정분은 시드 재실행 때 덮지 않는다.
 */
async function seedRentalNoticeTemplate(): Promise<void> {
  const body = `안녕하세요, #{고객명} 고객님🤗
슈트에이전시입니다.

대여 品 #{품목} (#{규격}) 관련 안내드립니다.
· 픽업 예정일 : #{픽업일}
· 반납 예정일 : #{반납예정일}

문의는 카카오 채널로 주시면 신속하게 도와드리겠습니다.
❖슈트에이전시 카카오 채널: http://pf.kakao.com/_VUxaAX
❖슈트에이전시 쇼룸 : 02-6409-4799`;
  await prisma.notificationTemplate.upsert({
    where: { code: 'RENTAL_NOTICE' },
    update: {},
    create: {
      id: randomUUID(),
      code: 'RENTAL_NOTICE',
      name: '렌탈 안내',
      channel: 'ALIMTALK',
      body,
      approvalStatus: 'PENDING',
    },
  });
  console.log('notification_templates(렌탈 안내): 1건');
}

/** 정비 기준은 관리자가 화면에서 바꾸는 값이라, 이미 있으면 덮지 않는다. */
async function seedRentalReturnPolicy(): Promise<void> {
  const { id, ...defaults } = RENTAL_RETURN_POLICY;
  await prisma.rentalReturnPolicy.upsert({ where: { id }, update: {}, create: { id, ...defaults } });
  console.log(
    `rental_return_policies: 밝은색 ${defaults.lightCleaningDays}일 / 블랙 타입 ${defaults.darkCleaningDays}일`,
  );
}

async function seedRentalSizes(): Promise<void> {
  for (let i = 0; i < RENTAL_SIZES.length; i += 1) {
    const s = RENTAL_SIZES[i];
    const data = { name: s.name, componentTypes: s.componentTypes, sortOrder: i + 1, active: true };
    await prisma.rentalSize.upsert({
      where: { code: s.code },
      update: data,
      create: { id: randomUUID(), code: s.code, ...data },
    });
  }
  // F3: S~XXL·90호 등 예전 사이즈 행은 물리삭제하지 않고 비활성 처리.
  const codes = RENTAL_SIZES.map((s) => s.code);
  const deactivated = await prisma.rentalSize.updateMany({
    where: { code: { notIn: codes }, active: true },
    data: { active: false },
  });
  console.log(`rental_sizes: ${RENTAL_SIZES.length}건 (예전 사이즈 ${deactivated.count}건 비활성)`);
}

/**
 * 렌탈 실물 재고 — 컬러 × 사이즈 전개, 각 1개 (현업 확정 2026-07-29).
 * 어떤 색에 어떤 옷이 있는지는 컬러의 componentTypes가, 품목별 사이즈는 사이즈의
 * componentTypes가 이미 알고 있으므로 둘을 맞물려 조합을 만든다.
 */
async function seedRentalInventory(): Promise<void> {
  const rows: Array<{ componentType: string; color: string; size: string; code: string }> = [];
  for (const componentType of Object.keys(CODE_PREFIX)) {
    const colors = RENTAL_COLORS.filter((c) => c.componentTypes.includes(componentType));
    const sizes = RENTAL_SIZES.filter((s) => s.componentTypes.includes(componentType));
    const quantity = STOCK_PER_SKU[componentType] ?? 1;
    for (const c of colors) {
      for (const s of sizes) {
        // 같은 조합을 여러 벌 보유하므로 관리코드는 연번(-001, -002, …)으로 가른다.
        for (let n = 1; n <= quantity; n += 1) {
          rows.push({
            componentType,
            color: c.code,
            size: s.code,
            code: `${CODE_PREFIX[componentType]}-${c.code}-${s.code}-${String(n).padStart(3, '0')}`,
          });
        }
      }
    }
  }

  for (const row of rows) {
    const sku = await prisma.rentalSku.upsert({
      where: {
        componentType_color_size: {
          componentType: row.componentType,
          color: row.color,
          size: row.size,
        },
      },
      update: {},
      create: {
        id: randomUUID(),
        componentType: row.componentType,
        color: row.color,
        size: row.size,
      },
    });
    // 관리코드는 살아 있는 실물끼리만 유일해서 upsert(unique 기준)를 쓸 수 없다.
    // 폐기 이력이 같은 코드로 남아 있어도 살아 있는 게 없으면 새로 만든다.
    const alive = await prisma.rentalInventoryItem.findFirst({
      where: { managementCode: row.code, status: { not: 'RETIRED' } },
      select: { id: true },
    });
    if (!alive) {
      await prisma.rentalInventoryItem.create({
        data: {
          id: randomUUID(),
          managementCode: row.code,
          rentalSkuId: sku.id,
          status: 'AVAILABLE',
          active: true,
        },
      });
    }
  }

  const byType = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.componentType] = (acc[r.componentType] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(byType)
    .map(([t, n]) => `${t} ${n}`)
    .join(', ');
  console.log(`rental_inventory_items: ${rows.length}건 (${summary})`);
}

async function seedOptionSets(): Promise<void> {
  for (const s of OPTION_SETS) {
    await prisma.optionSet.upsert({
      where: { productCategory: s.productCategory },
      update: { name: s.name },
      create: {
        id: randomUUID(),
        productCategory: s.productCategory,
        name: s.name,
        activeVersionId: null,
      },
    });
  }
  console.log(`option_sets: ${OPTION_SETS.length}건`);
}

async function seedContractTypes(): Promise<void> {
  for (const t of CONTRACT_TYPES) {
    const contractType = await prisma.contractType.upsert({
      where: { code: t.code },
      update: { name: t.name, description: t.description, sortOrder: t.sortOrder, active: true },
      create: {
        id: randomUUID(),
        code: t.code,
        name: t.name,
        description: t.description,
        sortOrder: t.sortOrder,
        active: true,
      },
    });

    for (const line of t.lines) {
      const existing = await prisma.contractTypeLine.findFirst({
        where: {
          contractTypeId: contractType.id,
          transactionType: line.transactionType,
          productCategory: line.productCategory,
        },
      });
      if (existing) {
        await prisma.contractTypeLine.update({
          where: { id: existing.id },
          data: { defaultQuantity: line.defaultQuantity, sortOrder: line.sortOrder, active: true },
        });
      } else {
        await prisma.contractTypeLine.create({
          data: {
            id: randomUUID(),
            contractTypeId: contractType.id,
            transactionType: line.transactionType,
            productCategory: line.productCategory,
            defaultQuantity: line.defaultQuantity,
            sortOrder: line.sortOrder,
            active: true,
          },
        });
      }
    }
  }
  console.log(`contract_types: ${CONTRACT_TYPES.length}건 (기본 품목 포함)`);
}

async function main(): Promise<void> {
  const permissionIdsByCode = await seedPermissions();
  const roleIdsByCode = await seedRoles(permissionIdsByCode);
  await seedAdminUser(roleIdsByCode);
  await seedAppointmentPurposes();
  await seedRentalColors();
  await seedRentalSizes();
  await seedRentalReturnPolicy();
  await seedRentalNoticeTemplate();
  await seedRentalInventory();
  await seedOptionSets();
  await seedContractTypes();
  await seedJourneyStages(prisma);
  console.log(`notification_templates(연락 문구 고정메시지): ${STAGE_TEMPLATES.length}건`);
  console.log(`journey_stages: ${JOURNEY_STAGES.length}건`);
  console.log('시드 완료');
}

main()
  .catch((error) => {
    console.error('시드 실패:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
