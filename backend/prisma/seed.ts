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
  { code: 'CONTRACT_REVISE', name: '계약 변경', description: '변경계약 버전 작성·확정' },
  { code: 'CONTRACT_CANCEL', name: '계약 취소', description: '계약 취소 처리' },
  { code: 'ORDER_VIEW', name: '주문 조회', description: '주문·품목·구성품 조회' },
  { code: 'ORDER_EDIT', name: '주문 편집', description: '주문·품목·구성품 관리' },
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
  { code: 'PAYMENT_VIEW', name: '결제 조회', description: '결제 내역 조회' },
  { code: 'PAYMENT_EDIT', name: '결제 편집', description: '결제 등록·수정·취소' },
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
const APPOINTMENT_PURPOSES: Array<{ code: string; name: string }> = [
  { code: 'INITIAL_CONSULTATION', name: '초도상담' },
  { code: 'FITTING', name: '가봉·피팅' },
  { code: 'PICKUP', name: '완제품 픽업' },
  { code: 'REPAIR_RECEIPT', name: '수선 접수' },
  { code: 'REPAIR_PICKUP', name: '수선 픽업' },
  { code: 'RENTAL_PICKUP', name: '렌탈 픽업' },
  { code: 'RENTAL_RETURN', name: '렌탈 반납' },
  // 설계 PDF 1페이지 고객 열 대응 (개발설계서 05 G-08)
  { code: 'RENTAL_CONSULTATION', name: '렌탈 상담' },
  { code: 'RENTAL_MEASUREMENT', name: '렌탈 채촌' },
  { code: 'REPAIR_PICKUP_VISIT', name: '수선 방문수거' },
  { code: 'REPAIR_DELIVERY_VISIT', name: '수선 방문배송' },
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
    code: 'WEDDING_PACKAGE_RENTAL',
    name: '웨딩패키지 렌탈',
    description: '웨딩 정장·구두 렌탈 패키지 계약',
    sortOrder: 2,
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
  console.log(`appointment_purposes: ${APPOINTMENT_PURPOSES.length}건`);
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
  await seedOptionSets();
  await seedContractTypes();
  await seedJourneyStages(prisma);
  console.log(`notification_templates(단계 연락): ${STAGE_TEMPLATES.length}건`);
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
