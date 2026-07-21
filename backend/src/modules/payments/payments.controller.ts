import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import {
  CancelPaymentDto,
  CreatePaymentDto,
  PaymentListQueryDto,
  UpdatePaymentScheduleDto,
} from './payments.dto';
import { PaymentsService } from './payments.service';

/** 결제(수기 수금) API — 화면·API 정의서 13.7 (PAY-001) + 연동정합화 계약 §4 */
@Controller()
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  /** 결제 통합 검색 — 날짜 범위·고객 기준 진입점 (개편계획 05 §3.1) */
  @Get('payments')
  @RequirePermission('PAYMENT_VIEW')
  search(@Query() query: PaymentListQueryDto) {
    return this.paymentsService.search(query);
  }

  @Get('contracts/:id/payments')
  @RequirePermission('PAYMENT_VIEW')
  listByContract(@Param('id') contractId: string) {
    return this.paymentsService.listByContract(contractId);
  }

  @Post('contracts/:id/payments')
  @RequirePermission('PAYMENT_EDIT')
  create(@Param('id') contractId: string, @Body() dto: CreatePaymentDto, @CurrentUser() actor: AuthUser) {
    return this.paymentsService.create(contractId, dto, actor);
  }

  /** 잔금 결제 예정일 설정·해제 (contracts.balance_due_date) */
  @Patch('contracts/:id/payment-schedule')
  @RequirePermission('PAYMENT_EDIT')
  updateSchedule(
    @Param('id') contractId: string,
    @Body() dto: UpdatePaymentScheduleDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.paymentsService.updateSchedule(contractId, dto, actor);
  }

  @Post('payments/:id/cancel')
  @RequirePermission('PAYMENT_EDIT')
  cancel(@Param('id') paymentId: string, @Body() dto: CancelPaymentDto, @CurrentUser() actor: AuthUser) {
    return this.paymentsService.cancel(paymentId, dto, actor);
  }
}
