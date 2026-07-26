import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination';

/** 고객 상태 (데이터모델설계서 5.1) */
export const CUSTOMER_STATUSES = ['PROSPECT', 'CONTRACTED', 'INACTIVE'] as const;

export class CustomerListQueryDto extends PageQueryDto {
  /** 이름 / 전화번호 / 주문번호 통합 검색어 */
  @IsOptional() @IsString() q?: string;

  /** 기본 목록은 CONTRACTED만 조회 (설계서 5.3). ALL이면 전체 조회 */
  @IsOptional() @IsIn([...CUSTOMER_STATUSES, 'ALL']) status: string = 'CONTRACTED';

  /** true면 status 필터에 PROSPECT를 추가로 포함한다 (연동정합화 계약 §2) */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeProspect?: boolean;

  /** 해당 거래방식(CUSTOM/RENTAL) 주문 보유 고객만 조회 (연동정합화 계약 §2) */
  @IsOptional() @IsIn(['CUSTOM', 'RENTAL']) transactionType?: string;
}

/** 신체 정보(키·체중·나이) — v2 작업지시서 연동, 선택 입력. Create/Update/Register 공통 */
export class BodyInfoDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(300) heightCm?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(500) weightKg?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(150) age?: number;
}

export class CreateCustomerDto extends BodyInfoDto {
  @IsString() @IsNotEmpty() @MaxLength(80) name: string;
  @IsString() @IsNotEmpty() @MaxLength(30) phone: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() notes?: string;
  /** 미지정 시 PROSPECT (DB 기본값). 계약 전환은 계약 확정 트랜잭션에서 수행 */
  @IsOptional() @IsIn(['PROSPECT', 'CONTRACTED']) customerStatus?: string;
  /** 최초 예약일. 예약으로 생긴 고객은 자동 기록되므로 수동 등록에서도 입력할 수 있게 둔다 */
  @IsOptional() @IsISO8601() firstReservedAt?: string;
}

export class UpdateCustomerDto extends BodyInfoDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(30) phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() notes?: string;
  /** 낙관적 잠금: 조회 시점의 rowVersion */
  @Type(() => Number) @IsInt() @Min(0) version: number;
}

/**
 * 예약으로 생긴 미등록 고객을 정식 고객으로 등록한다 (CUST-001 [예약 고객 등록]).
 * 일반 수정(PATCH)과 분리해 등록 시각이 의도치 않게 찍히는 것을 막는다.
 */
export class RegisterCustomerDto extends BodyInfoDto {
  @IsString() @IsNotEmpty() @MaxLength(80) name: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() notes?: string;
  /** 낙관적 잠금: 조회 시점의 rowVersion */
  @Type(() => Number) @IsInt() @Min(0) version: number;
}

export class DeactivateCustomerDto {
  @IsOptional() @IsString() reason?: string;
}
