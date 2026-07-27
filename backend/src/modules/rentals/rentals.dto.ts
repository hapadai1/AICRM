import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination';
import {
  DATE_ONLY_REGEX,
  RENTAL_COMPONENT_TYPES,
  RENTAL_ITEM_STATUSES,
  RETURN_NEXT_ITEM_STATUSES,
} from './rentals.constants';

const DATE_MSG = '날짜는 YYYY-MM-DD 형식이어야 합니다.';

export class InventoryListQueryDto extends PageQueryDto {
  @IsOptional() @IsIn(RENTAL_COMPONENT_TYPES) componentType?: string;
  @IsOptional() @IsString() design?: string;
  @IsOptional() @IsString() color?: string;
  /** SKU 사이즈 필터 (page size 파라미터와의 충돌 회피를 위해 skuSize 사용) */
  @IsOptional() @IsString() skuSize?: string;
  @IsOptional() @IsIn(RENTAL_ITEM_STATUSES) status?: string;
  @IsOptional() @IsString() managementCode?: string;
  /** 해당 일자에 대여 가능 예정(available_from이 없거나 이 날짜 이전)인 실물만 */
  @IsOptional() @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) availableOn?: string;
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  active?: boolean;
}

export class CreateInventoryDto {
  @IsIn(RENTAL_COMPONENT_TYPES) componentType: string;
  @IsString() @IsNotEmpty() @MaxLength(100) design: string;
  @IsString() @IsNotEmpty() @MaxLength(80) color: string;
  @IsString() @IsNotEmpty() @MaxLength(40) size: string;
  @IsOptional() @IsString() skuDescription?: string;
  /** quantity=1이면 그대로, quantity>1이면 `${managementCode}-001` 형식 연번 생성 */
  @IsString() @IsNotEmpty() @MaxLength(60) managementCode: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) quantity?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) startNo?: number;
  @IsOptional() @IsIn(RENTAL_ITEM_STATUSES) status?: string;
  @IsOptional() @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) availableFrom?: string;
  @IsOptional() @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) acquiredAt?: string;
  @IsOptional() @IsString() notes?: string;
}

/** import 행은 오류 행 분리를 위해 서비스에서 수동 검증한다. */
export class ImportInventoryDto {
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  dryRun?: boolean;

  @IsArray() @ArrayNotEmpty() items: Record<string, unknown>[];
}

export class UpdateInventoryDto {
  @IsOptional() @IsIn(RENTAL_COMPONENT_TYPES) componentType?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) design?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) color?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) size?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) managementCode?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) acquiredAt?: string;
  @IsOptional() @IsInt() version?: number;
}

export class CreateStatusEventDto {
  @IsIn(RENTAL_ITEM_STATUSES) newStatus: string;
  @IsOptional() @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) availableFrom?: string;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsInt() version?: number;
}

export class RetireInventoryDto {
  @IsOptional() @IsString() reason?: string;
}

export class AvailabilityQueryDto {
  @IsIn(RENTAL_COMPONENT_TYPES) componentType: string;
  @IsOptional() @IsString() design?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() size?: string;
  @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) pickupDate: string;
  @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) availabilityEndDate: string;
}

/**
 * 렌탈예약 달력 — 기간 내 일자별 가용 실물 집계 (설계서 06 §4.4).
 * 단일창 availability와 동일한 검색 축을 재사용하고, 자유 검색어 q·sku 필터를 추가한다.
 */
export class AvailabilityCalendarQueryDto {
  @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) from: string;
  @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) to: string;
  @IsOptional() @IsIn(RENTAL_COMPONENT_TYPES) componentType?: string;
  @IsOptional() @IsString() design?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() size?: string;
  /** 자유 검색어(관리코드·디자인·컬러 부분일치) */
  @IsOptional() @IsString() q?: string;
  /** SKU 설명(코드) 부분일치 */
  @IsOptional() @IsString() sku?: string;
}

export class CreateAllocationDto {
  @IsUUID() componentId: string;
  /** 실물 UUID — itemCode와 둘 중 하나 필수 */
  @IsOptional() @IsUUID() inventoryItemId?: string;
  /** 실물 관리코드 — inventoryItemId 대신 허용(코드→id 해석) */
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) itemCode?: string;
  @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) pickupDate: string;
  @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) returnDueDate: string;
  @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) availabilityEndDate: string;
}

export class ChangeItemDto {
  @IsUUID() newInventoryItemId: string;
  @IsString() @IsNotEmpty() reason: string;
  @IsInt() version: number;
}

export class CheckoutDto {
  /** 확인 실물 UUID — confirmedItemCode와 둘 중 하나 필수 */
  @IsOptional() @IsUUID() confirmedInventoryItemId?: string;
  /** 확인 실물 관리코드 — confirmedInventoryItemId 대신 허용(코드→id 해석) */
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) confirmedItemCode?: string;
  @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) checkoutDate: string;
  @IsInt() version: number;
}

/** 출고·반납 대상 목록 (RENT-004 화면 뷰) */
export class AllocationListQueryDto {
  @IsIn(['pickup', 'return']) view: string;
  /** 기준일 (기본: 오늘) */
  @IsOptional() @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) date?: string;
  /**
   * 특정 건 검색어(주문번호·고객명·실물 관리코드).
   * 진행단계 카드 등에서 한 건을 처리하러 들어올 때 사용한다.
   * 지정하면 pickup 뷰의 "오늘 이하" 날짜 제한을 풀어, 픽업일이 미래인 예약도 함께 반환한다.
   */
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) q?: string;
}

/** 배정 대상 렌탈 구성품 목록 (RENT-003 화면 뷰) */
export class RentalOrderComponentsQueryDto {
  /** 없으면 활성 렌탈 주문 전체 */
  @IsOptional() @IsUUID() orderId?: string;
}

export class ReturnDto {
  @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) returnDate: string;
  /** 반납 후 직원이 지정하는 대여 가능 예정일 (RENT-004 필수) */
  @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) availableFrom: string;
  @IsOptional() @IsIn(RETURN_NEXT_ITEM_STATUSES) nextStatus?: string;
  @IsOptional() @IsInt() version?: number;
}

// ---------------------------------------------------------------------------
// 렌탈 스타일 선택 (v2 D3 / 설계서 04 §4)
// ---------------------------------------------------------------------------

/** PUT /rental-selections/:id/lines/:componentId — 부위별 컬러·사이즈·비고 upsert */
export class SaveRentalLineDto {
  /** 기준정보 rental_colors.code */
  @IsOptional() @IsString() @MaxLength(30) colorCode?: string;
  /** 기준정보 rental_sizes.code */
  @IsOptional() @IsString() @MaxLength(30) sizeCode?: string;
  /** 수선명령(수치 등) 수기 — 비고 */
  @IsOptional() @IsString() notes?: string;
  /** 낙관적 잠금: rental_selection_sessions.row_version */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) version?: number;
}

/** PUT /rental-selections/:id/lines/:componentId/item — 후보 실물 선택 */
export class SelectRentalItemDto {
  /** 선택 실물 UUID — itemCode와 둘 중 하나 필수. null이면 선택 해제 */
  @IsOptional() @IsUUID() inventoryItemId?: string | null;
  /** 선택 실물 관리코드 — inventoryItemId 대신 허용(코드→id 해석) */
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) itemCode?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) version?: number;
}

/** POST /rental-selections/:id/confirm */
export class ConfirmRentalSelectionDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) version?: number;
}
