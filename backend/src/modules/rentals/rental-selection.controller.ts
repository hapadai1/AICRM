import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import { RentalSelectionService } from './rental-selection.service';
import {
  ConfirmRentalSelectionDto,
  SaveRentalLineDto,
  SaveRentalPeriodDto,
  SelectRentalItemDto,
} from './rentals.dto';

/** 렌탈 스타일 선택 (v2 D3 / 설계서 04 §4) */
@Controller()
export class RentalSelectionController {
  constructor(private readonly service: RentalSelectionService) {}

  /** 렌탈 선택 세션 시작/현재본 반환 (RENTAL 품목만) */
  @Post('order-items/:id/rental-selection')
  @RequirePermission('RENTAL_ALLOCATE')
  start(@Param('id') orderItemId: string) {
    return this.service.startSession(orderItemId);
  }

  /** 품목의 현재 렌탈 선택 세션 상세 — 없으면 { session: null } */
  @Get('order-items/:id/rental-selection')
  @RequirePermission('RENTAL_VIEW')
  currentSession(@Param('id') orderItemId: string) {
    return this.service.currentSession(orderItemId);
  }

  /**
   * 렌탈 품목별 부위 선택 현황 (스타일 컨설팅 목록용).
   * `:id` 라우트보다 먼저 선언해야 'progress'가 세션 id로 잡히지 않는다.
   */
  @Get('rental-selections/progress')
  @RequirePermission('RENTAL_VIEW')
  progress(@Query('contractId') contractId?: string) {
    return this.service.progress(contractId);
  }

  /** 렌탈 컬러·사이즈 활성 코드 (드롭다운용 읽기 전용) */
  @Get('rental-selections/codes')
  @RequirePermission('RENTAL_VIEW')
  codes() {
    return this.service.codes();
  }

  @Get('rental-selections/:id')
  @RequirePermission('RENTAL_VIEW')
  detail(@Param('id') id: string) {
    return this.service.detail(id);
  }

  /** 부위별 컬러·사이즈·비고 upsert */
  /** 대여 기간 지정 (현업 확정 2026-07-28: 필수값). 기간이 바뀌면 고른 실물은 비워진다. */
  @Put('rental-selections/:id/period')
  @RequirePermission('RENTAL_ALLOCATE')
  savePeriod(
    @Param('id') id: string,
    @Body() dto: SaveRentalPeriodDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.savePeriod(id, dto, actor);
  }

  @Put('rental-selections/:id/lines/:componentId')
  @RequirePermission('RENTAL_ALLOCATE')
  saveLine(
    @Param('id') id: string,
    @Param('componentId') componentId: string,
    @Body() dto: SaveRentalLineDto,
  ) {
    return this.service.saveLine(id, componentId, dto);
  }

  /** 부위별 후보 실물 검색 (재고상태 AVAILABLE) */
  @Get('rental-selections/:id/lines/:componentId/candidates')
  @RequirePermission('RENTAL_VIEW')
  candidates(@Param('id') id: string, @Param('componentId') componentId: string) {
    return this.service.candidates(id, componentId);
  }

  /** 후보 실물 선택(또는 해제) */
  @Put('rental-selections/:id/lines/:componentId/item')
  @RequirePermission('RENTAL_ALLOCATE')
  selectItem(
    @Param('id') id: string,
    @Param('componentId') componentId: string,
    @Body() dto: SelectRentalItemDto,
  ) {
    return this.service.selectItem(id, componentId, dto);
  }

  @Post('rental-selections/:id/confirm')
  @RequirePermission('RENTAL_ALLOCATE')
  @HttpCode(HttpStatus.OK)
  confirm(
    @Param('id') id: string,
    @Body() dto: ConfirmRentalSelectionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.confirm(id, dto, actor);
  }

  @Get('rental-selections/:id/review')
  @RequirePermission('RENTAL_VIEW')
  review(@Param('id') id: string) {
    return this.service.review(id);
  }
}
