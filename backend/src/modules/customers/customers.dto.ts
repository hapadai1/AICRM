import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
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

export class CreateCustomerDto {
  @IsString() @IsNotEmpty() @MaxLength(80) name: string;
  @IsString() @IsNotEmpty() @MaxLength(30) phone: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() notes?: string;
  /** 미지정 시 PROSPECT (DB 기본값). 계약 전환은 계약 확정 트랜잭션에서 수행 */
  @IsOptional() @IsIn(['PROSPECT', 'CONTRACTED']) customerStatus?: string;
}

export class UpdateCustomerDto {
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
