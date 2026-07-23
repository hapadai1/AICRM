/** ADMIN-001/002/003, AUDIT-001 API (03문서 §13.8) */
import { request } from './client';
import type { ListResult } from './client';

// ---------------------------------------------------------------------------
// 기준정보 (ADMIN-001)
// ---------------------------------------------------------------------------

/**
 * 기준정보 slug — 예약 목적은 'appointment-purposes'(복수)로 통일 (계약 문서 04 §11).
 * appointment-purposes/payment-method 만 DB 마스터 테이블로 편집 가능하다.
 * product-category/component-type/repair-type 은 코드 상수로 정의돼 있어 읽기 전용이다.
 */
export type MasterType =
  | 'appointment-purposes'
  | 'product-category'
  | 'component-type'
  | 'payment-method'
  | 'repair-type';

export interface MasterItem {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  active: boolean;
  system: boolean;
}

export function fetchMaster(type: MasterType): Promise<MasterItem[]> {
  return request<MasterItem[]>({ url: `/admin/master/${type}` });
}

export function createMaster(
  type: MasterType,
  payload: { code: string; name: string; sortOrder?: number },
): Promise<MasterItem> {
  return request<MasterItem>({ url: `/admin/master/${type}`, method: 'POST', data: payload });
}

export function updateMaster(
  type: MasterType,
  id: string,
  payload: { name?: string; sortOrder?: number; active?: boolean },
): Promise<MasterItem> {
  return request<MasterItem>({ url: `/admin/master/${type}/${id}`, method: 'PATCH', data: payload });
}

export function retireMaster(type: MasterType, id: string): Promise<MasterItem> {
  return request<MasterItem>({ url: `/admin/master/${type}/${id}/retire`, method: 'POST' });
}

// ---------------------------------------------------------------------------
// 옵션 세트·버전 (ADMIN-002)
// ---------------------------------------------------------------------------

export type OptionSetVersionStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';

export interface OptionChoice {
  id: string;
  slot: 'A' | 'B';
  name: string;
  factoryName?: string;
  /** 저장 시 기존 이미지를 유지하기 위해 함께 보낸다 */
  imageFileId?: string;
  imageUrl: string | null;
}

export interface OptionStage {
  id: string;
  /** 백엔드 stage_code (신규 단계는 저장 시 이름에서 생성) */
  code: string;
  name: string;
  sortOrder: number;
  required: boolean;
  choices: OptionChoice[];
}

export interface OptionSetVersionSummary {
  id: string;
  optionSetId: string;
  versionNo: number;
  status: OptionSetVersionStatus;
  createdAt: string;
  activatedAt?: string;
  stageCount: number;
}

export interface OptionSetSummary {
  id: string;
  category: 'SUIT' | 'SHIRT' | 'SHOES';
  name: string;
  versions: OptionSetVersionSummary[];
}

export interface OptionSetVersionDetail extends OptionSetVersionSummary {
  stages: OptionStage[];
}

export interface OptionStageInput {
  id?: string;
  code?: string;
  name: string;
  sortOrder: number;
  required: boolean;
  choices: { slot: 'A' | 'B'; name: string; factoryName?: string; imageFileId?: string }[];
}

// 백엔드는 stageCode/stageName/sequenceNo/choiceCode/choiceName/factoryLabel/imageFileId 로 응답한다.
// 화면 모델(name/sortOrder/slot/imageUrl)로 여기에서 변환한다.

interface ApiOptionChoice {
  id: string;
  choiceCode: 'A' | 'B';
  choiceName: string;
  factoryLabel?: string | null;
  imageFileId?: string | null;
  active: boolean;
}

interface ApiOptionStage {
  id: string;
  stageCode: string;
  stageName: string;
  sequenceNo: number;
  required: boolean;
  active: boolean;
  choices: ApiOptionChoice[];
}

interface ApiOptionSetVersion {
  id: string;
  optionSetId: string;
  versionNo: number;
  status: OptionSetVersionStatus;
  effectiveFrom?: string | null;
  description?: string | null;
  createdAt?: string;
  stages?: ApiOptionStage[];
}

interface ApiOptionSet {
  id: string;
  productCategory: 'SUIT' | 'SHIRT' | 'SHOES';
  name: string;
  activeVersionId: string | null;
  versions: ApiOptionSetVersion[];
}

const dateOnly = (v?: string | null): string | undefined => v?.slice(0, 10);

function toChoice(c: ApiOptionChoice): OptionChoice {
  return {
    id: c.id,
    slot: c.choiceCode,
    name: c.choiceName,
    factoryName: c.factoryLabel ?? undefined,
    imageFileId: c.imageFileId ?? undefined,
    imageUrl: c.imageFileId ? `/files/${c.imageFileId}` : null,
  };
}

function toStage(s: ApiOptionStage): OptionStage {
  return {
    id: s.id,
    code: s.stageCode,
    name: s.stageName,
    sortOrder: s.sequenceNo,
    required: s.required,
    choices: s.choices.map(toChoice),
  };
}

