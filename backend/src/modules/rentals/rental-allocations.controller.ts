import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import { RentalAllocationsService } from './rental-allocations.service';
import { RentalNotesService } from './rental-notes.service';
import {
  AllocationListQueryDto,
  ChangeItemDto,
  CheckoutDto,
  CreateAllocationContactDto,
  CreateAllocationDto,
  CreateAllocationNoteDto,
  RentalOrderComponentsQueryDto,
  ReturnDto,
} from './rentals.dto';

@Controller()
export class RentalAllocationsController {
  constructor(
    private readonly service: RentalAllocationsService,
    private readonly notesService: RentalNotesService,
  ) {}

  /** 출고·반납 대상 목록 뷰 (RENT-004) */
  @Get('rental-allocations')
  @RequirePermission('RENTAL_VIEW')
  list(@Query() query: AllocationListQueryDto) {
    return this.service.list(query);
  }

  /** 배정 대상 렌탈 구성품 + 현재 배정 목록 (RENT-003) */
  @Get('rental-orders/components')
  @RequirePermission('RENTAL_VIEW')
  orderComponents(@Query() query: RentalOrderComponentsQueryDto) {
    return this.service.orderComponents(query);
  }

  @Post('rental-orders/:orderId/allocations')
  @RequirePermission('RENTAL_ALLOCATE')
  allocate(@Param('orderId') orderId: string, @Body() dto: CreateAllocationDto, @CurrentUser() actor: AuthUser) {
    return this.service.allocate(orderId, dto, actor);
  }

  @Post('rental-allocations/:id/change-item')
  @RequirePermission('RENTAL_ALLOCATE')
  changeItem(@Param('id') id: string, @Body() dto: ChangeItemDto, @CurrentUser() actor: AuthUser) {
    return this.service.changeItem(id, dto, actor);
  }

  @Post('rental-allocations/:id/checkout')
  @RequirePermission('RENTAL_CHECKOUT')
  checkout(@Param('id') id: string, @Body() dto: CheckoutDto, @CurrentUser() actor: AuthUser) {
    return this.service.checkout(id, dto, actor);
  }

  @Post('rental-allocations/:id/return')
  @RequirePermission('RENTAL_RETURN')
  return(@Param('id') id: string, @Body() dto: ReturnDto, @CurrentUser() actor: AuthUser) {
    return this.service.return(id, dto, actor);
  }

  // ---------------------------------------------------------------------------
  // 비고 — 연락·회신·변경 기록 (RENT-004)
  // ---------------------------------------------------------------------------

  @Get('rental-allocations/:id/notes')
  @RequirePermission('RENTAL_VIEW')
  notes(@Param('id') id: string) {
    return this.notesService.list(id);
  }

  /** 회신·변경·메모. 연락 기록은 실제 발송을 거쳐야 하므로 여기서 만들 수 없다. */
  @Post('rental-allocations/:id/notes')
  @RequirePermission('RENTAL_VIEW')
  addNote(@Param('id') id: string, @Body() dto: CreateAllocationNoteDto, @CurrentUser() actor: AuthUser) {
    return this.notesService.create(id, dto, actor);
  }

  /** 발송 확인창에 채울 문구 — 실제 발송은 화면이 POST /notifications/send로 따로 요청한다. */
  @Get('rental-allocations/:id/contact-suggestion')
  @RequirePermission('NOTIFICATION_SEND')
  contactSuggestion(@Param('id') id: string) {
    return this.notesService.contactSuggestion(id);
  }

  /** 발송 결과 봉합 — 이 기록만 연락 횟수에 잡힌다. */
  @Post('rental-allocations/:id/contacts')
  @RequirePermission('NOTIFICATION_SEND')
  addContact(@Param('id') id: string, @Body() dto: CreateAllocationContactDto, @CurrentUser() actor: AuthUser) {
    return this.notesService.createContact(id, dto, actor);
  }
}
