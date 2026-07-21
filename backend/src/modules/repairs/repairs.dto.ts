import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
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

/**
 * 접수·출고 방식 (개발설계서 05 G-07).
 * 설계 PDF 1페이지 수선 구분의 "수선 물품 수선 요청 방문 / 출고 방문" 대응.
 * 택배는 운영하지 않으므로 방문 2종만 둔다.
 */
export const REPAIR_RECEIPT_METHODS = ['VISIT', 'PICKUP'] as const;
export const REPAIR_RELEASE_METHODS = ['VISIT', 'DELIVERY'] as const;

/** 접수·출고 방식 공통 필드 */
class RepairMethodDto {
  /** VISIT 고객 방문 | PICKUP 방문 수거 */
  @IsOptional() @IsIn([...REPAIR_RECEIPT_METHODS]) receiptMethod?: string;
  /** VISIT 고객 방문 | DELIVERY 방문 배송 */
  @IsOptional() @IsIn([...REPAIR_RELEASE_METHODS]) releaseMethod?: string;
  @IsOptional() @IsString() @MaxLength(300) pickupAddress?: string;
  @IsOptional() @IsString() @MaxLength(300) deliveryAddress?: string;
}

export class ListRepairsQueryDto extends PageQueryDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsUUID() customerId?: string;
}

/** 수선 접수 모달 연결 대상 조회 (연동정합화 계약 §8) */
export class LinkTargetsQueryDto {
  @IsUUID() customerId: string;
}

export class CreateRepairDto extends RepairMethodDto {
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

export class UpdateRepairDto extends RepairMethodDto {
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
