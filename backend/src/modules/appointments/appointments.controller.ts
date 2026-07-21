import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import {
  AppointmentListQueryDto,
  CancelAppointmentDto,
  CreateAppointmentDto,
  CreateConsultationDto,
  UpdateConsultationDto,
  ResolveConflictDto,
  UpdateAppointmentDto,
} from './appointments.dto';
import { AppointmentsService } from './appointments.service';

/** 예약·상담 (화면·API 정의서 13.2 APPT-001/002) */
@Controller()
export class AppointmentsController {
  constructor(private readonly appointmentsService: AppointmentsService) {}

  @Get('appointments')
  @RequirePermission('APPOINTMENT_VIEW')
  list(@Query() query: AppointmentListQueryDto) {
    return this.appointmentsService.list(query);
  }

  /** 예약 목적 목록 (연동정합화 계약 §1) */
  @Get('appointment-purposes')
  @RequirePermission('APPOINTMENT_VIEW')
  listPurposes() {
    return this.appointmentsService.listPurposes();
  }

  @Post('appointments')
  @RequirePermission('APPOINTMENT_EDIT')
  create(@Body() dto: CreateAppointmentDto, @CurrentUser() actor: AuthUser) {
    return this.appointmentsService.create(dto, actor);
  }

  @Get('appointments/:id')
  @RequirePermission('APPOINTMENT_VIEW')
  detail(@Param('id') id: string) {
    return this.appointmentsService.detail(id);
  }

  @Patch('appointments/:id')
  @RequirePermission('APPOINTMENT_EDIT')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAppointmentDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.appointmentsService.update(id, dto, actor);
  }

  @Post('appointments/:id/confirm')
  @RequirePermission('APPOINTMENT_EDIT')
  confirm(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.appointmentsService.confirm(id, actor);
  }

  @Post('appointments/:id/visit')
  @RequirePermission('APPOINTMENT_EDIT')
  visit(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.appointmentsService.markVisited(id, actor);
  }

  @Post('appointments/:id/no-show')
  @RequirePermission('APPOINTMENT_EDIT')
  noShow(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.appointmentsService.markNoShow(id, actor);
  }

  /** 네이버 동기화 충돌 해소 (연동정합화 계약 §1) */
  @Post('appointments/:id/resolve-conflict')
  @RequirePermission('APPOINTMENT_EDIT')
  resolveConflict(
    @Param('id') id: string,
    @Body() dto: ResolveConflictDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.appointmentsService.resolveConflict(id, dto.resolution, actor);
  }

  @Post('appointments/:id/cancel')
  @RequirePermission('APPOINTMENT_EDIT')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelAppointmentDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.appointmentsService.cancel(id, dto.reason, actor);
  }

  @Post('appointments/:id/consultations')
  @RequirePermission('CONSULTATION_EDIT')
  addConsultation(
    @Param('id') id: string,
    @Body() dto: CreateConsultationDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.appointmentsService.addConsultation(id, dto, actor);
  }

  @Get('appointments/:id/consultations')
  @RequirePermission('APPOINTMENT_VIEW')
  listConsultations(@Param('id') id: string) {
    return this.appointmentsService.listConsultationsByAppointment(id);
  }

  /** 상담 내용 정정 (개발설계서 05 G-01) */
  @Patch('consultations/:id')
  @RequirePermission('CONSULTATION_EDIT')
  updateConsultation(
    @Param('id') id: string,
    @Body() dto: UpdateConsultationDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.appointmentsService.updateConsultation(id, dto, actor);
  }

  /** 고객 상담 이력 (고객 상세 탭) */
  @Get('customers/:customerId/consultations')
  @RequirePermission('CUSTOMER_VIEW')
  listCustomerConsultations(@Param('customerId') customerId: string) {
    return this.appointmentsService.listConsultationsByCustomer(customerId);
  }

  /** 네이버 예약 수동 동기화 (단방향 수집, APPT-001) */
  @Post('integrations/naver/reservations/sync')
  @RequirePermission('NAVER_SYNC')
  syncNaver(@CurrentUser() actor: AuthUser) {
    return this.appointmentsService.syncNaverReservations(actor);
  }
}
