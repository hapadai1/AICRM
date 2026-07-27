import { Type } from 'class-transformer';
import {
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

  /**
   * 조회 범위 (설계서 07 D3).
   * - CONTRACT: 계약을 한 건이라도 보유한 고객 (작성중·취소 계약 포함) — 고객 메뉴 기본
   * - ALL:      계약 유무와 무관한 전 고객 (고객 검색 팝업·전체 고객 토글)
   * 어느 쪽이든 INACTIVE(비활성) 고객은 제외한다.
   */
  @IsOptional() @IsIn(['CONTRACT', 'ALL']) scope?: string;

  /** 고객 상태 명시 필터. 미지정이 기본이며 INACTIVE 제외는 scope가 담당한다 */
  @IsOptional() @IsIn([...CUSTOMER_STATUSES, 'ALL']) status?: string;

  /** 해당 거래방식(CUSTOM/RENTAL) 주문 보유 고객만 조회 (연동정합화 계약 §2) */
  @IsOptional() @IsIn(['CUSTOM', 'RENTAL']) transactionType?: string;

  /**
   * 진행상태 검색 (설계서 06 §2 / 02 진행상태 재정의).
   * - ACTIVE: 진행중 journey(status=ACTIVE) 보유 고객
   * - DONE:   완료(모든 journey COMPLETED) 또는 계약 완료(CONTRACTED) 고객
   * - ALL:    전체(기본)
   */
  @IsOptional() @IsIn(['ACTIVE', 'DONE', 'ALL']) progress?: string;
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

export class DeactivateCustomerDto {
  @IsOptional() @IsString() reason?: string;
}
