import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class CreateMasterItemDto {
  /** 코드: 생성 후 변경 불가. */
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z0-9_]{2,40}$/, { message: 'code는 대문자·숫자·언더스코어 2~40자입니다.' })
  code: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** 표시명·정렬·사용 여부만 수정 가능하다 (코드 변경 불가). */
export class UpdateMasterItemDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
