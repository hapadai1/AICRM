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
  @IsOptional() @IsString() color?: string;
  /** SKU 사이즈 필터 (page size 파라미터와의 충돌 회피를 위해 skuSize 사용) */
  @IsOptional() @IsString() skuSize?: string;
  @IsOptional() @IsIn(RENTAL_ITEM_STATUSES) status?: string;
  @IsOptional() @IsString() managementCode?: string;
  /**
   * 폐기 실물 표시 여부. true면 폐기만, 기본(미지정·false)은 폐기를 뺀 살아 있는 재고만.
   * 폐기는 현업에서 '삭제'로 쓰이므로 평소 목록에 섞이면 안 된다.
   */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  retired?: boolean;
  /** 해당 일자에 대여 가능 예정(available_from이 없거나 이 날짜 이전)인 실물만 */
  @IsOptional() @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) availableOn?: string;
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  active?: boolean;
}

export class CreateInventoryDto {
  @IsIn(RENTAL_COMPONENT_TYPES) componentType: string;
  @IsString() @IsNotEmpty() @MaxLength(80) color: string;
  @IsString() @IsNotEmpty() @MaxLength(40) size: string;
  @IsOptional() @IsString() skuDescription?: string;
  /**
   * quantity=1이면 그대로, quantity>1이면 `${managementCode}-001` 형식 연번 생성.
   * 생략하면 `구분-컬러-사이즈-연번`으로 서버가 채번한다 — 재고를 수량으로만 관리하는
   * 화면에서는 사용자가 코드를 알 필요가 없다 (현업 확정 2026-07-31).
   */
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) managementCode?: string;
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
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) color?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) size?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) managementCode?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) acquiredAt?: string;
  @IsOptional() @IsInt() version?: number;
}

/**
 * 실물 상태 수동 변경. 사유는 필수다 — 왜 뺐는지/왜 되돌렸는지가 남지 않으면
 * 나중에 상태 이력을 봐도 아무것도 알 수 없다. 폐기(RetireInventoryDto)와 같은 기준.
 */
export class CreateStatusEventDto {
  @IsIn(RENTAL_ITEM_STATUSES) newStatus: string;
  @IsOptional() @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) availableFrom?: string;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: '사유를 입력해 주세요.' })
  @MaxLength(500)
  reason: string;
  @IsOptional() @IsInt() version?: number;
}

/**
 * 폐기는 되돌릴 수 없어 사유를 필수로 받는다 — 나중에 왜 뺐는지 추적할 근거가 남아야 한다.
 * 공백만 넣어 우회하지 못하도록 검증 전에 trim 한다(IsNotEmpty는 '   '를 통과시킨다).
 */
export class RetireInventoryDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: '폐기 사유를 입력해 주세요.' })
  @MaxLength(500)
  reason: string;
}

/**
 * SKU 단위 수량 폐기 — 어느 개체를 뺄지는 서버가 고른다.
 * 재고 화면이 개체를 다루지 않으므로 사용자는 "블랙 46호 2벌"까지만 지정한다.
 */
export class RetireQuantityDto {
  @IsIn(RENTAL_COMPONENT_TYPES) componentType: string;
  @IsString() @IsNotEmpty() @MaxLength(80) color: string;
  @IsString() @IsNotEmpty() @MaxLength(40) size: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(500) quantity: number;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: '폐기 사유를 입력해 주세요.' })
  @MaxLength(500)
  reason: string;
}

/** SKU 단위 수량 상태 변경 (임시 사용불가 ↔ 대여 가능). 대상 개체는 서버가 고른다. */
export class StatusQuantityDto {
  @IsIn(RENTAL_COMPONENT_TYPES) componentType: string;
  @IsString() @IsNotEmpty() @MaxLength(80) color: string;
  @IsString() @IsNotEmpty() @MaxLength(40) size: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(500) quantity: number;
  @IsIn(RENTAL_ITEM_STATUSES) newStatus: string;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: '사유를 입력해 주세요.' })
  @MaxLength(500)
  reason: string;
}

