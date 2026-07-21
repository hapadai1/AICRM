import { IsDateString, IsIn, IsOptional, IsString } from 'class-validator';

export const COMPONENT_TYPES = ['JACKET', 'TROUSERS', 'VEST', 'SHIRT', 'SHOES'] as const;

export class AddComponentDto {
  @IsIn(COMPONENT_TYPES as unknown as string[])
  componentType: string;

  @IsOptional()
  @IsDateString()
  expectedInboundDate?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * 구성품 수정: 메모·입고 예정일 등. 수량 개념은 없다 —
 * 품목 수량 변경은 계약 변경(POST /contracts/:id/revisions)으로만 가능하다.
 */
export class UpdateComponentDto {
  @IsOptional()
  @IsDateString()
  expectedInboundDate?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
