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
import { CHOICE_CODES } from './choice-codes';
import { COMPONENT_GROUP_CODES } from './option-component-groups';

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
  /** 한 단계에 2~40개, A부터 순서대로 사용한다 (A~Z 다음은 AA~AN). */
  @IsIn(CHOICE_CODES) choiceCode: string;
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
  /** 부위 그룹(JACKET/TROUSERS/VEST). 셔츠·구두 등 단일 부위 세트는 미지정(null). */
  @IsOptional() @IsIn(COMPONENT_GROUP_CODES) componentGroup?: string;
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

/** 부위별 원단·컬러·패턴·비고 입력 (설계서 04 §2) */
export class ComponentAttrDto {
  @IsOptional() @IsString() @MaxLength(150) fabricName?: string;
  @IsOptional() @IsString() @MaxLength(150) colorName?: string;
  @IsOptional() @IsString() @MaxLength(150) patternName?: string;
  @IsOptional() @IsString() notes?: string;
}

/** 부위 그룹까지 지정한 component-attr 항목 (세션 start body의 배열용) */
export class ComponentAttrItemDto extends ComponentAttrDto {
  @IsIn(COMPONENT_GROUP_CODES) componentGroup: string;
}

/** PUT /option-sessions/:id/component-attrs/:group — 부위별 upsert (낙관적 잠금) */
export class SaveComponentAttrDto extends ComponentAttrDto {
  /** 낙관적 잠금: option_selection_sessions.row_version */
  @Type(() => Number) @IsInt() @Min(0) version: number;
}

export class StartOptionSessionDto {
  /** 원단명 — 세션 fabric_name에 저장한다 (연동정합화 계약 §6) */
  @IsOptional() @IsString() @MaxLength(150) fabric?: string;
  /** 부위별 원단·컬러·패턴 (설계서 04 §2). 지정 시 부위별 upsert */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ComponentAttrItemDto)
  componentAttrs?: ComponentAttrItemDto[];
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
