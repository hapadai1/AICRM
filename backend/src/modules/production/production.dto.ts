import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination';
import { FITTING_AREA_CODES } from './fitting.constants';

/** 품목·구성품 상태 이벤트 공통 입력 */
export class CreateProductionEventDto {
  @IsString() @IsNotEmpty() newStatus: string;
  @IsOptional() @IsDateString() eventDate?: string;
  @IsOptional() @IsDateString() expectedDate?: string;
  @IsOptional() @IsString() notes?: string;
  /** 상태 역행·취소 시 변경 사유 */
  @IsOptional() @IsString() reason?: string;
}

export class ReceiveComponentDto {
  /** 실제 입고일 (미입력 시 오늘) */
  @IsOptional() @IsDateString() receivedAt?: string;
  @IsOptional() @IsString() notes?: string;
}

export class ReleaseComponentDto {
  /** 실제 출고일 (미입력 시 오늘) */
  @IsOptional() @IsDateString() releasedAt?: string;
  @IsOptional() @IsString() notes?: string;
}

export class ProductionItemsQueryDto extends PageQueryDto {
  /** 품목 집계 상태 필터 (§13.4 코드) */
  @IsOptional() @IsString() status?: string;
}

export class FittingAdjustmentDto {
  @IsOptional() @IsUUID() componentId?: string;
  /** 표준 확인 항목 (개발설계서 05 G-04). 미지정 시 기타. */
  @IsOptional() @IsIn([...FITTING_AREA_CODES]) areaCode?: string;
  /** 세부 부위 자유입력 (예: 왼쪽 소매) */
  @IsString() @IsNotEmpty() area: string;
  @IsString() @IsNotEmpty() instruction: string;
}

export class CreateFittingDto {
  @IsDateString() fittingDate: string;
  @IsOptional() @IsUUID() appointmentId?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsDateString() nextAppointmentDate?: string;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FittingAdjustmentDto)
  adjustments?: FittingAdjustmentDto[];
}
