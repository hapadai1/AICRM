import { Type } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsIn,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination';
import { USAGE_TYPES } from './consultations.constants';

/** 예약 상태 (설계서 5.2 — 시스템 고정 코드) */
export const APPOINTMENT_STATUSES = [
  'RESERVED',
  'CONFIRMED',
  'VISITED',
  'CANCELLED',
  'NO_SHOW',
] as const;

export const APPOINTMENT_SOURCES = ['NAVER', 'CRM'] as const;

export class AppointmentListQueryDto extends PageQueryDto {
  /** 기간 시작 (YYYY-MM-DD 또는 ISO-8601) */
  @IsOptional() @IsISO8601() from?: string;
  /** 기간 종료 (YYYY-MM-DD는 해당 일 전체 포함) */
  @IsOptional() @IsISO8601() to?: string;
  /** 예약 목적 코드 (appointment_purposes.code) */
  @IsOptional() @IsString() purpose?: string;
  /** 예약 목적 코드 콤마 목록 (예: FITTING,INITIAL_CONSULTATION) — purpose보다 우선 */
  @IsOptional() @IsString() purposeCodes?: string;
  @IsOptional() @IsIn([...APPOINTMENT_SOURCES]) source?: string;
  @IsOptional() @IsIn([...APPOINTMENT_STATUSES]) status?: string;
  /** 예약 상태 콤마 목록 (예: RESERVED,CONFIRMED) — status보다 우선 */
  @IsOptional() @IsString() statuses?: string;
  @IsOptional() @IsUUID() customerId?: string;
}

/** CRM 직접 등록: customerId 또는 (customerName + phone) 필요 (데이터모델 15.1 흐름) */
export class CreateAppointmentDto {
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) customerName?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(30) phone?: string;
  @IsOptional() @IsEmail() email?: string;

  @IsString() @IsNotEmpty() purposeCode: string;
  @IsISO8601() scheduledStart: string;
  @IsOptional() @IsISO8601() scheduledEnd?: string;
  @IsOptional() @IsString() notes?: string;
}

export class UpdateAppointmentDto {
  @IsOptional() @IsString() @IsNotEmpty() purposeCode?: string;
  @IsOptional() @IsISO8601() scheduledStart?: string;
  @IsOptional() @IsISO8601() scheduledEnd?: string;
  @IsOptional() @IsString() notes?: string;
  /** 예약을 기존 고객에 연결(고객 상세의 "기존 고객 연결") */
  @IsOptional() @IsUUID() customerId?: string;
  /** 낙관적 잠금: 조회 시점의 rowVersion */
  @Type(() => Number) @IsInt() @Min(0) version: number;
}

export class CancelAppointmentDto {
  /** 취소 사유 (감사로그 필수) */
  @IsString() @IsNotEmpty() reason: string;
}

/** 네이버 충돌 해소: NAVER=네이버 원본 채택, CRM=CRM 수정본 유지 (연동정합화 계약 §1) */
export class ResolveConflictDto {
  @IsIn(['NAVER', 'CRM']) resolution: 'NAVER' | 'CRM';
}

/**
 * 초도 상담 항목 (개발설계서 05 G-01).
 * 설계 PDF 1페이지 "용도·예산·희망 스타일·납기 확인"을 구조화한 필드.
 */
class ConsultationIntakeDto {
  @IsOptional() @IsIn([...USAGE_TYPES]) usageType?: string;
  /** 예산 범위(정수 원). 단일값이면 min=max로 저장한다. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) budgetMin?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) budgetMax?: number;
  @IsOptional() @IsString() @MaxLength(200) preferredStyle?: string;
  /** 고객이 희망한 납기 (YYYY-MM-DD) */
  @IsOptional() @IsISO8601() desiredDueDate?: string;
}

export class CreateConsultationDto extends ConsultationIntakeDto {
  /** 실제 상담 일시. 미지정 시 현재 시각 */
  @IsOptional() @IsISO8601() consultedAt?: string;
  /** 관심 품목 목록 — consultation_category에 콤마로 저장 (연동정합화 계약 §1) */
  @IsOptional() @IsArray() @IsString({ each: true }) interests?: string[];
  /** 하위호환: interests 미지정 시 그대로 저장 */
  @IsOptional() @IsString() @MaxLength(30) consultationCategory?: string;
  @IsString() @IsNotEmpty() content: string;
}

/** 상담 내용 정정 (PATCH /consultations/:id) */
export class UpdateConsultationDto extends ConsultationIntakeDto {
  @IsOptional() @IsISO8601() consultedAt?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) interests?: string[];
  @IsOptional() @IsString() @IsNotEmpty() content?: string;
}
