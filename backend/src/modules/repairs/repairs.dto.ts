import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination';
import { codesOf } from '../admin-master/code-labels.constants';

/**
 * 수선 유형 (데이터모델 §12.1) — 코드 집합은 기준정보 상수에서 파생한다(단일 출처).
 * 렌탈 수선은 이 도메인에서 다루지 않는다 — 렌탈 진행(RENTAL 트랙)의
 * 수선요청·수선입고·수선출고 단계와 렌탈 실물 상태(ALTERATION)로 관리한다.
 */
export const REPAIR_TYPES = codesOf('repair-type');

/**
 * 수선 대상 품목 — 구성품 코드 집합(상의·하의·베스트·셔츠·구두)을 그대로 쓴다.
 * 계약에 등록된 주문 품목을 찾아 연결하지 않고 이 목록에서 자유롭게 고른다.
 */
export const REPAIR_TARGET_PRODUCTS = codesOf('component-type');

/**
 * 접수·출고 방식 (개발설계서 05 G-07).
 * 설계 PDF 1페이지 수선 구분의 "수선 물품 수선 요청 방문 / 출고 방문" 대응.
 * 택배는 운영하지 않으므로 방문 2종만 둔다.
 */
export const REPAIR_RECEIPT_METHODS = ['VISIT', 'PICKUP'] as const;
export const REPAIR_RELEASE_METHODS = ['VISIT', 'DELIVERY'] as const;

/** 접수·출고 방식 공통 필드 */
class RepairMethodDto {
  /** VISIT 고객 방문 | PICKUP 방문 수거 */
  @IsOptional() @IsIn([...REPAIR_RECEIPT_METHODS]) receiptMethod?: string;
  /** VISIT 고객 방문 | DELIVERY 방문 배송 */
  @IsOptional() @IsIn([...REPAIR_RELEASE_METHODS]) releaseMethod?: string;
  @IsOptional() @IsString() @MaxLength(300) pickupAddress?: string;
  @IsOptional() @IsString() @MaxLength(300) deliveryAddress?: string;
}

/**
 * 전체 상태 — 세부 6단계를 현업이 목록을 여는 기준(지금 처리할 게 뭐냐)으로 묶은 값.
 * 저장하는 값이 아니라 검색조건 전용이다. 건마다 남는 건 여전히 세부 status 하나뿐이고,
 * 여기서는 그 값을 묶어 where 절로 풀기만 한다(스키마·데이터 변경 없음).
 *
 * 취소는 완료에 넣지 않는다 — 넣으면 "완료 12건"에 취소가 섞여 숫자를 못 믿게 된다.
 * 고객 연락은 상태가 아니라 발송 액션이라 여기에 없다(수선 입고 상태에 머문다).
 */
export const REPAIR_PHASE_STATUSES = {
  IN_PROGRESS: ['RECEIVED', 'REQUESTED', 'RETURNED_TO_SHOP'],
  DONE: ['RELEASED'],
  CANCELLED: ['CANCELLED'],
} as const;

export const REPAIR_PHASES = Object.keys(REPAIR_PHASE_STATUSES) as RepairPhase[];
export type RepairPhase = keyof typeof REPAIR_PHASE_STATUSES;

export class ListRepairsQueryDto extends PageQueryDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsUUID() customerId?: string;
  /**
   * 전체 상태(진행중·완료·취소). 세부 status를 함께 지정하면 그쪽이 이긴다 —
   * 세부 상태는 이미 한 묶음 안의 값이라 둘을 교집합할 이유가 없다.
   */
  @IsOptional() @IsIn(REPAIR_PHASES) phase?: RepairPhase;
}

/** 대상 품목 한 줄 (품목·개수) */
export class RepairItemDto {
  @IsIn([...REPAIR_TARGET_PRODUCTS]) targetProduct: string;
  @IsInt() @Min(1) @Max(99) quantity: number;
}

export class CreateRepairDto extends RepairMethodDto {
  @IsUUID() customerId: string;
  @IsIn([...REPAIR_TYPES]) repairType: string;
  @IsDateString() requestDate: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsString() @IsNotEmpty() description: string;
  @IsOptional() @IsString() notes?: string;
  /** 대상 품목·개수. 유형과 무관하게 1줄 이상 필수 (service.assertItems) */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RepairItemDto)
  items?: RepairItemDto[];
}

export class UpdateRepairDto extends RepairMethodDto {
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() @IsNotEmpty() description?: string;
  @IsOptional() @IsString() notes?: string;
  /** 주면 기존 줄을 통째로 교체한다 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RepairItemDto)
  items?: RepairItemDto[];
}

/** 품목 줄·벌 진행(수선요청·입고·출고) 공통 입력 — 날짜를 안 주면 오늘로 찍는다. */
export class RepairProgressDto {
  @IsOptional() @IsDateString() eventDate?: string;
  @IsOptional() @IsString() @MaxLength(300) notes?: string;
}
