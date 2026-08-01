import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination';
import { PRODUCT_CATEGORIES, TRANSACTION_TYPES } from './contract-types.dto';

/** 계약 품목 라인. 수량 0은 변경계약에서 해당 품목 제거를 뜻한다. */
export class ContractLineDto {
  @IsIn(TRANSACTION_TYPES as unknown as string[])
  transactionType: string;

  @IsIn(PRODUCT_CATEGORIES as unknown as string[])
  productCategory: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  itemDescription?: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  quantity: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  lineAmount?: number;

  /**
   * 베스트(3피스) 포함 — 맞춤 정장(CUSTOM×SUIT) 라인만 허용 (현업 확정 2026-07-30).
   * 맞춤 정장의 기본은 포함(3피스)이라 값을 주지 않으면 true로 채운다 (현업 확정 2026-07-31).
   * 계약서 화면의 [베스트 제외] 체크박스를 켜면 false(2피스)로 온다.
   */
  @IsOptional()
  @IsBoolean()
  vestIncluded?: boolean;

  /** 베스트 포함 시 벌당 베스트 단가(수기). 금액 = 수량 × (단가 + 베스트 단가). */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  vestUnitPrice?: number;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

class ContractAmountsDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  totalAmount?: number;

  @IsOptional()
  @IsDateString()
  completionDueDate?: string;

  @IsOptional()
  @IsDateString()
  photoDate?: string;

  @IsOptional()
  @IsDateString()
  weddingDate?: string;
}

export class CreateContractDto extends ContractAmountsDto {
  @IsUUID()
  customerId: string;

  /** 선택 시 계약 구분의 기본 품목 라인을 복사한다. */
  @IsOptional()
  @IsUUID()
  contractTypeId?: string;

  /** 제공 시 계약 구분 기본값 대신 이 라인을 사용한다. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ContractLineDto)
  lines?: ContractLineDto[];
}

export class UpdateContractDto extends ContractAmountsDto {
  @IsOptional()
  @IsUUID()
  contractTypeId?: string;

  /** 제공 시 초안 버전 라인 전체 교체 */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ContractLineDto)
  lines?: ContractLineDto[];

  /** 낙관적 잠금: contracts.row_version */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  version?: number;
}

/**
 * 계약 상태 (현업 확정 2026-07-30).
 *
 * 흐름: DRAFT(작성중 — 수정·컨설팅) → SIGNED(서명완료) → COMPLETED(계약완료·주문 생성)
 *       → 수정하기(버전업) → DRAFT → … 반복. 취소(CANCELLED)는 작성중에서만.
 *
 * 예전의 CONFIRMED(등록)·CHANGED(변경 확정)는 없어졌다 — 컨설팅이 작성중 단계로 내려와
 * 등록을 앞세울 이유가 사라졌고, 변경 확정은 재서명이 대신한다.
 */
export const CONTRACT_STATUSES = ['DRAFT', 'SIGNED', 'COMPLETED', 'CANCELLED'] as const;

/** 계약 완료 (서명 필수) */
export class CompleteContractDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  version?: number;
}

/** 목록 기간 필터 기준 (개편계획 06 §2.1) */
export const CONTRACT_DATE_FIELDS = ['contractedAt', 'completionDueDate'] as const;

/** 목록 정렬 허용 필드 (개편계획 06 §2.2) */
export const CONTRACT_SORT_FIELDS = [
  'contractedAt',
  'totalAmount',
  'completionDueDate',
] as const;

export class ContractListQueryDto extends PageQueryDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  /** 계약번호 또는 고객명 검색 */
  @IsOptional()
  @IsString()
  search?: string;

  /** search 별칭 (연동정합화 계약 §3 — 프론트 공통 검색 파라미터) */
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsIn(CONTRACT_STATUSES as unknown as string[])
  status?: string;

  // --- 목록 개편(06) 확장 필터 ---

  /** 기간 필터 기준 필드 */
  @IsOptional()
  @IsIn(CONTRACT_DATE_FIELDS as unknown as string[])
  dateField?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dateFrom 형식은 YYYY-MM-DD 입니다.' })
  dateFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dateTo 형식은 YYYY-MM-DD 입니다.' })
  dateTo?: string;

  @IsOptional()
  @IsUUID()
  contractTypeId?: string;

  /** `필드,방향` (예: `contractedAt,desc`) */
  @IsOptional()
  @Matches(/^[a-zA-Z]+(,(asc|desc))?$/, { message: 'sort 형식은 `필드,asc|desc` 입니다.' })
  sort?: string;
}

export class CreateRevisionDto extends ContractAmountsDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  changeReason?: string;

  /** 제공 시 변경계약 초안 라인 전체 교체 (미제공 시 현재 확정본 복사) */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ContractLineDto)
  lines?: ContractLineDto[];
}

export class SaveSignatureDto {
  /** data:image/png;base64,... 형식 */
  @IsString()
  @Matches(/^data:image\/png;base64,/, { message: 'imageDataUrl은 PNG dataURL이어야 합니다.' })
  imageDataUrl: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  signerName: string;

  /** 낙관적 잠금: contracts.row_version */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  version?: number;
}

/**
 * 베스트 포함/제외 (현업 확정 2026-08-01) — 컨설팅 화면 [베스트 제외] 체크박스.
 * 체크 = 제외(false), 해제 = 재포함(true).
 */
export class SetVestIncludedDto {
  @IsBoolean()
  included: boolean;
}

export class CancelContractDto {
  @IsString()
  @IsNotEmpty()
  reason: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  version?: number;
}
