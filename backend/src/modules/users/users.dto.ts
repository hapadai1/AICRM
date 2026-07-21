import { ArrayNotEmpty, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateUserDto {
  @IsString() @IsNotEmpty() loginId: string;
  @IsString() @IsNotEmpty() displayName: string;
  @IsString() @MinLength(8) password: string;
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) roleCodes: string[];
}

export class UpdateUserDto {
  @IsOptional() @IsString() @IsNotEmpty() displayName?: string;
  @IsOptional() @IsString() @MinLength(8) password?: string;
  @IsOptional() @IsIn(['ACTIVE', 'LOCKED', 'INACTIVE']) status?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) roleCodes?: string[];
}

export class UpdateRolePermissionsDto {
  @IsArray() @IsString({ each: true }) permissionCodes: string[];
}
