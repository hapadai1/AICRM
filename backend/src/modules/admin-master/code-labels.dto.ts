import { IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateCodeLabelDto {
  @IsString()
  @MinLength(1, { message: '표시명을 입력해 주세요.' })
  @MaxLength(100)
  label!: string;
}
