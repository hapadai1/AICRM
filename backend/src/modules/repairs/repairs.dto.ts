import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination';

/** 수선 유형 (데이터모델 §12.1) */
export const REPAIR_TYPES = [
  'CUSTOM_DURING',
  'AFTER_SALE',
  'RENTAL_PRE',
  'RENTAL_POST',
  'GENERAL',
] as const;

export class ListRepairsQueryDto extends PageQueryDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsUUID() customerId?: string;
}

/** 수선 접수 모달 연결 대상 조회 (연동정합화 계약 §8) */
export class LinkTargetsQueryDto {
  @IsUUID() customerId: string;
}

export class CreateRepairDto {
  @IsUUID() customerId: string;
  @IsIn([...REPAIR_TYPES]) repairType: string;
  @IsDateString() requestDate: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsString() @IsNotEmpty() description: string;
  @IsOptional() @IsNumber() @Min(0) cost?: number;
  @IsOptional() @IsString() notes?: string;
  /** CUSTOM_DURING / AFTER_SALE: 품목 또는 구성품 연결 필수 */
  @IsOptional() @IsUUID() orderItemId?: string;
  @IsOptional() @IsUUID() componentId?: string;
  /** RENTAL_PRE / RENTAL_POST: 렌탈 실물 연결 필수 */
  @IsOptional() @IsUUID() rentalInventoryItemId?: string;
}

export class UpdateRepairDto {
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() @IsNotEmpty() description?: string;
  @IsOptional() @IsNumber() @Min(0) cost?: number;
  @IsOptional() @IsString() notes?: string;
}

export class CreateRepairStatusEventDto {
  @IsString() @IsNotEmpty() newStatus: string;
  @IsOptional() @IsDateString() eventDate?: string;
  @IsOptional() @IsString() notes?: string;
}