export class AvailabilityQueryDto {
  @IsIn(RENTAL_COMPONENT_TYPES) componentType: string;
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
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() size?: string;
  /** 자유 검색어(관리코드·컬러 부분일치) */
  @IsOptional() @IsString() q?: string;
  /** SKU 설명(코드) 부분일치 */
  @IsOptional() @IsString() sku?: string;
}

export class CreateAllocationDto {
  @IsUUID() componentId: string;
  /**
   * 실물 UUID. 셋(inventoryItemId·itemCode·color+size) 중 하나는 있어야 한다.
   * 재고를 수량으로만 관리하는 화면은 개체를 모르므로 color+size만 넘기고,
   * 그때는 서버가 그 기간에 비어 있는 실물 하나를 고른다 (현업 확정 2026-07-31).
   */
  @IsOptional() @IsUUID() inventoryItemId?: string;
  /** 실물 관리코드 — inventoryItemId 대신 허용(코드→id 해석) */
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) itemCode?: string;
  /** 개체 대신 넘기는 SKU 조건 — 구분은 구성품에서 가져오므로 컬러·사이즈만 받는다. */
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) color?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) size?: string;
  @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) pickupDate: string;
  @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) returnDueDate: string;
  /**
   * 실물이 묶여 있는 마지막 날. 생략하면 반납 예정일과 같다 —
   * 반납 다음 날부터 다른 예약을 받는다(7/31 반납이면 8/1부터).
   * 세탁이 더 걸리면 예약 시점에 추측하지 않고, 반납 처리에서 '대여 가능 예정일'로 미룬다.
   */
  @IsOptional() @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) availabilityEndDate?: string;
}

export class ChangeItemDto {
  /**
   * 바꿀 실물. 생략하면 같은 규격(구분·컬러·사이즈)에서 그 기간에 비어 있는 다른 실물을
   * 서버가 고른다 — 규격이 같은 옷이 여러 벌이면 코드 목록을 보여 줘도 고를 근거가 없다
   * (현업 확정 2026-07-31).
   */
  @IsOptional() @IsUUID() newInventoryItemId?: string;
  @IsString() @IsNotEmpty() reason: string;
  @IsInt() version: number;
}

/**
 * 출고. 실물 관리코드 재입력(확인 ID) 대조는 없앴다 — 현장에서 라벨을 다시 치는 부담만 컸다.
 * 예약된 것과 다른 옷을 내보냈다면 notes에 적어 둔다(배정 자체를 바꾸려면 실물 교체를 쓴다).
 */
export class CheckoutDto {
  @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) checkoutDate: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
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
  /**
   * 대여 가능 예정일. 생략하면 서버가 정비 기준으로 채운다
   * (반납일 + 색 계열별 정비일 — 밝은색 2일 / 블랙 타입 1일).
   * 화면은 같은 값을 미리 채워 보여 주되, 현장 판단으로 당기거나 미룰 수 있어 값도 받는다.
   */
  @IsOptional() @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) availableFrom?: string;
  @IsOptional() @IsIn(RETURN_NEXT_ITEM_STATUSES) nextStatus?: string;
  @IsOptional() @IsInt() version?: number;
}

/** 렌탈 정비 기준 수정 (ADMIN-001 "렌탈 정비 기준") */
export class UpdateRentalReturnPolicyDto {
  /** 밝은색(화이트·베이지 계열) 정비 소요일 */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(30) lightCleaningDays?: number;
  /** 블랙 타입 정비 소요일 */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(30) darkCleaningDays?: number;
  /** 정비일 도래 시 자동 대여 가능 전환 */
  @IsOptional() @IsBoolean() autoRelease?: boolean;
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

/**
 * PUT /rental-selections/:id/period — 대여 기간 지정 (현업 확정 2026-07-28: 필수값).
 * 이 기간으로 가용 실물을 찾는다. 기간 없이는 후보 검색·확정을 할 수 없다.
 */
export class SaveRentalPeriodDto {
  @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) pickupDate: string;
  @Matches(DATE_ONLY_REGEX, { message: DATE_MSG }) returnDueDate: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) version?: number;
}

/** POST /rental-selections/:id/confirm */
export class ConfirmRentalSelectionDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) version?: number;
}
