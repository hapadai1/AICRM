import { IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  loginId: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

/** 관리자 재인증 — 현재 토큰 사용자의 비밀번호만 재확인한다 (설계서 01 §6). */
export class VerifyPasswordDto {
  @IsString()
  @IsNotEmpty()
  password: string;
}