function toVersionSummary(v: ApiOptionSetVersion, optionSetId: string): OptionSetVersionSummary {
  return {
    id: v.id,
    optionSetId,
    versionNo: v.versionNo,
    status: v.status,
    createdAt: dateOnly(v.createdAt) ?? '',
    activatedAt: v.status === 'ACTIVE' ? dateOnly(v.effectiveFrom) : undefined,
    stageCount: v.stages?.length ?? 0,
  };
}

function toVersionDetail(v: ApiOptionSetVersion): OptionSetVersionDetail {
  return {
    ...toVersionSummary(v, v.optionSetId),
    stages: (v.stages ?? []).map(toStage),
  };
}

/**
 * 목록 응답에는 단계가 없어 단계 수를 알 수 없다.
 * 화면의 "단계 수" 컬럼을 채우기 위해 버전 상세를 병렬로 조회해 합친다.
 */
export async function fetchOptionSets(): Promise<OptionSetSummary[]> {
  const sets = await request<ApiOptionSet[]>({ url: '/option-sets' });
  const details = await Promise.all(
    sets.flatMap((s) =>
      s.versions.map((v) =>
        request<ApiOptionSetVersion>({ url: `/option-set-versions/${v.id}` }).catch(() => null),
      ),
    ),
  );
  const stageCountById = new Map(
    details.filter((d): d is ApiOptionSetVersion => !!d).map((d) => [d.id, d.stages?.length ?? 0]),
  );
  return sets.map((s) => ({
    id: s.id,
    category: s.productCategory,
    name: s.name,
    versions: s.versions.map((v) => ({
      ...toVersionSummary(v, s.id),
      stageCount: stageCountById.get(v.id) ?? 0,
    })),
  }));
}

export async function fetchOptionSetVersion(versionId: string): Promise<OptionSetVersionDetail> {
  return toVersionDetail(await request<ApiOptionSetVersion>({ url: `/option-set-versions/${versionId}` }));
}

export async function createOptionSetVersion(
  optionSetId: string,
  sourceVersionId?: string,
): Promise<OptionSetVersionDetail> {
  return toVersionDetail(
    await request<ApiOptionSetVersion>({
      url: `/option-sets/${optionSetId}/versions`,
      method: 'POST',
      data: { copyFromVersionId: sourceVersionId },
    }),
  );
}

/**
 * 단계 코드는 신규 단계에서만 생성한다 (기존 단계는 서버 코드 유지).
 * 한글 단계명은 ASCII로 남는 글자가 없어 STAGE_n으로 떨어지므로, 중복되면 뒤에 번호를 붙인다.
 */
function stageCodes(stages: OptionStageInput[]): string[] {
  const used = new Set(stages.map((s) => s.code).filter((c): c is string => !!c));
  return stages.map((s, index) => {
    if (s.code) return s.code;
    const ascii = s.name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const base = (ascii || `STAGE_${index + 1}`).slice(0, 36);
    let code = base;
    let suffix = 2;
    while (used.has(code)) {
      code = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(code);
    return code;
  });
}

export async function saveOptionStages(
  versionId: string,
  stages: OptionStageInput[],
): Promise<OptionSetVersionDetail> {
  const codes = stageCodes(stages);
  return toVersionDetail(
    await request<ApiOptionSetVersion>({
      url: `/option-set-versions/${versionId}/stages`,
      method: 'PUT',
      data: {
        stages: stages.map((s, i) => ({
          stageCode: codes[i],
          stageName: s.name,
          sequenceNo: s.sortOrder,
          required: s.required,
          choices: s.choices.map((c) => ({
            choiceCode: c.slot,
            choiceName: c.name,
            factoryLabel: c.factoryName,
            imageFileId: c.imageFileId,
          })),
        })),
      },
    }),
  );
}

export async function activateOptionSetVersion(
  versionId: string,
): Promise<OptionSetVersionSummary> {
  const res = await request<{ versionId: string; optionSetId: string; versionNo: number; status: OptionSetVersionStatus; effectiveFrom?: string | null }>({
    url: `/option-set-versions/${versionId}/activate`,
    method: 'POST',
  });
  return {
    id: res.versionId,
    optionSetId: res.optionSetId,
    versionNo: res.versionNo,
    status: res.status,
    createdAt: '',
    activatedAt: dateOnly(res.effectiveFrom),
    stageCount: 0,
  };
}

// ---------------------------------------------------------------------------
// 사용자·역할·권한 (ADMIN-003)
// ---------------------------------------------------------------------------

/** 백엔드 USER_SELECT 원본 행 */
interface AdminUserApiRow {
  id: string;
  loginId: string;
  displayName: string;
  status: string;
  lastLoginAt?: string | null;
  createdAt: string;
  userRoles?: { role: { code: string; name: string } }[];
}

export interface AdminUser {
  id: string;
  loginId: string;
  /** 백엔드 displayName */
  name: string;
  /** 역할 코드 (백엔드는 코드로 배정한다) */
  roleCodes: string[];
  roleName: string;
  status: string;
  /** `YYYY-MM-DD` */
  createdAt: string;
  lastLoginAt?: string;
}

function toAdminUser(row: AdminUserApiRow): AdminUser {
  const roles = row.userRoles ?? [];
  return {
    id: row.id,
    loginId: row.loginId,
    name: row.displayName,
    roleCodes: roles.map((r) => r.role.code),
    roleName: roles.map((r) => r.role.name).join(', ') || '-',
    status: row.status,
    createdAt: dateOnly(row.createdAt) ?? '',
    lastLoginAt: dateOnly(row.lastLoginAt),
  };
}

interface RoleApiRow {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  rolePermissions?: { permission: { code: string; name: string } }[];
}

export interface Role {
  id: string;
  code: string;
  name: string;
  description?: string;
  /** 권한 코드 목록 */
  permissions: string[];
}

function toRole(row: RoleApiRow): Role {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? undefined,
    permissions: (row.rolePermissions ?? []).map((rp) => rp.permission.code),
  };
}

