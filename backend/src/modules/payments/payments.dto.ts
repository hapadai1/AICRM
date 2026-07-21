import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, NotEquals, ValidateIf } from 'class-validator';
import { PageQueryDto } from '../../common/pagination';

/**
 * 결제 구분 (연동정합화 계약 §4)
 * OTHER는 구버전 하위호환 입력값으로 수용하며 저장 시 ETC로 통합한다.
 */
export const PAYMENT_TYPES = ['DEPOSIT', 'INTERIM', 'BALANCE', 'REPAIR_FEE', 'REFUND', 'ETC', 'OTHER'] as const;

export class CreatePaymentDto {
  @IsIn(PAYMENT_TYPES as unknown as string[])
  paymentType: string;

  /** 금액(정수 원). 0은 허용하지 않는다. 환불은 음수 또는 REFUND 구분 사용. */
  @IsInt()
  @NotEquals(0)
  amount: number;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'paymentDate 형식은 YYYY-MM-DD 입니다.' })
  paymentDate: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  paymentMethod?: string;

  /** 입금자명 — 저장 시 memo에 "입금자: {payerName}"으로 병합한다. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  payerName?: string;

  @IsOptional()
  @IsString()
  memo?: string;

  @IsOptional()
  @IsIn(['PENDING', 'COMPLETED'])
  status?: string;
}

/** GET /payments — 결제 목록 검색(개편계획 05 §3.1). 진입점은 날짜 범위와 고객이다. */
export class PaymentListQueryDto extends PageQueryDto {
  /** 결제일 범위(양끝 포함) */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dateFrom 형식은 YYYY-MM-DD 입니다.' })
  dateFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dateTo 형식은 YYYY-MM-DD 입니다.' })
  dateTo?: string;

  /** 고객명 · 고객 전화(하이픈 무시) · 계약번호 통합 검색 */
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  contractId?: string;

  @IsOptional()
  @IsIn(PAYMENT_TYPES as unknown as string[])
  paymentType?: string;

  @IsOptional()
  @IsIn(['COMPLETED', 'CANCELLED'])
  status?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  paymentMethod?: string;
}

export class CancelPaymentDto {
  @IsString()
  @IsNotEmpty()
  reason: string;
}

/** PATCH /contracts/:id/payment-schedule — null이면 잔금 예정일을 해제한다. */
export class UpdatePaymentScheduleDto {
  @ValidateIf((o) => o.balanceDueDate !== null && o.balanceDueDate !== undefined)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'balanceDueDate 형식은 YYYY-MM-DD 입니다.' })
  balanceDueDate: string | null;
}
