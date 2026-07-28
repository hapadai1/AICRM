import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/decorators';
import {
  CreateCustomerDto,
  CustomerListQueryDto,
  DeactivateCustomerDto,
  UpdateCustomerDto,
} from './customers.dto';
import { CustomersService } from './customers.service';

/** 고객 관리 (화면·API 정의서 13.2 CUST-001/002) */
@Controller()
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get('customers')
  @RequirePermission('CUSTOMER_VIEW')
  list(@Query() query: CustomerListQueryDto) {
    return this.customersService.list(query);
  }

  @Post('customers')
  @RequirePermission('CUSTOMER_EDIT')
  create(@Body() dto: CreateCustomerDto, @CurrentUser() actor: AuthUser) {
    return this.customersService.create(dto, actor);
  }

  @Get('customers/by-phone/:phone')
  @RequirePermission('CUSTOMER_VIEW')
  findByPhone(@Param('phone') phone: string) {
    return this.customersService.findByPhone(phone);
  }

  @Get('customers/:id')
  @RequirePermission('CUSTOMER_VIEW')
  detail(@Param('id') id: string) {
    return this.customersService.detail(id);
  }

  @Patch('customers/:id')
  @RequirePermission('CUSTOMER_EDIT')
  update(@Param('id') id: string, @Body() dto: UpdateCustomerDto, @CurrentUser() actor: AuthUser) {
    return this.customersService.update(id, dto, actor);
  }

  // POST /customers/:id/register 는 제거했다 — 예약 등록이 곧 고객 등록이라
  // 별도 승격 절차가 없어졌다(설계서 07 D2). 고객 정보 수정은 PATCH로 일원화한다.

  @Post('customers/:id/deactivate')
  @RequirePermission('CUSTOMER_DEACTIVATE')
  deactivate(
    @Param('id') id: string,
    @Body() dto: DeactivateCustomerDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.customersService.deactivate(id, dto.reason, actor);
  }
}