interface PermissionApiRow {
  id: string;
  code: string;
  name: string;
  description?: string | null;
}

export interface PermissionDef {
  code: string;
  label: string;
  /** 코드 접두어에서 파생한 분류 (백엔드에 분류 컬럼이 없다 — docs/dev/08 §4) */
  group: string;
  description?: string;
}

/** `CONTRACT_EDIT` → `CONTRACT` 처럼 코드 앞부분을 분류로 쓴다. */
const PERMISSION_GROUP_LABELS: Record<string, string> = {
  APPOINTMENT: '예약',
  CUSTOMER: '고객',
  CONTRACT: '계약',
  ORDER: '주문',
  OPTION: '옵션',
  MEASUREMENT: '채촌',
  WORK: '작업지시서',
  PRODUCTION: '제작',
  RENTAL: '렌탈',
  REPAIR: '수선',
  PAYMENT: '결제',
  NOTIFICATION: '알림',
  DASHBOARD: '대시보드',
  ADMIN: '기준정보',
  USER: '사용자',
  ROLE: '역할',
  AUDIT: '감사로그',
  FILE: '파일',
};

function toPermission(row: PermissionApiRow): PermissionDef {
  const prefix = row.code.split('_')[0];
  return {
    code: row.code,
    label: row.name,
    group: PERMISSION_GROUP_LABELS[prefix] ?? prefix,
    description: row.description ?? undefined,
  };
}

export function fetchUsers(): Promise<AdminUser[]> {
  return request<AdminUserApiRow[]>({ url: '/users' }).then((rows) => (rows ?? []).map(toAdminUser));
}

/** 사용자 추가 — 백엔드는 displayName·password(8자 이상)·roleCodes[]를 요구한다. */
export function createUser(payload: {
  loginId: string;
  name: string;
  password: string;
  roleCodes: string[];
}): Promise<AdminUser> {
  return request<AdminUserApiRow>({
    url: '/users',
    method: 'POST',
    data: {
      loginId: payload.loginId,
      displayName: payload.name,
      password: payload.password,
      roleCodes: payload.roleCodes,
    },
  }).then(toAdminUser);
}

export function deactivateUser(id: string): Promise<AdminUser> {
  return request<AdminUserApiRow>({ url: `/users/${id}/deactivate`, method: 'POST' }).then(toAdminUser);
}

export function fetchRoles(): Promise<Role[]> {
  return request<RoleApiRow[]>({ url: '/roles' }).then((rows) => (rows ?? []).map(toRole));
}

export function fetchPermissions(): Promise<PermissionDef[]> {
  return request<PermissionApiRow[]>({ url: '/permissions' }).then((rows) =>
    (rows ?? []).map(toPermission),
  );
}

/** 역할 권한 저장 — 백엔드 DTO 필드는 permissionCodes 다. */
export function saveRolePermissions(roleId: string, permissions: string[]): Promise<Role> {
  return request<RoleApiRow>({
    url: `/roles/${roleId}/permissions`,
    method: 'PUT',
    data: { permissionCodes: permissions },
  }).then(toRole);
}

// ---------------------------------------------------------------------------
// 감사로그 (AUDIT-001)
// ---------------------------------------------------------------------------

export interface AuditLogItem {
  id: string;
  occurredAt: string;
  userId: string;
  userName: string;
  action: string;
  entityType: string;
  entityId: string;
  entityLabel?: string;
  reason?: string;
  ip: string;
  requestId: string;
  userAgent?: string;
}

export interface AuditLogDetail extends AuditLogItem {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface AuditLogSearchParams {
  from: string;
  to: string;
  userId?: string;
  action?: string;
  query?: string;
  page: number;
  size: number;
}

export function searchAuditLogs(params: AuditLogSearchParams): Promise<ListResult<AuditLogItem>> {
  return request<ListResult<AuditLogItem>>({ url: '/audit-logs', params });
}

export function fetchAuditLog(id: string): Promise<AuditLogDetail> {
  return request<AuditLogDetail>({ url: `/audit-logs/${id}` });
}
