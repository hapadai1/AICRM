import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination';
import { codesOf } from '../admin-master/code-labels.constants';

/**
 * 수선 유형 (데이터모델 §12.1) — 코드 집합은 기준정보 상수에서 파생한다(단일 출처).
 * 렌탈 수선은 이 도메인에서 다루지 않는다 — 렌탈 진행(RENTAL 트랙)의
 * 수선요청·수선입고·수선출고 단계와 렌탈 실물 상태(ALTERATION)로 관리한다.
 */
export const REPAIR_TYPES = codesOf('repair-type');

/**
 * 수선 대상 품목 — 구성품 코드 집합(상의·하의·베스트·셔츠·구두)을 그대로 쓴다.
 * 계약에 등록된 주문 품목을 찾아 연결하지 않고 이 목록에서 자유롭게 고른다.
 */
export const REPAIR_TARGET_PRODUCTS = codesOf('component-type');

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

/** 대상 품목 한 줄 (품목·개수) */
export class RepairItemDto {
  @IsIn([...REPAIR_TARGET_PRODUCTS]) targetProduct: string;
  @IsInt() @Min(1) @Max(99) quantity: number;
}

export class CreateRepairDto extends RepairMethodDto {
  @IsUUID() customerId: string;
  @IsIn([...REPAIR_TYPES]) repairType: string;
  @IsDateString() requestDate: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsString() @IsNotEmpty() description: string;
  @IsOptional() @IsString() notes?: string;
  /** 대상 품목·개수. CUSTOM_DURING / AFTER_SALE 은 1줄 이상 필수 (service.assertItems) */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RepairItemDto)
  items?: RepairItemDto[];
}

export class UpdateRepairDto extends RepairMethodDto {
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() @IsNotEmpty() description?: string;
  @IsOptional() @IsString() notes?: string;
  /** 주면 기존 줄을 통째로 교체한다 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RepairItemDto)
  items?: RepairItemDto[];
}

export class CreateRepairStatusEventDto {
  @IsString() @IsNotEmpty() newStatus: string;
  @IsOptional() @IsDateString() eventDate?: string;
  @IsOptional() @IsString() notes?: string;
}
