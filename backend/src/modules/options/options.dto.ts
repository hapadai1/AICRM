import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

// ---------------------------------------------------------------------------
// 마스터 (ADMIN-002)
// ---------------------------------------------------------------------------

export class ActiveOptionSetQueryDto {
  @IsString() @IsNotEmpty() category: string;
}

export class CreateOptionSetVersionDto {
  /** 지정 시 해당 버전의 단계·선택지를 복사해 DRAFT를 만든다. 미지정 시 빈 버전. */
  @IsOptional() @IsUUID() copyFromVersionId?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsISO8601() effectiveFrom?: string;
}

export class OptionChoiceInputDto {
  /** 한 단계에 2~3개, A부터 순서대로 사용한다. */
  @IsIn(['A', 'B', 'C']) choiceCode: string;
  @IsString() @IsNotEmpty() @MaxLength(100) choiceName: string;
  @IsOptional() @IsString() @MaxLength(100) factoryLabel?: string;
  /** 미지정 시 placeholder 파일을 생성해 연결한다 (files FK 필수). */
  @IsOptional() @IsUUID() imageFileId?: string;
  /** 이 선택지를 고를 때 계약금액에 더해지는 추가금액(원). 기본 0. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) extraPrice?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class OptionStageInputDto {
  @IsString() @IsNotEmpty() @MaxLength(40) stageCode: string;
  @IsString() @IsNotEmpty() @MaxLength(100) stageName: string;
  @Type(() => Number) @IsInt() @Min(1) sequenceNo: number;
  @IsOptional() @IsBoolean() required?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OptionChoiceInputDto)
  choices: OptionChoiceInputDto[];
}

export class SaveOptionStagesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => OptionStageInputDto)
  stages: OptionStageInputDto[];
}

export class ActivateOptionSetVersionDto {
  @IsOptional() @IsISO8601() effectiveFrom?: string;
}

// ---------------------------------------------------------------------------
// 선택 세션 (OPT-001~003)
// ---------------------------------------------------------------------------

export class StartOptionSessionDto {
  /** 원단명 — 세션 fabric_name에 저장한다 (연동정합화 계약 §6) */
  @IsOptional() @IsString() @MaxLength(150) fabric?: string;
}

export class SaveStageSelectionDto {
  @IsUUID() choiceId: string;
  /** 화면 진행 순서(참고값). 저장 대상은 경로의 stageId다. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) currentStageOrder?: number;
  /** 낙관적 잠금: option_selection_sessions.row_version */
  @Type(() => Number) @IsInt() @Min(0) version: number;
}

export class PauseSessionDto {
  @IsOptional() @IsUUID() currentStageId?: string;
  @IsOptional() @IsString() @MaxLength(150) fabricName?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) version?: number;
}

export class ConfirmSessionDto {
  @Type(() => Number) @IsInt() @Min(0) version: number;
  @IsOptional() @IsString() @MaxLength(150) fabricName?: string;
}

export class CopySessionDto {
  @IsUUID() targetOrderItemId: string;
}
