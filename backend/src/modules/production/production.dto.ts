import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
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

/**
 * 단계 처리 취소 — 방금 누른 것을 없던 일로 되돌린다 (2026-08-05 현업 확정).
 *
 * 업무를 되돌리는 기능이 아니라 **시스템을 잘못 누른 것을 정정**하는 기능이다.
 * 그래서 그 단계가 만든 기록(품목 상태·구성품 상태·입출고 일자)만 지우고 사유는 묻지 않는다.
 */
export class UndoStageDto {
  /** 되돌릴 단계 처리의 종류 (화면의 ProductionStage.effect와 같은 값) */
  @IsIn(['ITEM_REQUEST', 'ITEM_FITTING', 'COMPONENT_BASTING', 'COMPONENT_RECEIVE', 'COMPONENT_RELEASE'])
  effect: string;
  /** 구성품 하나만 되돌릴 때 (미지정 시 그 단계로 처리된 구성품 전체) */
  @IsOptional() @IsUUID() componentId?: string;
}

export class ProductionItemsQueryDto extends PageQueryDto {
  /** 품목 집계 상태 필터 (§13.4 코드) */
  @IsOptional() @IsString() status?: string;
  /** 계약 단위 조회 — 지정 시 해당 계약의 품목만 반환 */
  @IsOptional() @IsUUID() contractId?: string;
  /**
   * 준비 중(발주 이전) 품목까지 포함할지 — 계약 상세(제작 관리) 화면 전용.
   * 전역 목록은 준비 끝난 품목만 다루지만, 계약 상세는 진행(journey) 단계 대상과 짝이 맞아야
   * 준비 카드가 미완 품목을 빠뜨리지 않고 정직하게 센다.
   */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  includePrep?: boolean;
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
