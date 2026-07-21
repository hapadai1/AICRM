import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination';

export const MEASUREMENT_TYPES = ['INITIAL', 'FITTING', 'REMEASURE', 'OTHER'] as const;

/** 채촌값 1건 입력. 항목 코드는 §9.4 초기값 외의 코드도 자유 수용한다. */
export class MeasurementValueInputDto {
  @IsString() @IsNotEmpty() @MaxLength(40) measurementCode: string;
  /** 미지정 시 알려진 코드는 카탈로그(UPPER/LOWER/SHOES)로 보완, 그 외 ETC */
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(20) bodySection?: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) numericValue?: number;
  @IsOptional() @IsString() @MaxLength(40) textValue?: string;
  @IsOptional() @IsString() @MaxLength(10) unit?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
}

export class CreateMeasurementSessionDto {
  @IsDateString() measurementDate: string;
  @IsOptional() @IsIn(MEASUREMENT_TYPES as unknown as string[]) measurementType?: string;
  @IsOptional() @IsUUID() relatedOrderId?: string;
  @IsOptional() @IsUUID() previousSessionId?: string;
  @IsOptional() @IsString() @MaxLength(100) fitPreference?: string;
  @IsOptional() @IsString() bodyNotes?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MeasurementValueInputDto)
  values?: MeasurementValueInputDto[];
}

/** 임시 저장(PATCH): 메타 수정 + 값 UPSERT */
export class UpdateMeasurementSessionDto {
  @IsOptional() @IsDateString() measurementDate?: string;
  @IsOptional() @IsIn(MEASUREMENT_TYPES as unknown as string[]) measurementType?: string;
  @IsOptional() @IsUUID() relatedOrderId?: string;
  @IsOptional() @IsString() @MaxLength(100) fitPreference?: string;
  @IsOptional() @IsString() bodyNotes?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MeasurementValueInputDto)
  values?: MeasurementValueInputDto[];
}

/** 고객을 본문으로 받는 생성 (독립 채촌 화면용, 설계서 09 §3.2) */
export class CreateMeasurementBodyDto extends CreateMeasurementSessionDto {
  @IsUUID() customerId: string;
}

/** MEAS-001 전역 채촌 검색 (설계서 09 §3.1) */
export class MeasurementListQueryDto extends PageQueryDto {
  /** 고객명 부분일치 또는 전화번호 숫자 부분일치(3자 이상) */
  @IsOptional() @IsString() @MaxLength(50) q?: string;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsDateString() dateFrom?: string;
  @IsOptional() @IsDateString() dateTo?: string;
  @IsOptional() @IsIn(MEASUREMENT_TYPES as unknown as string[]) type?: string;
  @IsOptional() @IsIn(['DRAFT', 'COMPLETED']) status?: 'DRAFT' | 'COMPLETED';
}

export class CloneMeasurementSessionDto {
  /** 미지정 시 오늘 날짜 */
  @IsOptional() @IsDateString() measurementDate?: string;
  /** 미지정 시 원본 세션의 구분 유지 */
  @IsOptional() @IsIn(MEASUREMENT_TYPES as unknown as string[]) measurementType?: string;
  @IsOptional() @IsUUID() relatedOrderId?: string;
  @IsOptional() @IsString() notes?: string;
}

export class CompareMeasurementsQueryDto {
  @IsUUID() left: string;
  @IsUUID() right: string;
}

export class LinkOrderItemMeasurementDto {
  @IsUUID() measurementSessionId: string;
  /** 낙관적 잠금: 전달 시 order_items.row_version과 비교 (구현표준 §1.5) */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) version?: number;
}
