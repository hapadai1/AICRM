import { IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import { RENTAL_COMPONENT_TYPES } from '../rentals/rentals.constants';

export class CreateMasterItemDto {
  /** 코드: 생성 후 변경 불가. */
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z0-9_]{2,40}$/, { message: 'code는 대문자·숫자·언더스코어 2~40자입니다.' })
  code: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  /**
   * 렌탈 컬러·사이즈 전용: 이 코드를 쓰는 품목 목록. 비우면 전 품목 공통.
   * 사이즈 체계가 품목마다 달라(상의 46~60, 구두 250~280) 갈라 두지 않으면 드롭다운이 섞인다.
   * 다른 기준정보 유형에 넘기면 무시된다.
   */
  @IsOptional()
  @IsArray()
  @IsIn(RENTAL_COMPONENT_TYPES, { each: true })
  componentTypes?: string[];

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** 표시명·적용 품목·정렬·사용 여부만 수정 가능하다 (코드 변경 불가). */
export class UpdateMasterItemDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsArray()
  @IsIn(RENTAL_COMPONENT_TYPES, { each: true })
  componentTypes?: string[];

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
