import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { PageQueryDto } from '../../common/pagination';

/** 작업지시서 목록 판정 상태 (조회 조건으로 계산, 별도 테이블 없음 — 데이터모델 §10.5) */
export const WORK_ORDER_LIST_STATUSES = ['UNORDERED', 'REPRINT_NEEDED', 'CURRENT'] as const;
export type WorkOrderListStatus = (typeof WORK_ORDER_LIST_STATUSES)[number];

export class WorkOrderListQueryDto extends PageQueryDto {
  /** 콤마 구분 다중선택: UNORDERED,REPRINT_NEEDED,CURRENT */
  @IsOptional()
  @IsString()
  status?: string;
}

/** POST /order-items/:id/work-order-versions 요청 (화면·API 정의서 §14.5) */
export class IssueWorkOrderVersionDto {
  /** 출력에 사용할 채촌 세션 교체 (미지정 시 현재 연결 채촌) */
  @IsOptional()
  @IsUUID()
  measurementSessionId?: string;

  /** 변경 사유·비고 (V2 이상 권장) */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /** 낙관적 잠금: order_items.row_version 비교 (미지정 시 검사 생략) */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version?: number;
}
