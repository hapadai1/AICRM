import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size: number = 30;

  get skip(): number {
    return (this.page - 1) * this.size;
  }
}

/** 서비스가 반환하면 ResponseInterceptor가 목록 envelope으로 변환한다. */
export class Paginated<T> {
  constructor(
    readonly items: T[],
    readonly number: number,
    readonly size: number,
    readonly totalElements: number,
    /** 목록 envelope 최상위에 함께 실을 부가 정보(예: 결제 목록의 totals) */
    readonly extra?: Record<string, unknown>,
  ) {}

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.totalElements / this.size));
  }
}
