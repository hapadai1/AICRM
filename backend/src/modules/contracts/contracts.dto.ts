import { Transform, Type } from 'class-transformer';
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
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  depositAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  balanceAmount?: number;

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

/** 계약 상태 (설계서 6.1) */
export const CONTRACT_STATUSES = ['DRAFT', 'CONFIRMED', 'CHANGED', 'CANCELLED'] as const;

/** 목록 기간 필터 기준 (개편계획 06 §2.1) */
export const CONTRACT_DATE_FIELDS = ['contractedAt', 'paymentDate', 'completionDueDate'] as const;

/** 목록 정렬 허용 필드 (개편계획 06 §2.2) */
export const CONTRACT_SORT_FIELDS = [
  'contractedAt',
  'totalAmount',
  'paidAmount',
  'unpaidAmount',
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

  /** 미수금(계약금액 − 실수납액)이 남은 계약만 */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unpaidOnly?: boolean;

  /** `필드,방향` (예: `contractedAt,desc`) */
  @IsOptional()
  @Matches(/^[a-zA-Z]+(,(asc|desc))?$/, { message: 'sort 형식은 `필드,asc|desc` 입니다.' })
  sort?: string;
}

export class ConfirmContractDto {
  /** 낙관적 잠금: contracts.row_version (문서 14.1) */
  @Type(() => Number)
  @IsInt()
  version: number;

  @IsOptional()
  @IsDateString()
  confirmedDate?: string;

  /** Idempotency-Key 헤더 대신 body로도 허용 (문서 14.1) */
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
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

export class ConfirmRevisionDto {
  /** 낙관적 잠금: contracts.row_version */
  @Type(() => Number)
  @IsInt()
  version: number;

  /** 변경 사유 (초안 작성 시 저장하지 않았다면 필수) */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  changeReason?: string;

  /** 제공 시 확정 직전 revision 금액에 반영한다 (연동정합화 계약 §3) */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  totalAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  depositAmount?: number;

  /** 제공 시 확정 직전 revision 라인 전체 교체 (연동정합화 계약 §3) */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ContractLineDto)
  lines?: ContractLineDto[];

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
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
