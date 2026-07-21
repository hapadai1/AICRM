import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const TRANSACTION_TYPES = ['CUSTOM', 'RENTAL'] as const;
export const PRODUCT_CATEGORIES = ['SUIT', 'SHIRT', 'SHOES'] as const;

export class ContractTypeLineDto {
  @IsIn(TRANSACTION_TYPES as unknown as string[])
  transactionType: string;

  @IsIn(PRODUCT_CATEGORIES as unknown as string[])
  productCategory: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  defaultQuantity: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder: number = 0;

  @IsOptional()
  @IsBoolean()
  active: boolean = true;
}

export class CreateContractTypeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  code: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ContractTypeLineDto)
  lines?: ContractTypeLineDto[];
}

export class UpdateContractTypeDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  /** 제공 시 기본 품목 전체 교체 (마스터는 템플릿이므로 기존 계약에 영향 없음) */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ContractTypeLineDto)
  lines?: ContractTypeLineDto[];
}

export class CloneContractTypeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  code: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;
}

export class ContractTypeListQueryDto {
  /** active=true 시 사용 가능 항목만 반환 */
  @IsOptional()
  @IsString()
  active?: string;
}
