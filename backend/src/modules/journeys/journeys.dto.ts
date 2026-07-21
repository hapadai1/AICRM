import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination';
import { JOURNEY_STATUSES, NOTIFICATION_OUTCOMES, TRACK_TYPES } from './journeys.constants';

export class ListStagesQueryDto {
  @IsOptional() @IsIn([...TRACK_TYPES]) trackType?: string;
}

/** 단계 ↔ 연락 문구 매핑 변경. templateId를 null로 보내면 연락을 끈다. */
export class UpdateStageTemplateDto {
  @IsOptional() @IsUUID() templateId?: string | null;
}

export class CreateJourneyDto {
  @IsIn([...TRACK_TYPES]) trackType: string;
  /** 계약 전이면 생략한다. */
  @IsOptional() @IsUUID() orderId?: string;
  /** 생략 시 트랙의 첫 단계에서 시작한다. */
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(30) startStageCode?: string;
}

export class ChangeStageDto {
  @IsString() @IsNotEmpty() @MaxLength(30) toStageCode: string;
  /** 되돌리기(후진) 시 필수 */
  @IsOptional() @IsString() @IsNotEmpty() reason?: string;
  @IsOptional() @IsString() notes?: string;
  /** 낙관적 잠금: 조회 시점의 rowVersion */
  @Type(() => Number) @IsInt() @Min(0) version: number;
}

/** 발송 확인창의 처리 결과를 이력에 봉합한다. */
export class NotificationOutcomeDto {
  @IsIn([...NOTIFICATION_OUTCOMES]) outcome: string;
  /** outcome=SENT일 때 notification_history.id */
  @IsOptional() @IsUUID() notificationHistoryId?: string;
}

export class CloseJourneyDto {
  @Type(() => Number) @IsInt() @Min(0) version: number;
  @IsOptional() @IsString() @IsNotEmpty() reason?: string;
}

export class ListJourneysQueryDto extends PageQueryDto {
  @IsOptional() @IsIn([...TRACK_TYPES]) trackType?: string;
  @IsOptional() @IsIn([...JOURNEY_STATUSES]) status?: string;
  /** 단계 코드 콤마 목록 */
  @IsOptional() @IsString() stageCodes?: string;
  @IsOptional() @IsUUID() customerId?: string;
  /** 지정 일수 이상 같은 단계에 머문 건만 */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) stalledDays?: number;
}
